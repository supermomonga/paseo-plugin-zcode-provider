import { AdapterError } from "../server/errors.js";
import type { z } from "zod";
import type { HostBridge, HostSubscription } from "../server/host/bridge.js";
import type {
  DynamicEvent,
  SessionSnapshot,
} from "../server/protocol/v1/host-schemas.js";
export function snapshot(workspace: string): SessionSnapshot {
  return {
    session: {
      sessionId: "session-1",
      status: "idle",
      workspace: { workspacePath: workspace },
      title: "Session",
      updatedAt: 1,
    },
    settings: {
      model: {
        current: { providerId: "provider", modelId: "model" },
        available: [
          {
            ref: { providerId: "provider", modelId: "model" },
            label: "Model",
            providerLabel: "Provider",
          },
        ],
      },
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [{ value: "high", label: "High" }],
      },
      mode: { current: "plan" },
    },
    messages: [],
    runtime: {},
    todos: [],
    slashCommands: [
      { name: "plan", description: "Switch to Plan mode", inputHint: "[task]" },
      { name: "review", description: "Review", inputHint: "<path>" },
    ],
  };
}

export class FakeBridge implements HostBridge {
  conversationRevision = 0;
  conversationOrdinal = 0;
  conversationPhase:
    | "draft"
    | "running"
    | "completedSuccess"
    | "completedInterrupted"
    | "error" = "draft";
  autoDrain = true;
  confirmCancellation = true;
  queueItems: Array<{
    sourceCommandId: string;
    queueItemId: string;
    clientId: string;
    delivery: { requested: "guide" | "queue"; admitted: "queue" | "guide" };
    dispatch: { state: "queued" };
  }> = [];
  async emitConversation(): Promise<void> {
    const n = ++this.conversationOrdinal;
    await this.emit({
      type: "conversation.frame",
      frame: {
        wireVersion: 3,
        kind: "complete",
        deliveryKind: "online",
        logicalFrameId: `frame-${n}`,
        logicalFrameOrdinal: n,
        topic: "conversation/session-1",
        subscriptionId: "conversation-sub",
        frame: {
          topic: "conversation/session-1",
          subscriptionId: "conversation-sub",
          fromSeq: 0,
          toSeq: n,
          sentAt: n,
          payload: {
            kind: "snapshot",
            snapshot: {
              sessionId: "session-1",
              logEpoch: "epoch",
              seq: n,
              revision: ++this.conversationRevision,
              control: {
                phase: this.conversationPhase,
                canStop: this.conversationPhase === "running",
              },
              queue: { autoDrain: this.autoDrain, items: this.queueItems },
            },
          },
        },
      },
    });
  }
  readonly diagnostic = {
    appVersion: "3.11.2",
    cliVersion: "0.16.5",
    platform: "darwin-arm64",
  };
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private handler: ((event: DynamicEvent) => Promise<void> | void) | undefined;

  constructor(public current: SessionSnapshot) {}

  emitModeOnSet = false;
  collapseModelsOnSetMode = false;

  async request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
  ): Promise<z.output<Schema>> {
    this.calls.push({ method, params });
    let result: unknown = null;
    if (method === "initialize") {
      result = { available: true };
    } else if (method === "readWorkspaceState") {
      result = {
        workspace: this.current.session.workspace,
        settings: this.current.settings,
        modelCatalog: { providers: [{}], available: [] },
      };
    } else if (
      method === "createSession" ||
      method === "resumeSession" ||
      method === "readSession"
    ) {
      result = this.current;
    } else if (method === "listSessions") {
      result = [this.current.session];
    } else if (method === "sendConversationCommandV4") {
      const { envelope: e } = params as {
        envelope: {
          type: string;
          commandId: string;
          payload: {
            autoDrain?: boolean;
            queueItemId?: string;
            requestedDelivery?: "queue" | "guide";
          };
        };
      };
      if (e.type === "sendText") {
        const running = this.conversationPhase === "running";
        if (running)
          this.queueItems.push({
            sourceCommandId: e.commandId,
            queueItemId: `queue-${e.commandId}`,
            clientId: "paseo-zcode-provider",
            delivery: {
              requested: e.payload.requestedDelivery!,
              admitted: e.payload.requestedDelivery!,
            },
            dispatch: { state: "queued" },
          });
        this.conversationPhase = "running";
        await this.emitConversation();
        result = {
          commandId: e.commandId,
          status: "accepted",
          revisionAtDecision: this.conversationRevision,
          result: {
            type: "inputAccepted",
            inputId: e.commandId,
            delivery: running ? "queue" : "startNow",
          },
        };
      } else {
        if (e.type === "setAutoDrain") this.autoDrain = e.payload.autoDrain!;
        else if (e.type === "deleteQueueItem")
          this.queueItems = this.queueItems.filter(
            (item) => item.queueItemId !== e.payload.queueItemId,
          );
        else throw new Error(`Unexpected command ${e.type}`);
        await this.emitConversation();
        result = {
          commandId: e.commandId,
          status: "accepted",
          revisionAtDecision: this.conversationRevision,
        };
      }
    } else if (method === "attachmentBeginV4") {
      result = {
        uploadId: (params as { uploadId: string }).uploadId,
        state: "staging",
        nextChunkIndex: 0,
      };
    } else if (method === "attachmentChunkV4") {
      const chunk = params as { uploadId: string; chunkIndex: number };
      result = {
        uploadId: chunk.uploadId,
        nextChunkIndex: chunk.chunkIndex + 1,
      };
    } else if (method === "attachmentCommitV4") {
      result = {
        ref: `artifact://${(params as { uploadId: string }).uploadId}`,
      };
    } else if (method === "attachmentAbortV4") {
      result = {};
    } else if (method === "cancelGeneration" && this.confirmCancellation) {
      this.conversationPhase = "completedInterrupted";
      await this.emitConversation();
    } else if (method === "getTaskTokenUsage") {
      result = {
        sessionId: "session-1",
        totalTokens: 12,
        inputTokens: 5,
        outputTokens: 7,
        reasoningTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 1,
      };
    } else if (method === "setMode") {
      const value = params as { mode: string };
      this.current = {
        ...this.current,
        settings: {
          ...this.current.settings,
          mode: { current: value.mode },
        },
      };
      if (this.collapseModelsOnSetMode) {
        this.current.settings.model.available =
          this.current.settings.model.available.filter(
            (entry) =>
              entry.ref.modelId === this.current.settings.model.current.modelId,
          );
      }
      result = this.current;
      if (this.emitModeOnSet) {
        await this.emit(stateUpdate({ mode: { current: value.mode } }));
      }
    } else if (method === "setModel") {
      this.current.settings.model.current = (
        params as {
          model: SessionSnapshot["settings"]["model"]["current"];
        }
      ).model;
      result = this.current;
    } else if (method === "setThoughtLevel") {
      this.current.settings.thoughtLevel.current = (
        params as { thoughtLevel: string }
      ).thoughtLevel;
      result = this.current;
    }
    return resultSchema.parse(structuredClone(result));
  }

  async subscribe(
    _target: {
      workspacePath: string;
      sessionId: string;
      deliveryKind: "desktop-continuous";
      includeSnapshot: boolean;
    },
    handler: (event: DynamicEvent) => Promise<void> | void,
  ): Promise<HostSubscription> {
    this.calls.push({ method: "subscribe", params: null });
    this.handler = handler;
    await this.emitConversation();
    return {
      dispose: async () => {
        this.calls.push({ method: "unsubscribe", params: null });
        this.handler = undefined;
      },
    };
  }

  closed = false;
  failures = new Set<(error: AdapterError) => void>();
  onFailure(listener: (error: AdapterError) => void) {
    this.failures.add(listener);
    return () => {
      this.failures.delete(listener);
    };
  }
  fail(error = new AdapterError("NATIVE_EXITED", "ZCode host disconnected")) {
    for (const listener of this.failures) listener(error);
  }
  async close(): Promise<void> {
    this.closed = true;
  }

  async emit(event: DynamicEvent): Promise<void> {
    if (
      event.type === "session.event" &&
      event.event.type === "session.updated" &&
      typeof event.event.payload.mode === "string"
    ) {
      this.current = {
        ...this.current,
        settings: {
          ...this.current.settings,
          mode: { current: event.event.payload.mode },
        },
      };
    }
    if (this.handler === undefined) throw new Error("not subscribed");
    await this.handler(event);
    if (
      event.type === "session.event" &&
      event.event.type === "turn.completed"
    ) {
      this.conversationPhase =
        event.event.payload.resultType === "cancelled"
          ? "completedInterrupted"
          : "completedSuccess";
      await this.emitConversation();
    }
  }
}

export function stateUpdate(patch: unknown): DynamicEvent {
  return {
    type: "state.updated",
    notification: {
      type: "state.updated",
      scope: "session",
      sessionId: "session-1",
      revision: 1,
      patch,
    },
  };
}

export function modeEvent(
  mode: string,
  previousMode: string,
  seq: number,
): DynamicEvent {
  return {
    type: "session.event",
    event: {
      type: "session.updated",
      eventId: `mode-${seq}`,
      sessionId: "session-1",
      seq,
      timestamp: seq,
      deliveryKind: "desktop-continuous",
      payload: {
        mode,
        previousMode,
        source: "tool",
        toolCallId: "exit-plan",
      },
    },
  };
}

export async function completeTurn(bridge: FakeBridge, seq = 1): Promise<void> {
  await bridge.emit({
    type: "session.event",
    event: {
      eventId: `mode-test-completed-${seq}`,
      sessionId: "session-1",
      seq,
      timestamp: 2,
      deliveryKind: "desktop-continuous",
      type: "turn.completed",
      payload: { resultType: "success" },
    },
  });
}

export async function requestPlan(
  bridge: FakeBridge,
  source: "permission" | "question",
) {
  if (source === "permission") {
    await bridge.emit({
      type: "permission.request",
      request: {
        requestId: "mode-plan",
        sessionId: "session-1",
        toolCallId: "exit-plan",
        toolName: "ExitPlanMode",
        reason: "Review plan",
        riskLevel: "medium",
        input: { plan: "# Plan" },
        options: [
          {
            optionId: "approve",
            kind: "allow_once",
            name: "Approve",
            response: { decision: "allow" },
          },
          {
            optionId: "dismiss",
            kind: "deny_once",
            name: "Dismiss",
            response: { decision: "deny" },
          },
        ],
      },
    });
  } else {
    await bridge.emit({
      type: "userInput.request",
      request: {
        requestId: "mode-plan",
        sessionId: "session-1",
        input: { plan: "# Plan" },
        schema: { interaction: "plan_approval" },
        questions: [
          {
            question: "Review plan",
            header: "Plan",
            options: [{ value: "approve", label: "Approve" }],
          },
        ],
      },
    });
  }
}
