import type {
  ProviderPermissionAction,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderTimelineItem,
  ProviderToolCallDetail,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import type {
  ConversationRow,
  TimelineMarkerPayload,
} from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";
import type {
  ConversationSnapshot,
  PendingInteraction,
} from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import { AdapterError } from "./errors.js";
import { jsonValue, record, planMarkdown } from "./mapping.js";

export function rowTimeline(
  row: ConversationRow,
  clientMessageId?: string,
): ProviderTimelineItem | undefined {
  const id = `zcode:row:${row.rowId}`;
  switch (row.kind) {
    case "turnHeader":
      return;
    case "userInput":
      return row.origin === "realUser"
        ? {
            id,
            type: "user_message",
            text: [
              row.text,
              ...(row.attachments ?? []).map(
                (a) =>
                  `[Attachment: ${a.fileName} (${a.mime}, ${a.bytes} bytes)]`,
              ),
            ]
              .filter(Boolean)
              .join("\n\n"),
            messageId: row.sourceCommandId ?? row.entityId,
            ...(clientMessageId ? { clientMessageId } : {}),
          }
        : { id, type: "notification", level: "info", message: row.text };
    case "assistantText":
      return {
        id,
        type: "assistant_message",
        text: row.text,
        messageId: row.assistantResponseId ?? row.entityId,
      };
    case "reasoning":
      return { id, type: "reasoning", text: row.text };
    case "toolCall": {
      const input = record(row.input);
      const truncated =
        !!row.output?.truncated ||
        (row.output?.display?.kind === "bash_output" &&
          row.output.display.truncated);
      const text =
        (row.output?.text ?? row.error?.message ?? "") +
        (truncated
          ? "\n[ZCode truncated this output; the full result has not been loaded.]"
          : "");
      let detail: ProviderToolCallDetail;
      if (row.toolName === "Bash" && typeof input.command === "string")
        detail = { type: "shell", command: input.command, output: text };
      else if (row.toolName === "Read" && typeof input.file_path === "string")
        detail = { type: "read", filePath: input.file_path, content: text };
      else if (row.toolName === "Write" && typeof input.file_path === "string")
        detail = {
          type: "write",
          filePath: input.file_path,
          ...(typeof input.content === "string"
            ? { content: input.content }
            : {}),
        };
      else if (row.toolName === "Edit" && typeof input.file_path === "string")
        detail = {
          type: "edit",
          filePath: input.file_path,
          ...(typeof input.old_string === "string"
            ? { oldString: input.old_string }
            : {}),
          ...(typeof input.new_string === "string"
            ? { newString: input.new_string }
            : {}),
        };
      else
        detail = {
          type: "unknown",
          input: jsonValue(row.input ?? row.inputText),
          output: jsonValue({
            text,
            ...(row.output?.display ? { display: row.output.display } : {}),
            truncated,
          }),
        };
      const base = {
        id,
        type: "tool_call" as const,
        callId: row.toolCallId,
        name: row.toolName,
        detail,
        metadata: {
          truncated,
          ...(row.backgrounded ? { backgrounded: true } : {}),
        },
      };
      return row.status === "error"
        ? { ...base, status: "failed", error: jsonValue(row.error ?? text) }
        : {
            ...base,
            status:
              row.status === "success"
                ? "completed"
                : row.status === "cancelled"
                  ? "canceled"
                  : "running",
            error: null,
          };
    }
    case "subagent": {
      const base = {
        id,
        type: "tool_call" as const,
        callId: row.entityId ?? `subagent:${row.rowId}`,
        name: row.subagentType,
        detail: {
          type: "sub_agent" as const,
          subAgentType: row.subagentType,
          log: row.summaryText,
        },
        metadata: {
          backgrounded: row.backgrounded === true,
          ...(row.childSessionId
            ? { zcodeChildSessionId: row.childSessionId }
            : {}),
        },
      };
      return row.status === "failed"
        ? { ...base, status: "failed", error: row.summaryText }
        : {
            ...base,
            status:
              row.status === "success"
                ? "completed"
                : row.status === "cancelled"
                  ? "canceled"
                  : "running",
            error: null,
          };
    }
    case "artifact":
      return {
        id,
        type: "notification",
        level: "info",
        message: `${row.displayName} (${row.artifactType}, ${row.sizeBytes} bytes)`,
      };
    case "hookInvocation":
      return {
        id,
        type: "notification",
        level: "info",
        message: `${row.hookEventName}: ${row.executions.map((h) => `${h.displayName} (${h.outcome ?? h.state})`).join(", ")}`,
      };
    case "timelineMarker":
      return {
        id,
        type: "notification",
        level: "info",
        message: markerText(row.marker),
      };
  }
}
export function usage(state: ConversationSnapshot): ProviderUsage {
  return {
    inputTokens: state.usage.cumulative.inputTokens,
    cachedInputTokens: state.usage.cumulative.cacheReadTokens,
    outputTokens: state.usage.cumulative.outputTokens,
    ...(state.usage.contextWindow
      ? {
          contextWindowUsedTokens: state.usage.contextWindow.usedTokens,
          contextWindowMaxTokens: state.usage.contextWindow.maxTokens,
        }
      : {}),
  };
}
export interface PresentedInteraction {
  request: ProviderPermissionRequest;
  answer(response: ProviderPermissionResponse): Record<string, unknown>;
}
export function presentInteraction(
  interaction: PendingInteraction,
): PresentedInteraction | undefined {
  const p = interaction.payload,
    id = interaction.interactionId;
  if (p.kind === "workspaceHookReview") return;
  if (p.kind === "permission") {
    const options = p.options.filter((o) => o.optionId !== "fullAccess");
    const actions: ProviderPermissionAction[] = options.map((o) => {
      const behavior =
        o.response?.decision ??
        (o.kind === "deny"
          ? "deny"
          : o.kind === "allowOnce" || o.kind === "allowAlways"
            ? "allow"
            : undefined);
      if (behavior !== "allow" && behavior !== "deny")
        throw new AdapterError(
          "INTERACTION_UNSUPPORTED",
          "ZCode permission option cannot be represented",
        );
      return {
        id: o.optionId,
        label: o.label,
        behavior,
        variant: behavior === "allow" ? "primary" : "danger",
      };
    });
    if (!actions.some((a) => a.behavior === "deny"))
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode permission has no deny option",
      );
    const plan = p.toolName === "ExitPlanMode";
    const markdown = plan ? planMarkdown(p.detail) : undefined;
    return {
      request: {
        id,
        name: plan ? "ZCodePlanApproval" : p.toolName,
        kind: plan ? "plan" : "tool",
        title: plan ? "Plan" : p.toolName,
        description: p.summary,
        actions,
        ...(markdown
          ? {
              input: { plan: markdown },
              metadata: { planText: markdown, source: "zcode_plan_approval" },
            }
          : {
              detail: {
                type: "unknown",
                input: jsonValue(p.detail ?? null),
                output: null,
              },
            }),
      },
      answer(response) {
        const action = actions.find((a) => a.id === response.selectedActionId);
        if (!action || action.behavior !== response.behavior)
          throw new AdapterError(
            "INVALID_CONFIGURATION",
            "Permission response does not match an offered action",
          );
        return { optionId: action.id };
      },
    };
  }
  if (p.sensitive)
    throw new AdapterError(
      "INTERACTION_UNSUPPORTED",
      "Sensitive ZCode input must be completed in the official CLI",
    );
  const questions = p.questions;
  if (!questions?.length)
    throw new AdapterError(
      "INTERACTION_UNSUPPORTED",
      "ZCode question has no representable fields",
    );
  const headers = new Set<string>();
  const prompts = new Set<string>();
  for (const q of questions) {
    if (
      headers.has(q.header) ||
      prompts.has(q.question) ||
      new Set(q.options.map((o) => o.label)).size !== q.options.length ||
      new Set(q.options.map((o) => o.value)).size !== q.options.length ||
      q.options.some((o) => q.multiSelect && o.label.includes(", "))
    )
      throw new AdapterError(
        "INTERACTION_UNSUPPORTED",
        "ZCode question has ambiguous labels",
      );
    headers.add(q.header);
    prompts.add(q.question);
  }
  const plan = record(p.schema).interaction === "plan_approval";
  const answerContent = (answers: Record<string, unknown>) => {
    const content: Record<string, unknown> = {},
      nativeAnswers: Record<string, string[]> = {};
    questions.forEach((q, i) => {
      const value = answers[q.header];
      if (typeof value !== "string")
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "A ZCode question answer is missing",
        );
      const labels =
        value === "" ? [] : q.multiSelect ? value.split(", ") : [value];
      if (new Set(labels).size !== labels.length)
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "Duplicate question answer",
        );
      const values = labels.map((label) => {
        const option = q.options.find((o) => o.label === label);
        if (option) return option.value;
        if (p.freeText) return label;
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "Unknown question option",
        );
      });
      nativeAnswers[q.question] = values;
      content[`answer_${i}`] = q.multiSelect ? values : (values[0] ?? "");
      if (i === 0) content.answer = content[`answer_${i}`];
    });
    return { ...content, answers: nativeAnswers };
  };
  if (plan) {
    if (questions.length !== 1 || questions[0]!.multiSelect)
      throw new AdapterError(
        "INTERACTION_UNSUPPORTED",
        "Unsupported ZCode Plan approval fields",
      );
    const question = questions[0]!,
      markdown = planMarkdown(p.input);
    const actions: ProviderPermissionAction[] = [
      ...question.options.map((o) => ({
        id: o.value,
        label: o.label,
        behavior: "allow" as const,
        variant: "primary" as const,
        intent: "implement" as const,
      })),
      {
        id: `dismiss:${id}`,
        label: "Dismiss",
        behavior: "deny",
        intent: "dismiss",
        variant: "danger",
      },
    ];
    return {
      request: {
        id,
        name: "ZCodePlanApproval",
        kind: "plan",
        title: "Plan",
        description: p.prompt,
        input: { plan: markdown },
        metadata: { planText: markdown, source: "zcode_plan_approval" },
        actions,
      },
      answer(response) {
        const action = actions.find((a) => a.id === response.selectedActionId);
        if (!action || action.behavior !== response.behavior)
          throw new AdapterError(
            "INVALID_CONFIGURATION",
            "Plan response does not match an offered action",
          );
        if (action.behavior === "deny") return { action: "decline" };
        return {
          action: "accept",
          content: {
            answer_0: action.id,
            answer: action.id,
            answers: { [question.question]: [action.id] },
          },
        };
      },
    };
  }
  return {
    request: {
      id,
      name: "ZCodeQuestion",
      kind: "question",
      title: p.prompt,
      input: {
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          multiSelect: q.multiSelect === true,
          allowOther: p.freeText,
          allowEmpty: true,
          dismissLabel: "Dismiss",
        })),
      },
    },
    answer(response) {
      return response.behavior === "deny"
        ? { action: response.interrupt ? "cancel" : "decline" }
        : {
            action: "accept",
            content: answerContent(record(response.updatedInput?.answers)),
          };
    },
  };
}

function markerText(marker: TimelineMarkerPayload): string {
  switch (marker.type) {
    case "compact":
      return `Context compaction: ${marker.status}`;
    case "modelChange":
      return `Model: ${marker.toModel} (${marker.toThought})`;
    case "forkNotice":
      return "Conversation continued from a parent conversation.";
    case "forkCreated":
      return "ZCode created a child conversation.";
    case "goalSet":
      return `Goal: ${marker.objective}`;
    case "goalVerify":
      return `Goal verification: ${marker.outcome}${marker.detail ? ` — ${marker.detail}` : ""}`;
    case "retryNotice":
      return `ZCode is retrying the model request (attempt ${marker.attempt}).`;
    case "checkpointRestored":
      return "ZCode restored a file checkpoint.";
  }
}
