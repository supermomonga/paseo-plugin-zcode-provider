import { uploadAttachments } from "./attachments.js";
import { randomUUID } from "node:crypto";
import { Conversation, conversationCommand } from "./conversation.js";
import { z } from "zod";
import { diagnosticError, formatDiagnostic } from "./diagnostics.js";
import { jsonValue, jsonObject } from "./mapping.js";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  ProviderPermissionAction,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderSessionConfig,
  ProviderCommand,
  ProviderUsage,
  ProviderToolCallDetail,
  ProviderConfigState,
} from "@getpaseo/plugin/server/provider";
import type {
  NativeTimelineItem,
  NativeSessionEvent,
  NativePromptInput,
} from "./session-types.js";
import { AdapterError } from "./errors.js";
import type { HostBridge, HostSubscription } from "./host/bridge.js";
import type { Logger } from "./logger.js";
import {
  catalogModels,
  decodeModel,
  encodeModel,
  historyTimeline,
  mapPrompt,
  mapQuestionRequest,
  permissionActions,
  planMarkdown,
  questionContent,
  record,
  requireMode,
  ZCODE_MODES,
  type QuestionField,
} from "./mapping.js";
import {
  InitializeResultSchema,
  SessionSettingsSchema,
  SessionModePatchSchema,
  SessionModeChangedSchema,
  SessionSnapshotSchema,
  StateUpdatedNotificationSchema,
  TokenUsageSchema,
  UnknownResultSchema,
  WorkspaceStateResultSchema,
  type DynamicEvent,
  type PermissionRequest,
  type SessionEvent,
  type SessionSettings,
  type SessionSnapshot,
  type UserInputRequest,
} from "./protocol/v1/host-schemas.js";

const KNOWN_NOOP_EVENTS = new Set([
  "streamRecovery.updated",
  "permission.requested",
  "permission.resolved",
  "checkpoint.created",
]);

interface ActiveTurn {
  id: string;
  inputId: string;
  nativeTurnId?: string;
  inputs: Map<
    string,
    {
      clientMessageId?: string;
      accepted: boolean;
      consumed: boolean;
      queueItemId?: string;
      nativeTurnId?: string;
    }
  >;
  completedNativeTurns: Set<string>;
  inFlight: number;
  announced: boolean;
  buffered: NativeSessionEvent[];
  lastTerminal?: Record<string, unknown>;
  finishing: boolean;
  completionRevision: number;
  stopping?: Promise<void>;
  tools: Map<
    string,
    {
      name: string;
      input: unknown;
      output: unknown;
      status: "running" | "completed" | "failed";
    }
  >;
  cancelled: boolean;
  cancelSent: boolean;
  settled: boolean;
  usage?: ProviderUsage;
  completion: Promise<void>;
  resolve: (result: void) => void;
  reject: (error: unknown) => void;
}

interface PendingBase {
  request: ProviderPermissionRequest;
  nativeRequestId: string;
  turnId?: string;
  resolved: boolean;
}

interface PendingPermission extends PendingBase {
  source: "permission";
  actions: Map<string, { behavior: "allow" | "deny"; optionId: string }>;
}

interface PendingQuestion extends PendingBase {
  source: "question";
  fields: QuestionField[];
}

interface PendingPlanQuestion extends PendingBase {
  source: "plan-question";
  question: string;
  actions: Map<string, { behavior: "allow" | "deny"; value?: string }>;
}

type PendingInteraction =
  | PendingPermission
  | PendingQuestion
  | PendingPlanQuestion;

export class ZCodeSession {
  readonly id: string;
  private readonly listeners = new Set<(event: NativeSessionEvent) => void>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly history: NativeTimelineItem[];
  private subscription!: HostSubscription;
  private snapshot: SessionSnapshot;
  private active: ActiveTurn | undefined;
  private pendingAdmissions = 0;
  private readonly cancelledNativeTurns = new Set<string>();
  private lastSequence: number | undefined;
  private closed = false;
  private failed = false;
  private contextUsage: ProviderUsage | undefined;
  private snapshotRead: Promise<void> | undefined;
  private snapshotRevision = 0;
  private editingMode: string;
  private configuringMode = false;
  private readonly conversation: Conversation;

  private constructor(
    private readonly bridge: HostBridge,
    private readonly logger: Logger,
    private readonly workspace: string,
    snapshot: SessionSnapshot,
    private readonly onClose: () => void,
  ) {
    assertSnapshotWorkspace(snapshot, workspace);
    requireMode(snapshot.settings.mode.current);
    this.snapshot = snapshot;
    this.editingMode =
      snapshot.settings.mode.current === "plan"
        ? "build"
        : snapshot.settings.mode.current;
    this.contextUsage = this.readContextUsage(snapshot);
    this.id = snapshot.session.sessionId;
    this.conversation = new Conversation(this.id);
    this.history = historyTimeline(snapshot);
  }

  static async create(options: {
    bridge: HostBridge;
    logger: Logger;
    workspace: string;
    snapshot: SessionSnapshot;
    onClose: () => void;
  }): Promise<ZCodeSession> {
    const session = new ZCodeSession(
      options.bridge,
      options.logger,
      options.workspace,
      options.snapshot,
      options.onClose,
    );
    session.subscription = await options.bridge.subscribe(
      {
        workspacePath: options.workspace,
        sessionId: session.id,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
      },
      (event) => session.handleDynamicEvent(event),
    );
    await session.waitForState(() => session.conversation.state !== undefined);
    session.assertOpen();
    // Native resume discards persisted, unconsumed inputs. Do not recreate or
    // replay them locally, or attach to work not started by this connection.
    if (!session.conversation.idle)
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode restored a conversation with unresolved native work",
      );
    return session;
  }

  async applyInitialConfig(
    config: Partial<ProviderSessionConfig>,
  ): Promise<void> {
    if (config.model !== undefined) await this.setModel(config.model);
    if (config.thinkingOption !== undefined) {
      await this.setThinkingOption(config.thinkingOption);
    }
    await this.configureMode(
      config.mode,
      config.settings?.plan_mode as boolean | undefined,
    );
  }

  async startTurn(
    prompt: NativePromptInput,
    options?: {
      clientMessageId: string;
      delivery?: "auto" | "steer";
      beforeSend?: () => Promise<void>;
    },
  ): Promise<{ turnId: string }> {
    const turn = await this.beginTurn(prompt, options);
    void turn.completion.catch(() => undefined);
    return { turnId: turn.id };
  }

  reserveInput(): () => void {
    this.pendingAdmissions++;
    if (this.active) {
      this.active.finishing = false;
      this.active.completionRevision++;
    }
    return () => {
      this.pendingAdmissions--;
      if (this.active) void this.maybeComplete(this.active);
    };
  }

  hasActiveTurn(): boolean {
    return this.active !== undefined;
  }

  subscribe(callback: (event: NativeSessionEvent) => void): () => void {
    this.listeners.add(callback);
    if (this.contextUsage)
      callback({ type: "usage_updated", usage: this.contextUsage });
    return () => this.listeners.delete(callback);
  }

  getConfig(): ProviderConfigState {
    const models = catalogModels(this.snapshot.settings);
    const model = encodeModel(this.snapshot.settings.model.current);
    const selected = models.find((entry) => entry.id === model)!;
    return {
      model,
      mode: this.editingMode,
      thinkingOption:
        this.snapshot.settings.thoughtLevel.current ??
        selected.defaultThinkingOptionId,
      models,
      modes: ZCODE_MODES,
      thinkingOptions: selected.thinkingOptions ?? [],
      settings: [
        {
          type: "toggle",
          id: "plan_mode",
          label: "Toggle plan mode",
          value: this.snapshot.settings.mode.current === "plan",
        },
      ],
    };
  }

  historyItems(): readonly NativeTimelineItem[] {
    return this.history;
  }

  runtimeFailed(error?: AdapterError): void {
    if (this.failed) return;
    const failure = diagnosticError(
      error ?? new AdapterError("NATIVE_EXITED", "ZCode host disconnected"),
      { ...this.bridge.diagnostic, stage: "session" },
    );
    if (error !== undefined) this.logger.error("zcode.session.failed", failure);
    error = failure;
    this.failed = true;
    this.stateChanged();
    this.failActive(error, false);
    this.emit({
      type: "runtime_failed",
      error: error.message,
      code: error.code,
      diagnostic: formatDiagnostic(error),
    });
  }

  async configureMode(mode?: string | null, plan?: boolean): Promise<void> {
    this.assertIdle();
    if (
      mode === null ||
      (mode !== undefined && !ZCODE_MODES.some((item) => item.id === mode))
    )
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode editing mode must be build, edit, or yolo",
      );
    const nextMode = mode ?? this.editingMode;
    const nextPlan = plan ?? this.snapshot.settings.mode.current === "plan";
    this.configuringMode = true;
    try {
      // Enter from the selected editing mode so native ExitPlanMode returns to it.
      if (nextPlan) {
        await this.setMode(nextMode);
        await this.setMode("plan");
      } else if (this.snapshot.settings.mode.current !== nextMode) {
        await this.setMode(nextMode);
      }
      this.editingMode = nextMode;
    } catch (error) {
      // A partial native transition must not leave a usable, misleading UI state.
      this.runtimeFailed(error instanceof AdapterError ? error : undefined);
      throw error;
    } finally {
      this.configuringMode = false;
    }
    this.emit({ type: "config_changed" });
  }

  async setMode(modeId: string): Promise<void> {
    this.assertIdle();
    requireMode(modeId);
    const snapshot = await this.bridge.request(
      "setMode",
      {
        workspacePath: this.workspace,
        sessionId: this.id,
        mode: modeId,
      },
      SessionSnapshotSchema,
      60_000,
    );
    this.updateSnapshot(snapshot);
    if (snapshot.settings.mode.current !== modeId) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode did not apply the requested mode",
      );
    }
  }

  getPendingPermissions(): ProviderPermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  async respondToPermission(
    requestId: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.resolved) {
      throw new AdapterError(
        "SESSION_NOT_FOUND",
        `Unknown ZCode interaction: ${requestId}`,
      );
    }
    pending.resolved = true;
    this.pending.delete(requestId);
    let nativeResponseAttempted = false;
    try {
      if (pending.source === "permission") {
        if (response.selectedActionId === undefined) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode permission response requires selectedActionId",
          );
        }
        const action = pending.actions.get(response.selectedActionId);
        if (action === undefined || action.behavior !== response.behavior) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode permission response does not match the published action",
          );
        }
        nativeResponseAttempted = true;
        await this.respondPermission(pending.nativeRequestId, action.optionId);
      } else if (pending.source === "question") {
        const nativeResponse =
          response.behavior === "deny"
            ? { action: response.interrupt ? "cancel" : "decline" }
            : {
                action: "accept",
                content: questionContent(
                  pending.fields,
                  response.updatedInput?.answers,
                ),
              };
        nativeResponseAttempted = true;
        await this.respondStructuredInput(
          pending.nativeRequestId,
          nativeResponse,
        );
      } else {
        const selected =
          response.selectedActionId === undefined
            ? undefined
            : pending.actions.get(response.selectedActionId);
        if (selected === undefined || selected.behavior !== response.behavior) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode plan response does not match the published action",
          );
        }
        if (selected.behavior === "deny") {
          nativeResponseAttempted = true;
          await this.respondStructuredInput(pending.nativeRequestId, {
            action: "decline",
          });
        } else {
          const value = selected.value;
          if (value === undefined) {
            throw new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "ZCode plan action lost its value",
            );
          }
          nativeResponseAttempted = true;
          await this.respondStructuredInput(pending.nativeRequestId, {
            action: "accept",
            content: {
              answer_0: value,
              answer: value,
              answers: { [pending.question]: [value] },
            },
          });
        }
      }
    } catch (error) {
      if (!nativeResponseAttempted) {
        if (pending.source === "permission") {
          const deny = [...pending.actions.values()].find(
            (action) => action.behavior === "deny",
          );
          if (deny !== undefined) {
            await this.respondPermission(
              pending.nativeRequestId,
              deny.optionId,
            );
          }
        } else {
          await this.respondStructuredInput(pending.nativeRequestId, {
            action: "decline",
          });
        }
      }
      throw error;
    }
    this.emit({
      type: "permission_resolved",
      requestId,
      resolution: response,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    });
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    active.cancelSent = true;
    active.stopping ??= this.stopAndClear(active);
    try {
      await active.stopping;
      if (this.active === active) this.finishCancelled(active);
    } catch (error) {
      this.runtimeFailed(error instanceof AdapterError ? error : undefined);
      throw error;
    }
  }

  private async stopAndClear(active: ActiveTurn): Promise<void> {
    await this.controlCommand("setAutoDrain", { autoDrain: false });
    await this.waitForState(() => active.inFlight === 0);
    await this.cancelPending(true);
    await this.bridge.request(
      "cancelGeneration",
      { workspacePath: this.workspace, sessionId: this.id },
      UnknownResultSchema,
    );
    await this.waitForState(
      () =>
        !!this.conversation.state &&
        !this.conversation.state.control.canStop &&
        this.conversation.state.control.phase !== "running" &&
        this.conversation.state.control.phase !== "prewarming",
    );
    for (const item of this.conversation.state!.queue.items) {
      await this.controlCommand("deleteQueueItem", {
        queueItemId: item.queueItemId,
      });
    }
    await this.waitForState(() => this.conversation.idle);
  }

  private readonly stateListeners = new Set<() => void>();
  private stateChanged(): void {
    for (const listener of this.stateListeners) listener();
  }
  private waitForState(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        if (this.failed || predicate()) {
          clearTimeout(timer);
          this.stateListeners.delete(done);
          if (this.failed)
            reject(
              new AdapterError("NATIVE_EXITED", "ZCode stopped responding"),
            );
          else resolve();
        }
      };
      const timer = setTimeout(() => {
        this.stateListeners.delete(done);
        reject(
          new AdapterError(
            "NATIVE_TIMEOUT",
            "ZCode did not confirm the requested state",
          ),
        );
      }, 30_000);
      this.stateListeners.add(done);
      done();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.failed) {
        await this.interrupt();
        await this.cancelPending(true);
        // Stop event-driven reads before destroying the native session.
        await this.subscription.dispose();
        await this.snapshotRead;
        await this.bridge.request(
          "closeSession",
          { workspacePath: this.workspace, sessionId: this.id },
          UnknownResultSchema,
        );
      }
    } finally {
      this.listeners.clear();
      this.onClose();
    }
  }

  listCommands(): ProviderCommand[] {
    return this.snapshot.slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.inputHint ?? "",
    }));
  }

  async setModel(modelId: string | null): Promise<void> {
    this.assertIdle();
    if (modelId === null) {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode model cannot be cleared",
      );
    }
    const model = decodeModel(modelId);
    const available = new Set(
      this.snapshot.settings.model.available.map((entry) =>
        encodeModel(entry.ref),
      ),
    );
    if (!available.has(modelId)) {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        `Unknown ZCode model: ${modelId}`,
      );
    }
    const snapshot = await this.bridge.request(
      "setModel",
      {
        workspacePath: this.workspace,
        sessionId: this.id,
        model,
        persistAsWorkspaceLastUsed: true,
      },
      SessionSnapshotSchema,
      60_000,
    );
    this.updateSnapshot(snapshot);
    if (encodeModel(snapshot.settings.model.current) !== modelId) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode did not apply the requested model",
      );
    }
    this.emit({ type: "config_changed" });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.assertIdle();
    if (
      thinkingOptionId === null ||
      !this.snapshot.settings.thoughtLevel.enabled ||
      !this.snapshot.settings.thoughtLevel.available.some(
        (entry) => entry.value === thinkingOptionId,
      )
    ) {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        `Unknown ZCode thinking option: ${String(thinkingOptionId)}`,
      );
    }
    const snapshot = await this.bridge.request(
      "setThoughtLevel",
      {
        workspacePath: this.workspace,
        sessionId: this.id,
        thoughtLevel: thinkingOptionId,
        persistAsWorkspaceLastUsed: true,
      },
      SessionSnapshotSchema,
      60_000,
    );
    this.updateSnapshot(snapshot);
    if (snapshot.settings.thoughtLevel.current !== thinkingOptionId) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode did not apply the requested thinking option",
      );
    }
    this.emit({ type: "config_changed" });
  }

  private createActive(): ActiveTurn {
    const id = randomUUID();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    void completion.catch(() => undefined);
    return {
      id,
      inputId: id,
      tools: new Map(),
      inputs: new Map(),
      completedNativeTurns: new Set(),
      inFlight: 0,
      announced: false,
      buffered: [],
      finishing: false,
      completionRevision: 0,
      cancelled: false,
      cancelSent: false,
      settled: false,
      completion,
      resolve,
      reject,
    };
  }

  private async beginTurn(
    prompt: NativePromptInput,
    options?: {
      clientMessageId: string;
      delivery?: "auto" | "steer";
      beforeSend?: () => Promise<void>;
    },
  ): Promise<ActiveTurn> {
    this.assertOpen();
    const previous = this.active;
    if (options?.delivery === "steer" && !previous)
      throw new AdapterError(
        "SESSION_BUSY",
        "ZCode has no active turn to steer",
      );
    if (previous?.cancelled)
      throw new AdapterError(
        "SESSION_BUSY",
        "ZCode is finishing the current run",
      );
    const active = previous ?? this.createActive();
    this.active = active;
    active.finishing = false;
    active.completionRevision++;
    active.inFlight++;
    const commandId = previous ? randomUUID() : active.inputId;
    const input = {
      clientMessageId: options?.clientMessageId,
      accepted: false,
      consumed: false,
    };
    active.inputs.set(commandId, input);
    let sent = false;
    try {
      const nativePrompt = await mapPrompt(prompt, this.workspace);
      if (!nativePrompt.content.trim() && nativePrompt.attachments.length === 0)
        throw new AdapterError(
          "UNSUPPORTED_CONTENT",
          "ZCode requires nonempty input",
        );
      await options?.beforeSend?.();
      this.assertOpen();
      if (active.cancelled)
        throw new AdapterError(
          "SESSION_BUSY",
          "ZCode input was cancelled before sending",
        );
      // A previous stop holds the native queue. Re-enable only for a new explicit run.
      if (!previous && this.conversation.state?.queue.autoDrain === false)
        await this.controlCommand("setAutoDrain", { autoDrain: true });
      const attachments = await uploadAttachments(
        this.bridge,
        this.workspace,
        this.id,
        nativePrompt.attachments,
        () => {
          this.assertOpen();
          if (active.cancelled)
            throw new AdapterError(
              "SESSION_BUSY",
              "ZCode input was cancelled before sending",
            );
        },
      );
      this.assertOpen();
      if (active.cancelled)
        throw new AdapterError(
          "SESSION_BUSY",
          "ZCode input was cancelled before sending",
        );
      sent = true;
      const ack = await conversationCommand(
        this.bridge,
        this.workspace,
        this.id,
        "sendText",
        {
          text: nativePrompt.content,
          requestedDelivery: attachments.length ? "queue" : "guide",
          ...(attachments.length ? { attachments } : {}),
        },
        { commandId },
      );
      if (ack.status !== "accepted") {
        if (
          ack.status === "failed" ||
          ack.status === "rejected" ||
          ack.status === "stale" ||
          ack.status === "noop"
        )
          throw new AdapterError(
            "NATIVE_INPUT_REJECTED",
            "ZCode did not accept the input",
          );
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "Unexpected duplicate command acknowledgement",
        );
      }
      if (
        ack.result?.type !== "inputAccepted" ||
        ack.result.inputId !== commandId ||
        !ack.result.delivery
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode input acknowledgement is inconsistent",
        );
      this.assertOpen();
      input.accepted = true;
      if (ack.result.delivery === "startNow") input.consumed = true;
      if (options?.clientMessageId)
        this.emit({
          type: "prompt_accepted",
          clientMessageId: options.clientMessageId,
          turnId: active.id,
          delivery: previous ? "steer" : "turn",
        });
      if (!active.announced) {
        active.announced = true;
        this.emit({ type: "turn_started", turnId: active.id });
      }
      this.pushTimeline(active, {
        type: "user_message",
        text: nativePrompt.content,
        messageId: commandId,
        ...(options?.clientMessageId
          ? { clientMessageId: options.clientMessageId }
          : {}),
      });
      for (const event of active.buffered.splice(0)) this.emit(event);
      return active;
    } catch (error) {
      if (
        !sent ||
        (error instanceof AdapterError &&
          error.code === "NATIVE_INPUT_REJECTED")
      ) {
        active.inputs.delete(commandId);
        if (!previous && active.inputs.size === 0) this.settle(active);
      } else {
        // The host may already own this command. Never retry uncertain delivery.
        this.runtimeFailed(error instanceof AdapterError ? error : undefined);
      }
      throw error;
    } finally {
      active.inFlight--;
      this.stateChanged();
      await this.maybeComplete(active);
    }
  }

  private async controlCommand(type: string, payload: unknown): Promise<void> {
    let revision = this.conversation.state?.revision;
    if (revision === undefined)
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode conversation state is unavailable",
      );
    // CAS stale acknowledgements prove no mutation occurred; use the returned revision.
    for (let attempt = 0; attempt < 4; attempt++) {
      const ack = await conversationCommand(
        this.bridge,
        this.workspace,
        this.id,
        type,
        payload,
        { revision },
      );
      if (ack.status === "accepted" || ack.status === "noop") return;
      if (ack.status !== "stale")
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          `ZCode ${type} was rejected`,
        );
      revision = ack.revisionAtDecision;
    }
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `ZCode ${type} remained stale`,
    );
  }

  private async maybeComplete(active: ActiveTurn): Promise<void> {
    if (
      this.active !== active ||
      active.settled ||
      active.finishing ||
      active.inFlight ||
      this.pendingAdmissions ||
      active.stopping ||
      !active.lastTerminal ||
      !this.conversation.idle
    )
      return;
    if (
      !active.cancelled &&
      [...active.inputs.values()].some(
        (input) => !input.accepted || !input.consumed,
      )
    )
      return;
    active.finishing = true;
    const revision = ++active.completionRevision;
    try {
      await this.completeActive(active.lastTerminal, revision);
    } catch (error) {
      this.runtimeFailed(
        diagnosticError(error, {
          ...this.bridge.diagnostic,
          stage: "session",
          operation: "complete",
        }),
      );
    }
  }

  private async handleDynamicEvent(dynamic: DynamicEvent): Promise<void> {
    try {
      if (dynamic.type === "conversation.frame") {
        if (this.conversation.accept(dynamic.frame) && this.active) {
          for (const item of this.conversation.state!.queue.items) {
            const input = this.active.inputs.get(item.sourceCommandId);
            if (!input)
              throw new AdapterError(
                "NATIVE_PROTOCOL_ERROR",
                "ZCode queued an unrequested input",
              );
            input.queueItemId = item.queueItemId;
          }
          await this.maybeComplete(this.active);
        }
        if (!this.active && this.conversation.state && !this.conversation.idle)
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode has native work outside the active public run",
          );
        this.stateChanged();
        return;
      }
      if (dynamic.type === "snapshot") {
        this.updateSnapshot(dynamic.snapshot);
        this.publishTodos(dynamic.snapshot);
        return;
      }
      if (dynamic.type === "state.updated") {
        const notification = StateUpdatedNotificationSchema.parse(
          dynamic.notification,
        );
        if (notification.scope !== "session") return;
        if (notification.sessionId !== this.id) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode state update belongs to another session",
          );
        }
        if (
          notification.workspace !== undefined &&
          notification.workspace.workspacePath !== this.workspace
        ) {
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode state update belongs to another workspace",
          );
        }
        if ("model" in notification.patch) await this.refreshContextSnapshot();
        const patch = SessionModePatchSchema.parse(notification.patch);
        if (patch.mode !== undefined) {
          this.updateSnapshot({
            ...this.snapshot,
            settings: { ...this.snapshot.settings, mode: patch.mode },
          });
        }
        return;
      }
      if (dynamic.type === "userInput.response") return;
      if (dynamic.type === "providerRuntimeHeaders.request") {
        await this.bridge.request(
          "respondProviderRuntimeHeaders",
          {
            workspacePath: this.workspace,
            sessionId: this.id,
            requestId: dynamic.request.requestId,
            response: {
              headersApplied: false,
              errorMessage:
                "Interactive provider header recovery is unavailable",
            },
          },
          UnknownResultSchema,
        );
        throw new AdapterError(
          "INTERACTION_UNSUPPORTED",
          "ZCode requested interactive provider header recovery",
        );
      }
      if (dynamic.type === "permission.request") {
        await this.handlePermission(dynamic.request);
        return;
      }
      if (dynamic.type === "userInput.request") {
        await this.handleUserInput(dynamic.request);
        return;
      }
      await this.handleSessionEvent(dynamic.event);
    } catch (error) {
      const active = this.active;
      if (active !== undefined && !active.cancelSent) {
        active.cancelSent = true;
        void this.bridge
          .request(
            "cancelGeneration",
            { workspacePath: this.workspace, sessionId: this.id },
            UnknownResultSchema,
          )
          .catch((cancelError) => {
            this.logger.error(
              "zcode.turn.cancel_after_failure_failed",
              cancelError,
              {
                sessionId: this.id,
              },
            );
          });
      }
      this.runtimeFailed(
        diagnosticError(error, {
          ...this.bridge.diagnostic,
          stage: "notification",
          operation: "event",
          check: "native-event",
        }),
      );
    }
  }

  private async handleSessionEvent(event: SessionEvent): Promise<void> {
    if (event.sessionId !== this.id) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode event belongs to another session",
      );
    }
    if (this.lastSequence !== undefined && event.seq <= this.lastSequence) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode event sequence is duplicated or out of order",
      );
    }
    this.lastSequence = event.seq;
    const active = this.active;
    if (event.type === "session.titleUpdated") return;
    if (event.type === "session.updated") {
      if (contextMayHaveChanged(event.payload))
        await this.refreshContextSnapshot();
      // ZCode maps session_mode_changed to session.updated, preserving its
      // payload. Tool-driven changes do not publish state.updated.
      if ("previousMode" in event.payload) {
        const change = SessionModeChangedSchema.parse(event.payload);
        requireMode(change.previousMode);
        this.updateSnapshot({
          ...this.snapshot,
          settings: {
            ...this.snapshot.settings,
            mode: { current: change.mode },
          },
        });
      }
      return;
    }
    if (KNOWN_NOOP_EVENTS.has(event.type)) return;
    if (event.turnId && this.cancelledNativeTurns.has(event.turnId)) return;
    if (active === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode emitted a turn event while idle",
      );
    }
    if (event.type === "turn.started") {
      const inputId = z
        .object({ inputId: z.string().optional() })
        .parse(event.payload).inputId;
      const input = inputId ? active.inputs.get(inputId) : undefined;
      if (
        !input ||
        !event.turnId ||
        active.completedNativeTurns.has(event.turnId)
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode started an unrequested turn",
        );
      if (
        active.nativeTurnId &&
        active.nativeTurnId !== event.turnId &&
        !active.completedNativeTurns.has(active.nativeTurnId)
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode started overlapping native turns",
        );
      active.nativeTurnId = event.turnId;
      active.lastTerminal = undefined;
      input.consumed = true;
      input.nativeTurnId = event.turnId;
      // Delimit text across native turns even when the public turn is unchanged.
      this.emit({ type: "timeline_boundary" });
      return;
    }
    if (event.type === "turn.steerQueued") {
      const queued = z
        .object({
          pendingInputId: z.string().min(1),
          inputId: z.string().min(1).optional(),
          queryId: z.string().min(1).optional(),
          targetTurnId: z.string().min(1),
        })
        .parse(event.payload);
      const input = active.inputs.get(queued.inputId ?? queued.queryId ?? "");
      if (!input)
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode queued an unknown input",
        );
      // Native deferred admission anchors this event to the previous assistant
      // turn, or "deferred" before the first turn. Only drain/start identifies
      // which executing turn consumes the input.
      input.queueItemId = queued.pendingInputId;
      return;
    }
    if (event.type === "turn.steerDrained") {
      const drained = z
        .object({
          pendingInputIds: z.array(z.string()),
          targetTurnId: z.string(),
        })
        .parse(event.payload);
      if (active.nativeTurnId !== drained.targetTurnId)
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode steered another native turn",
        );
      for (const id of drained.pendingInputIds) {
        const input = [...active.inputs.values()].find(
          (candidate) => candidate.queueItemId === id,
        );
        if (!input)
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode consumed an unknown input",
          );
        input.consumed = true;
        input.nativeTurnId = drained.targetTurnId;
      }
      return;
    }
    if (event.turnId !== undefined) {
      active.nativeTurnId ??= event.turnId;
      if (active.nativeTurnId !== event.turnId) {
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode event turn ID changed",
        );
      }
    }
    if (event.type === "model.streaming") {
      this.handleStreaming(active, event.payload);
      return;
    }
    if (event.type === "tool.updated") {
      this.handleTool(active, event.payload);
      return;
    }
    if (event.type === "turn.completed") {
      if (active.nativeTurnId)
        active.completedNativeTurns.add(active.nativeTurnId);
      active.lastTerminal = event.payload;
      await this.maybeComplete(active);
      return;
    }
    if (event.type === "turn.failed") {
      if (active.cancelled) {
        active.lastTerminal = { resultType: "cancelled" };
        await this.maybeComplete(active);
      } else {
        active.cancelled = true;
        // State confirmations arrive on this subscription; do not block its
        // event consumer while stopping native automatic queue execution.
        active.stopping = this.stopAndClear(active);
        void active.stopping
          .then(() => {
            this.failActive(
              new AdapterError("NATIVE_PROTOCOL_ERROR", "ZCode turn failed"),
            );
          })
          .catch((error) =>
            this.runtimeFailed(
              error instanceof AdapterError ? error : undefined,
            ),
          );
      }
      return;
    }
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `Unsupported ZCode event: ${event.type}`,
    );
  }

  private handleStreaming(
    active: ActiveTurn,
    payload: Record<string, unknown>,
  ): void {
    const kind = typeof payload.kind === "string" ? payload.kind : undefined;
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (kind === "text_delta" || kind === "reasoning_delta") {
      if (delta === "") return;
      const item: NativeTimelineItem =
        kind === "text_delta"
          ? {
              type: "assistant_message",
              text: delta,
              ...(typeof payload.assistantMessageId === "string"
                ? { messageId: payload.assistantMessageId }
                : {}),
            }
          : { type: "reasoning", text: delta };
      this.pushTimeline(active, item);
      return;
    }
    const callId =
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    if (callId === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode tool stream has no ID",
      );
    }
    const tool = active.tools.get(callId) ?? {
      name: typeof payload.toolName === "string" ? payload.toolName : "tool",
      input: null,
      output: null,
      status: "running" as const,
    };
    active.tools.set(callId, tool);
    if (
      kind === "tool_input_start" ||
      kind === "tool_input_delta" ||
      kind === "tool_input_end"
    ) {
      return;
    }
    if (kind === "tool_call") {
      tool.input = payload.input;
      this.pushTool(active, callId, tool);
      return;
    }
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `Unsupported ZCode stream kind: ${String(kind)}`,
    );
  }

  private handleTool(
    active: ActiveTurn,
    payload: Record<string, unknown>,
  ): void {
    const kind = typeof payload.kind === "string" ? payload.kind : undefined;
    if (kind === "batch") return;
    const callId =
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    if (callId === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode tool update has no ID",
      );
    }
    const tool = active.tools.get(callId) ?? {
      name: typeof payload.toolName === "string" ? payload.toolName : "tool",
      // ZCode child tool notifications omit input. Paseo represents unavailable
      // input as null; undefined would invalidate the entire history response.
      input:
        payload.source === "subagent" && payload.input === undefined
          ? null
          : payload.input,
      output: null,
      status: "running" as const,
    };
    active.tools.set(callId, tool);
    if (kind === "scheduled" || kind === "started" || kind === "progress") {
      if (tool.status !== "running") {
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "Invalid ZCode tool transition",
        );
      }
      this.pushTool(active, callId, tool);
      return;
    }
    if (tool.status !== "running") {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "Duplicate ZCode tool terminal event",
      );
    }
    if (kind === "result") {
      tool.status = "completed";
      tool.output = payload.result;
      this.pushTool(active, callId, tool);
      return;
    }
    if (kind === "error") {
      tool.status = "failed";
      tool.output = payload.error;
      this.pushTool(active, callId, tool);
      return;
    }
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `Unsupported ZCode tool update: ${String(kind)}`,
    );
  }

  private pushTool(
    active: ActiveTurn,
    callId: string,
    tool: {
      name: string;
      input: unknown;
      output: unknown;
      status: "running" | "completed" | "failed";
    },
  ): void {
    const detail: ProviderToolCallDetail = {
      type: "unknown",
      input: jsonValue(tool.input),
      output: jsonValue(tool.output),
    };
    const item: NativeTimelineItem =
      tool.status === "failed"
        ? {
            type: "tool_call",
            callId,
            name: tool.name,
            detail,
            status: "failed",
            error: jsonValue(tool.output),
          }
        : {
            type: "tool_call",
            callId,
            name: tool.name,
            detail,
            status: tool.status,
            error: null,
          };
    this.pushTimeline(active, item);
  }

  private async completeActive(
    payload: Record<string, unknown>,
    revision: number,
  ): Promise<void> {
    const active = this.active;
    if (active === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode completed an absent turn",
      );
    }
    if (active.settled || active.stopping) return;
    const resultType = payload.resultType;
    const accepted = new Set([
      "success",
      "max_tokens",
      "token_limit",
      "max_turn_requests",
      "request_limit",
      "refusal",
      "cancelled",
      "interrupted",
      "stopped",
    ]);
    if (typeof resultType !== "string" || !accepted.has(resultType)) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported ZCode terminal result: ${String(resultType)}`,
      );
    }
    await this.cancelPending(true);
    await this.refreshContextSnapshot();
    const nativeUsage = await this.bridge.request(
      "getTaskTokenUsage",
      { workspacePath: this.workspace, sessionId: this.id },
      TokenUsageSchema,
    );
    active.usage = {
      inputTokens: nativeUsage.inputTokens,
      cachedInputTokens: nativeUsage.cacheReadTokens,
      outputTokens: nativeUsage.outputTokens,
      ...this.contextUsage,
    };
    if (
      active.settled ||
      active.stopping ||
      active.completionRevision !== revision
    )
      return;
    const cancelled =
      active.cancelled ||
      resultType === "cancelled" ||
      resultType === "interrupted" ||
      resultType === "stopped";
    if (cancelled) {
      this.finishCancelled(active);
      return;
    }
    this.emit({
      type: "usage_updated",
      usage: active.usage,
      turnId: active.id,
    });
    this.emit({
      type: "turn_completed",
      usage: active.usage,
      turnId: active.id,
    });
    this.settle(active);
  }

  private finishCancelled(active: ActiveTurn): void {
    if (active.settled) return;
    if (active.nativeTurnId) this.cancelledNativeTurns.add(active.nativeTurnId);
    for (const id of active.completedNativeTurns)
      this.cancelledNativeTurns.add(id);
    this.emit({
      type: "turn_canceled",
      reason: "cancelled",
      turnId: active.id,
    });
    this.settle(active);
  }

  private failActive(error: unknown, report = true): void {
    const active = this.active;
    if (active === undefined || active.settled) return;
    error = diagnosticError(error, {
      ...this.bridge.diagnostic,
      stage: "session",
    });
    if (report) this.logger.error("zcode.turn.failed", error);
    const message = safeError(error);
    this.emit({
      type: "turn_failed",
      error: message,
      diagnostic: formatDiagnostic(error),
      code:
        error instanceof AdapterError ? error.code : "NATIVE_PROTOCOL_ERROR",
      turnId: active.id,
    });
    active.settled = true;
    this.active = undefined;
    active.reject(error);
  }

  private settle(active: ActiveTurn): void {
    if (active.settled) return;
    active.settled = true;
    if (this.active === active) this.active = undefined;
    active.resolve();
  }

  private async handlePermission(request: PermissionRequest): Promise<void> {
    if (request.sessionId !== this.id) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "Permission belongs to another session",
      );
    }
    const active = this.requireActive();
    try {
      const actions = permissionActions(
        request,
        request.toolName === "ExitPlanMode",
      );
      const markdown =
        request.toolName === "ExitPlanMode"
          ? planMarkdown(request.input)
          : undefined;
      const id =
        markdown === undefined
          ? `zcode-permission:${request.requestId}`
          : `zcode-plan:${request.requestId}`;
      const mapped: ProviderPermissionRequest = {
        id,

        name: markdown === undefined ? request.toolName : "ZCodePlanApproval",
        kind: markdown === undefined ? "tool" : "plan",
        title: markdown === undefined ? request.toolName : "Plan",
        description: request.reason,
        input:
          markdown === undefined
            ? jsonObject(request.input)
            : { plan: markdown },
        actions,
        ...(markdown === undefined
          ? {
              detail: {
                type: "unknown",
                input: jsonValue(request.input),
                output: null,
              },
            }
          : {
              metadata: {
                planText: markdown,
                source: "zcode_plan_approval",
              },
            }),
      };
      this.addPending({
        source: "permission",
        request: mapped,
        nativeRequestId: request.requestId,
        turnId: active.id,
        resolved: false,
        actions: new Map(
          actions.map((action) => [
            action.id,
            { behavior: action.behavior, optionId: action.id },
          ]),
        ),
      });
    } catch (error) {
      const deny = request.options.find(
        (option) => option.response.decision === "deny",
      );
      if (deny !== undefined)
        await this.respondPermission(request.requestId, deny.optionId);
      throw error;
    }
  }

  private async handleUserInput(request: UserInputRequest): Promise<void> {
    if (request.sessionId !== this.id) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "Question belongs to another session",
      );
    }
    const active = this.requireActive();
    const isPlan = record(request.schema).interaction === "plan_approval";
    try {
      if (!isPlan) {
        const id = `zcode-question:${request.requestId}`;
        const mapped = mapQuestionRequest(request, id);
        this.addPending({
          source: "question",
          request: mapped.request,
          nativeRequestId: request.requestId,
          turnId: active.id,
          resolved: false,
          fields: mapped.fields,
        });
        return;
      }
      const markdown = planMarkdown(request.input);
      const question = request.questions?.[0];
      if (
        request.questions?.length !== 1 ||
        question === undefined ||
        question.multiSelect === true ||
        question.options.length === 0
      ) {
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode plan question must be a single-select field",
        );
      }
      const seen = new Set<string>();
      const actions = new Map<
        string,
        { behavior: "allow" | "deny"; value?: string }
      >();
      const mappedActions: ProviderPermissionAction[] = question.options.map(
        (option) => {
          if (
            option.value === "" ||
            option.label === "" ||
            seen.has(option.value)
          ) {
            throw new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "ZCode plan options are ambiguous",
            );
          }
          seen.add(option.value);
          actions.set(option.value, {
            behavior: "allow",
            value: option.value,
          });
          return {
            id: option.value,
            label: option.label,
            behavior: "allow" as const,
            variant: "primary" as const,
            intent: "implement" as const,
          };
        },
      );
      const dismissId = `zcode-plan-dismiss:${request.requestId}`;
      actions.set(dismissId, { behavior: "deny" });
      mappedActions.push({
        id: dismissId,
        label: "Dismiss",
        behavior: "deny",
        variant: "danger",
        intent: "dismiss",
      });
      const id = `zcode-plan:${request.requestId}`;
      this.addPending({
        source: "plan-question",
        nativeRequestId: request.requestId,
        turnId: active.id,
        resolved: false,
        question: question.question,
        actions,
        request: {
          id,

          name: "ZCodePlanApproval",
          kind: "plan",
          title: "Plan",
          description: request.prompt ?? question.question,
          input: { plan: markdown },
          actions: mappedActions,
          metadata: {
            planText: markdown,
            source: "zcode_plan_approval",
          },
        },
      });
    } catch (error) {
      await this.respondStructuredInput(request.requestId, {
        action: "decline",
        reason: "Unsupported ZCode interaction",
      });
      throw error;
    }
  }

  private addPending(pending: PendingInteraction): void {
    if (this.pending.has(pending.request.id)) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "Duplicate ZCode interaction ID",
      );
    }
    this.pending.set(pending.request.id, pending);
    this.emit({
      type: "permission_requested",
      request: pending.request,
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    });
  }

  private async cancelPending(cancel: boolean): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, pending] of entries) {
      if (pending.resolved) continue;
      pending.resolved = true;
      try {
        if (pending.source === "permission") {
          const deny = [...pending.actions.values()].find(
            (action) => action.behavior === "deny",
          );
          if (deny === undefined) {
            throw new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "Pending permission has no deny action",
            );
          }
          await this.respondPermission(pending.nativeRequestId, deny.optionId);
        } else {
          await this.respondStructuredInput(pending.nativeRequestId, {
            action: cancel ? "cancel" : "decline",
          });
        }
        this.emit({
          type: "permission_resolved",
          requestId: id,
          resolution: { behavior: "deny", interrupt: cancel },
          ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
        });
      } catch (error) {
        this.logger.error("zcode.interaction.cleanup_failed", error, {
          sessionId: this.id,
        });
      }
    }
  }

  private respondPermission(
    nativeRequestId: string,
    optionId: string,
  ): Promise<unknown> {
    return this.bridge.request(
      "respondPermission",
      {
        workspacePath: this.workspace,
        sessionId: this.id,
        requestId: nativeRequestId,
        optionId,
      },
      UnknownResultSchema,
    );
  }

  private respondStructuredInput(
    nativeRequestId: string,
    response: Record<string, unknown>,
  ): Promise<unknown> {
    return this.bridge.request(
      "respondStructuredInput",
      {
        workspacePath: this.workspace,
        sessionId: this.id,
        requestId: nativeRequestId,
        response,
      },
      UnknownResultSchema,
    );
  }

  private publishTodos(snapshot: SessionSnapshot): void {
    const items = snapshot.todos ?? [];
    const timeline: NativeTimelineItem = {
      type: "todo",
      items: items.map((todo) =>
        Object.assign(
          {
            text: todo.content,
            completed: todo.status === "completed",
            status: todo.status,
          },
          { priority: todo.priority },
        ),
      ),
    };
    const active = this.active;
    if (active === undefined) {
      this.emit({
        type: "timeline",
        item: timeline,
      });
    } else {
      this.pushTimeline(active, timeline);
    }
  }

  private readContextUsage(
    snapshot: SessionSnapshot,
  ): ProviderUsage | undefined {
    const context = snapshot.runtime.contextUsage;
    return context
      ? {
          contextWindowUsedTokens: context.used,
          contextWindowMaxTokens: context.size,
        }
      : undefined;
  }

  private refreshContextSnapshot(): Promise<void> {
    if (this.snapshotRead) return this.snapshotRead;
    const revision = this.snapshotRevision;
    const request = this.bridge
      .request(
        "readSession",
        {
          workspacePath: this.workspace,
          sessionId: this.id,
          runtimePolicy: "existing-only",
        },
        SessionSnapshotSchema,
      )
      .then((snapshot) => {
        if (!this.closed && revision === this.snapshotRevision)
          this.updateSnapshot(snapshot);
        return undefined;
      })
      .finally(() => {
        if (this.snapshotRead === request) this.snapshotRead = undefined;
      });
    this.snapshotRead = request;
    return request;
  }

  private updateSnapshot(snapshot: SessionSnapshot): void {
    assertSnapshotWorkspace(snapshot, this.workspace);
    if (snapshot.session.sessionId !== this.id) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode snapshot belongs to another session",
      );
    }
    const modeId = requireMode(snapshot.settings.mode.current);
    const previousModeId = this.snapshot.settings.mode.current;
    this.snapshot = snapshot;
    this.snapshotRevision += 1;
    const usage = this.readContextUsage(snapshot);
    if (
      usage &&
      (usage.contextWindowUsedTokens !==
        this.contextUsage?.contextWindowUsedTokens ||
        usage.contextWindowMaxTokens !==
          this.contextUsage?.contextWindowMaxTokens)
    ) {
      this.contextUsage = usage;
      this.emit({ type: "usage_updated", usage });
    }
    if (modeId !== "plan") this.editingMode = modeId;
    if (modeId !== previousModeId && !this.configuringMode) {
      this.emit({ type: "config_changed" });
    }
  }

  private pushTimeline(active: ActiveTurn, item: NativeTimelineItem): void {
    this.history.push(item);
    this.emit({
      type: "timeline",
      item,
      turnId: active.id,
    });
  }

  private emit(event: NativeSessionEvent): void {
    if (
      this.active &&
      !this.active.announced &&
      (event.type === "timeline" ||
        event.type === "timeline_boundary" ||
        event.type === "permission_requested" ||
        event.type === "usage_updated")
    ) {
      this.active.buffered.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  private requireActive(): ActiveTurn {
    if (this.active === undefined) {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode interaction has no active turn",
      );
    }
    return this.active;
  }

  private assertOpen(): void {
    if (this.closed || this.failed)
      throw new AdapterError("NATIVE_EXITED", "ZCode session is closed");
  }

  private assertIdle(): void {
    this.assertOpen();
    if (this.active !== undefined) {
      throw new AdapterError(
        "SESSION_BUSY",
        "ZCode session has an active turn",
      );
    }
  }
}

export async function resolveWorkspace(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new AdapterError(
      "INVALID_WORKSPACE",
      "Workspace path must be absolute",
    );
  }
  const info = await stat(cwd);
  if (!info.isDirectory()) {
    throw new AdapterError(
      "INVALID_WORKSPACE",
      "Workspace path must be a directory",
    );
  }
  return await realpath(cwd);
}

export function assertSnapshotWorkspace(
  snapshot: SessionSnapshot,
  workspace: string,
): void {
  if (snapshot.session.workspace.workspacePath !== workspace) {
    throw new AdapterError(
      "INVALID_WORKSPACE",
      "ZCode session belongs to another workspace",
    );
  }
}

export async function initializeWorkspace(
  bridge: HostBridge,
  workspace: string,
): Promise<SessionSettings> {
  const initialized = await bridge.request(
    "initialize",
    { workspacePath: workspace },
    InitializeResultSchema,
    60_000,
  );
  if (!initialized.available) {
    throw new AdapterError(
      initialized.reasonCode === "provider_not_ready"
        ? "AUTH_REQUIRED"
        : "NATIVE_PROTOCOL_ERROR",
      initialized.reason ?? "ZCode host is unavailable",
    );
  }
  const state = await bridge.request(
    "readWorkspaceState",
    { workspacePath: workspace },
    WorkspaceStateResultSchema,
    60_000,
  );
  if (state.workspace.workspacePath !== workspace) {
    throw new AdapterError(
      "INVALID_WORKSPACE",
      "ZCode initialized a different workspace",
    );
  }
  if ((state.modelCatalog?.providers.length ?? 0) === 0) {
    throw new AdapterError(
      "AUTH_REQUIRED",
      "No usable ZCode model provider is configured",
    );
  }
  SessionSettingsSchema.parse(state.settings);
  return state.settings;
}

function safeError(error: unknown): string {
  if (error instanceof AdapterError) return `${error.code}: ${error.message}`;
  return "ZCode provider operation failed";
}

function contextMayHaveChanged(payload: Record<string, unknown>): boolean {
  return [
    "usage",
    "postCompactTokenCount",
    "truePostCompactTokenCount",
    "compactBoundary",
    "modelRef",
  ].some((key) => key in payload);
}
