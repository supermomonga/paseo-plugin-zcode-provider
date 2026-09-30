import type { NativePromptInput } from "./session-types.js";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { z } from "zod";

import type {
  ProviderMode,
  ProviderModel,
  ProviderMcpServerConfig,
} from "@getpaseo/plugin/server/provider";
import { AdapterError } from "./errors.js";
import type { ModelOption, ModelSelection } from "./host/schemas.js";

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

export function encodeModel(model: ModelSelection): string {
  return JSON.stringify([model.providerId, model.modelId, null]);
}

export function decodeModel(value: string): ModelSelection {
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
    parsed[2] !== null
  ) {
    throw new AdapterError("INVALID_CONFIGURATION", "Invalid ZCode model ID");
  }
  return {
    providerId: parsed[0],
    modelId: parsed[1],
  };
}

export function catalogModels(
  available: readonly ModelOption[],
  selection?: ModelSelection,
): ProviderModel[] {
  const ids = new Set<string>();
  const current = selection && encodeModel(selection);
  const models = available.map((model) => {
    const id = encodeModel(model.ref);
    if (ids.has(id)) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Duplicate ZCode model ID: ${id}`,
      );
    }
    ids.add(id);
    const levels = model.reasoningLevels;
    const level =
      (id === current ? selection?.options?.reasoningLevel : undefined) ??
      levels?.at(-1);
    if (levels && new Set(levels).size !== levels.length) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "Duplicate ZCode reasoning level",
      );
    }
    return {
      id,
      label: model.ref.modelId,
      ...(model.providerLabel === undefined
        ? {}
        : { description: model.providerLabel }),
      isDefault: id === current,
      ...(levels === undefined
        ? {}
        : {
            thinkingOptions: levels.map((value) => ({
              id: value,
              label: value,
              isDefault: value === level,
            })),
            ...(level === undefined ? {} : { defaultThinkingOptionId: level }),
          }),
    };
  });
  return models;
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
