import type { NativePromptInput, NativeTimelineItem } from "./session-types.js";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { z } from "zod";

import type {
  ProviderMode,
  ProviderModel,
  ProviderPermissionAction,
  ProviderPermissionRequest,
  ProviderThinkingOption,
  ProviderMcpServerConfig,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { AdapterError } from "./errors.js";
import type {
  PermissionRequest,
  SessionSettings,
  SessionSnapshot,
  UserInputRequest,
} from "./protocol/v1/host-schemas.js";

export const ZCODE_PROVIDER_ID = "zcode";
export const ZCODE_MODES: ProviderMode[] = [
  {
    id: "build",
    label: "Ask Before Changes",
    description: "Ask before changing files or running tools",
  },
  {
    id: "edit",
    label: "Edit Automatically",
    description: "Edit files automatically while keeping other approvals",
  },
  {
    id: "yolo",
    label: "Full Access",
    description: "Run tools without approval",
  },
];

export function requireMode(mode: string): string {
  if (
    mode !== "plan" &&
    !ZCODE_MODES.some((candidate) => candidate.id === mode)
  ) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `ZCode returned an unknown mode: ${mode}`,
    );
  }
  return mode;
}

interface ModelRef {
  providerId: string;
  modelId: string;
  variant?: string | null;
}

export function encodeModel(model: ModelRef): string {
  return JSON.stringify([
    model.providerId,
    model.modelId,
    model.variant ?? null,
  ]);
}

export function decodeModel(value: string): ModelRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AdapterError("INVALID_CONFIGURATION", "Invalid ZCode model ID");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    parsed[0].length === 0 ||
    typeof parsed[1] !== "string" ||
    parsed[1].length === 0 ||
    (parsed[2] !== null && typeof parsed[2] !== "string")
  ) {
    throw new AdapterError("INVALID_CONFIGURATION", "Invalid ZCode model ID");
  }
  return {
    providerId: parsed[0],
    modelId: parsed[1],
    ...(parsed[2] === null ? {} : { variant: parsed[2] }),
  };
}

export function catalogModels(settings: SessionSettings): ProviderModel[] {
  const ids = new Set<string>();
  const current = encodeModel(settings.model.current);
  const thinking = catalogThinkingOptions(settings);
  const models = settings.model.available.map((model) => {
    const id = encodeModel(model.ref);
    if (ids.has(id)) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Duplicate ZCode model ID: ${id}`,
      );
    }
    ids.add(id);
    return {
      id,
      label: model.ref.modelId,
      ...(model.providerLabel === undefined
        ? {}
        : { description: model.providerLabel }),
      isDefault: id === current,
      ...(thinking === undefined
        ? {}
        : {
            thinkingOptions: thinking.options,
            defaultThinkingOptionId: thinking.defaultOptionId,
          }),
    };
  });
  if (!ids.has(current)) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "The current ZCode model is absent from the available model list",
    );
  }
  requireMode(settings.mode.current);
  return models;
}

function catalogThinkingOptions(
  settings: SessionSettings,
): { options: ProviderThinkingOption[]; defaultOptionId: string } | undefined {
  const thoughtLevel = settings.thoughtLevel;
  if (!thoughtLevel.enabled || thoughtLevel.available.length === 0) {
    return undefined;
  }
  const defaultOptionId = thoughtLevel.current ?? thoughtLevel.defaultLevel;
  if (
    defaultOptionId === undefined ||
    !thoughtLevel.available.some((option) => option.value === defaultOptionId)
  ) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode returned an invalid default thinking option",
    );
  }
  return {
    defaultOptionId,
    options: thoughtLevel.available.map((option) => ({
      id: option.value,
      label: option.label,
      isDefault: option.value === defaultOptionId,
    })),
  };
}

export function mapMcpServers(
  servers: Record<string, ProviderMcpServerConfig> | undefined,
): Array<Record<string, unknown>> {
  return Object.entries(servers ?? {}).map(([name, server]) => {
    if (name.trim() === "") {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "MCP server name must not be empty",
      );
    }
    if (server.alwaysLoad !== undefined) {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        `MCP server '${name}' uses unsupported alwaysLoad`,
      );
    }
    if (server.type === "stdio") {
      if (!isAbsolute(server.command)) {
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          `MCP server '${name}' command must be absolute`,
        );
      }
      return {
        name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([key, value]) => ({
          name: key,
          value,
        })),
      };
    }
    const headers = Object.entries(server.headers ?? {}).map(
      ([key, value]) => ({
        name: key,
        value,
      }),
    );
    if (server.type === "http" || server.type === "sse") {
      return { type: server.type, name, url: server.url, headers };
    }
    throw new AdapterError(
      "INVALID_CONFIGURATION",
      "Unsupported MCP server type",
    );
  });
}

export interface NativePrompt {
  content: string;
  attachments: Array<{
    kind: "image" | "audio" | "file";
    filename: string;
    mimeType: string;
    dataBase64?: string;
    localPath?: string;
    sizeBytes?: number;
  }>;
}

export async function mapPrompt(
  prompt: NativePromptInput,
  workspace: string,
): Promise<NativePrompt> {
  if (typeof prompt === "string") return { content: prompt, attachments: [] };
  const canonicalWorkspace = await realpath(workspace);
  const content: string[] = [];
  const attachments: NativePrompt["attachments"] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      content.push(block.text);
      continue;
    }
    if (block.type === "image") {
      attachments.push({
        kind: "image",
        filename: `image.${block.mimeType.split("/")[1]?.split("+")[0] ?? "bin"}`,
        mimeType: block.mimeType,
        dataBase64: block.data,
        sizeBytes: Buffer.from(block.data, "base64").byteLength,
      });
      continue;
    }
    if (block.type === "uploaded_file") {
      if (!isAbsolute(block.path)) {
        throw new AdapterError(
          "UNSUPPORTED_CONTENT",
          "Attachment path must be absolute",
        );
      }
      const resolved = await realpath(block.path);
      const child = relative(canonicalWorkspace, resolved);
      if (child.startsWith("..") || isAbsolute(child)) {
        throw new AdapterError(
          "UNSUPPORTED_CONTENT",
          "Attachment path must remain inside the workspace",
        );
      }
      const info = await stat(resolved);
      if (!info.isFile()) {
        throw new AdapterError(
          "UNSUPPORTED_CONTENT",
          "Attachment must be a regular file",
        );
      }
      attachments.push({
        kind: block.mimeType.startsWith("image/")
          ? "image"
          : block.mimeType.startsWith("audio/")
            ? "audio"
            : "file",
        filename: block.fileName || basename(resolved),
        mimeType: block.mimeType,
        localPath: resolved,
        sizeBytes: info.size,
      });
      continue;
    }
    throw new AdapterError(
      "UNSUPPORTED_CONTENT",
      `Unsupported Paseo attachment type: ${block.type}`,
    );
  }
  return { content: content.join("\n\n"), attachments };
}

export function historyTimeline(
  snapshot: SessionSnapshot,
): NativeTimelineItem[] {
  const result: NativeTimelineItem[] = [];
  for (const message of snapshot.messages) {
    let userMessage:
      | Extract<NativeTimelineItem, { type: "user_message" }>
      | undefined;
    const append = (item: NativeTimelineItem) => {
      if (item.type === "user_message") {
        if (userMessage) {
          userMessage.text += `\n\n${item.text}`;
          return;
        }
        userMessage = item;
      }
      result.push(item);
    };
    for (const part of message.parts) {
      if (
        part.type === "timeline" ||
        part.type === "step-start" ||
        part.type === "step-finish"
      ) {
        continue;
      }
      if (part.type === "text" || part.type === "reasoning") {
        if (typeof part.text !== "string") {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "Persisted text part is malformed",
          );
        }
        append(
          part.type === "reasoning"
            ? { type: "reasoning", text: part.text }
            : message.info.role === "user"
              ? {
                  type: "user_message",
                  text: part.text,
                  messageId: message.info.messageId,
                }
              : {
                  type: "assistant_message",
                  text: part.text,
                  messageId: message.info.messageId,
                },
        );
        continue;
      }
      if (part.type === "file") {
        if (typeof part.url !== "string") {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "Persisted file part is malformed",
          );
        }
        const label =
          typeof part.filename === "string" ? part.filename : "file";
        const text = `[${label}](${part.url})`;
        append(
          message.info.role === "user"
            ? { type: "user_message", text, messageId: message.info.messageId }
            : {
                type: "assistant_message",
                text,
                messageId: message.info.messageId,
              },
        );
        continue;
      }
      if (part.type === "tool") {
        const callId =
          typeof part.callId === "string" ? part.callId : undefined;
        const name = typeof part.tool === "string" ? part.tool : undefined;
        const state = record(part.state);
        if (callId === undefined || name === undefined) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "Persisted tool part is malformed",
          );
        }
        const status =
          state.status === "completed"
            ? "completed"
            : state.status === "error"
              ? "failed"
              : state.status === "running" || state.status === "pending"
                ? "running"
                : undefined;
        if (status === undefined) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "Persisted tool status is unknown",
          );
        }
        const output = jsonValue(state.output ?? state.error ?? null);
        const detail: ProviderToolCallDetail = {
          type: "unknown",
          input: jsonValue(state.input ?? null),
          output,
        };
        append(
          status === "failed"
            ? { type: "tool_call", callId, name, detail, status, error: output }
            : { type: "tool_call", callId, name, detail, status, error: null },
        );
        continue;
      }
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported persisted message part: ${part.type}`,
      );
    }
  }
  if (snapshot.todos !== undefined) {
    result.push({
      type: "todo",
      items: snapshot.todos.map((todo) =>
        Object.assign(
          {
            text: todo.content,
            completed: todo.status === "completed",
            status: todo.status,
          },
          { priority: todo.priority },
        ),
      ),
    });
  }
  return result;
}

export interface QuestionField {
  header: string;
  question: string;
  multiSelect: boolean;
  valuesByLabel: Map<string, string>;
}

export function mapQuestionRequest(
  request: UserInputRequest,
  id: string,
): { request: ProviderPermissionRequest; fields: QuestionField[] } {
  if (request.questions === undefined || request.questions.length === 0) {
    throw new AdapterError(
      "INTERACTION_UNSUPPORTED",
      "ZCode question has no fields",
    );
  }
  const headers = new Set<string>();
  const fields: QuestionField[] = request.questions.map((question) => {
    if (headers.has(question.header)) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode question headers must be unique",
      );
    }
    headers.add(question.header);
    const valuesByLabel = new Map<string, string>();
    const values = new Set<string>();
    for (const option of question.options) {
      if (
        option.label.trim() === "" ||
        option.value === "" ||
        valuesByLabel.has(option.label) ||
        values.has(option.value) ||
        (question.multiSelect === true && option.label.includes(", "))
      ) {
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode question options are not reversibly representable",
        );
      }
      valuesByLabel.set(option.label, option.value);
      values.add(option.value);
    }
    if (valuesByLabel.size === 0) {
      throw new AdapterError(
        "INTERACTION_UNSUPPORTED",
        "ZCode free-form question is unsupported by this native contract",
      );
    }
    return {
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect === true,
      valuesByLabel,
    };
  });
  return {
    fields,
    request: {
      id,
      name: "ZCodeQuestion",
      kind: "question",
      title: request.prompt ?? "Question",
      input: {
        questions: request.questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined
              ? {}
              : { description: option.description }),
          })),
          multiSelect: question.multiSelect === true,
          allowOther: false,
          allowEmpty: false,
          dismissLabel: "Dismiss",
        })),
      },
    },
  };
}

export function questionContent(
  fields: QuestionField[],
  answers: unknown,
): Record<string, unknown> {
  const answerRecord = record(answers);
  const content: Record<string, unknown> = {};
  const nativeAnswers: Record<string, string[]> = {};
  fields.forEach((field, index) => {
    const answer = answerRecord[field.header];
    if (typeof answer !== "string" || answer === "") {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Missing answer for ZCode question '${field.header}'`,
      );
    }
    const labels = field.multiSelect ? answer.split(", ") : [answer];
    if (
      labels.length === 0 ||
      new Set(labels).size !== labels.length ||
      labels.some((label) => label === "")
    ) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode answer is ambiguous",
      );
    }
    const values = labels.map((label) => {
      const value = field.valuesByLabel.get(label);
      if (value === undefined) {
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode answer contains an unknown option",
        );
      }
      return value;
    });
    content[`answer_${index}`] = field.multiSelect ? values : values[0];
    nativeAnswers[field.question] = values;
    if (index === 0) content.answer = field.multiSelect ? values : values[0];
  });
  content.answers = nativeAnswers;
  return content;
}

export function permissionActions(
  request: PermissionRequest,
  requireBoth = false,
): ProviderPermissionAction[] {
  let allow = false;
  let deny = false;
  const actions = request.options.map((option) => {
    if (
      option.response.decision !== "allow" &&
      option.response.decision !== "deny"
    ) {
      throw new AdapterError(
        "INTERACTION_UNSUPPORTED",
        `ZCode permission decision is unsupported: ${option.response.decision}`,
      );
    }
    allow ||= option.response.decision === "allow";
    deny ||= option.response.decision === "deny";
    return {
      id: option.optionId,
      label: option.name,
      behavior: option.response.decision,
      variant: option.response.decision === "deny" ? "danger" : "primary",
      ...(option.response.decision === "deny"
        ? { intent: "dismiss" as const }
        : {}),
    } satisfies ProviderPermissionAction;
  });
  if (!deny || (requireBoth && !allow)) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      requireBoth
        ? "ZCode plan approval must provide allow and deny options"
        : "ZCode permission must provide a deny option",
    );
  }
  return actions;
}

export function planMarkdown(input: unknown): string {
  const plan = record(input).plan;
  if (typeof plan !== "string" || plan.trim() === "") {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode plan approval has no Markdown",
    );
  }
  return plan.trim();
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonValue(value: unknown) {
  return z.json().parse(value);
}
export function jsonObject(value: unknown) {
  return z.record(z.string(), z.json()).parse(value);
}
