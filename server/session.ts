import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import type {
  ProviderSessionConfig,
  ProviderConfigState,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderCommand,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type {
  ConversationRow,
  TurnHeaderRow,
} from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";
import { Conversation, conversationCommand } from "./conversation.js";
import {
  rowTimeline,
  usage,
  presentInteraction,
  type PresentedInteraction,
} from "./presentation.js";
import { readModelSelection, resolveModelSelection } from "./models.js";
import { uploadAttachments } from "./attachments.js";
import {
  catalogModels,
  decodeModel,
  encodeModel,
  mapPrompt,
  requireMode,
  ZCODE_MODES,
} from "./mapping.js";
import {
  InitializeResultSchema,
  WorkspacePresentationSchema,
  type SessionSnapshot,
  type ModelOption,
  type ModelSelectionView,
} from "./host/schemas.js";
import type { HostBridge } from "./host/bridge.js";
import type { Logger } from "./logger.js";
import type {
  NativePromptInput,
  NativeSessionEvent,
  NativeTimelineEntry,
} from "./session-types.js";
import { AdapterError } from "./errors.js";
import { diagnosticError, formatDiagnostic } from "./diagnostics.js";
interface Admission {
  clientMessageId?: string;
  accepted: boolean;
  consumed: boolean;
  productTurnId?: string;
}
interface Run {
  id: string;
  inputs: Map<string, Admission>;
  productTurns: Set<string>;
  announced: boolean;
  inFlight: number;
  cancelled: boolean;
  stopping?: Promise<void>;
  buffered: NativeSessionEvent[];
}
export class ZCodeSession {
  readonly id: string;
  private readonly conversation: Conversation;
  private readonly listeners = new Set<(event: NativeSessionEvent) => void>();
  private readonly admissions = new Map<string, Admission>();
  private readonly seenTurns = new Set<string>();
  private readonly publicTurns = new Map<string, string>();
  private readonly presented = new Map<string, NativeTimelineEntry>();
  private readonly pending = new Map<string, PresentedInteraction>();
  private readonly answering = new Set<string>();
  private readonly resolvedInteractions = new Set<string>();
  private active?: Run;
  private pendingAdmissions = 0;
  private failed = false;
  private closed = false;
  private initialized = false;
  private unlistenFailure?: () => void;
  private previousConfig?: unknown;
  private previousUsage?: unknown;
  private readonly idleListeners = new Set<() => void>();
  private constructor(
    private readonly bridge: HostBridge,
    private readonly logger: Logger,
    private readonly workspace: string,
    private readonly snapshot: SessionSnapshot,
    private modelCatalog: readonly ModelOption[],
    private readonly onClose: () => void,
  ) {
    assertSnapshotWorkspace(snapshot, workspace);
    this.id = snapshot.session.sessionId;
    this.conversation = new Conversation(bridge, workspace, this.id, (error) =>
      this.runtimeFailed(diagnosticError(error, bridge.diagnostic)),
    );
  }
  static async create(options: {
    bridge: HostBridge;
    logger: Logger;
    workspace: string;
    snapshot: SessionSnapshot;
    modelCatalog: readonly ModelOption[];
    onClose: () => void;
  }): Promise<ZCodeSession> {
    const session = new ZCodeSession(
      options.bridge,
      options.logger,
      options.workspace,
      options.snapshot,
      options.modelCatalog,
      options.onClose,
    );
    session.unlistenFailure = options.bridge.onFailure((error) =>
      session.runtimeFailed(error),
    );
    try {
      await session.conversation.open();
      session.assertOpen();
      if (!session.conversation.idle)
        throw new AdapterError(
          "SESSION_BUSY",
          "ZCode resumed a conversation with active foreground work",
        );
      for (const row of session.state.rows.window) {
        if (row.kind === "turnHeader")
          session.seenTurns.add(session.productTurn(row));
        const item = rowTimeline(row);
        if (item)
          session.presented.set(item.id, {
            item,
            timestamp: new Date(row.createdAt).toISOString(),
          });
      }
      session.conversation.subscribe(() => {
        try {
          session.observe();
        } catch (error) {
          session.runtimeFailed(
            diagnosticError(error, session.bridge.diagnostic),
          );
        }
      });
      session.initialized = true;
      session.observe();
      return session;
    } catch (error) {
      session.unlistenFailure();
      await session.conversation.close();
      throw error;
    }
  }
  private get state() {
    return this.conversation.state!;
  }
  private productTurn(row: ConversationRow): string {
    if (!row.productTurnId)
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode V4 row has no product turn ID",
      );
    return row.productTurnId;
  }
  private newRun(): Run {
    return {
      id: randomUUID(),
      inputs: new Map(),
      productTurns: new Set(),
      announced: false,
      inFlight: 0,
      cancelled: false,
      buffered: [],
    };
  }
  private announce(run: Run): void {
    if (run.announced) return;
    run.announced = true;
    this.emit({ type: "turn_started", turnId: run.id });
    for (const e of run.buffered.splice(0)) this.emit(e);
  }
  private runEvent(event: NativeSessionEvent, run = this.active): void {
    if (run && !run.announced) run.buffered.push(event);
    else this.emit(event);
  }
  private observe(): void {
    if (!this.initialized || this.failed || this.closed) return;
    for (const row of this.state.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        const input = this.admissions.get(row.sourceCommandId);
        if (input) {
          input.consumed = true;
          input.productTurnId = this.productTurn(row);
          if (this.active?.inputs.has(row.sourceCommandId)) {
            this.active.productTurns.add(input.productTurnId);
            this.publicTurns.set(input.productTurnId, this.active.id);
          }
        }
      }
      if (row.kind !== "turnHeader") continue;
      const turn = this.productTurn(row);
      if (!this.seenTurns.has(turn)) {
        this.seenTurns.add(turn);
        if (!this.active && row.origin !== "userInput") {
          this.active = this.newRun();
          this.announce(this.active);
        }
        if (this.active) {
          this.active.productTurns.add(turn);
          this.publicTurns.set(turn, this.active.id);
        }
      }
    }
    for (const row of this.state.rows.window) {
      const clientMessageId =
        row.kind === "userInput" && row.sourceCommandId
          ? this.admissions.get(row.sourceCommandId)?.clientMessageId
          : undefined;
      const item = rowTimeline(row, clientMessageId);
      if (!item) continue;
      const entry = { item, timestamp: new Date(row.createdAt).toISOString() };
      if (isDeepStrictEqual(entry, this.presented.get(item.id))) continue;
      this.presented.set(item.id, entry);
      this.runEvent({
        type: "timeline",
        ...entry,
        turnId: row.productTurnId
          ? this.publicTurns.get(row.productTurnId)
          : undefined,
      });
    }
    if (this.state.plan) {
      const item: ProviderTimelineItem = {
        id: "zcode:plan",
        type: "todo",
        items: this.state.plan.items.map((i) => ({
          text: i.content,
          completed: i.status === "completed",
          status: i.status === "inProgress" ? "in_progress" : i.status,
        })),
      };
      if (!isDeepStrictEqual(item, this.presented.get(item.id)?.item)) {
        this.presented.set(item.id, { item });
        this.runEvent({ type: "timeline", item, turnId: this.active?.id });
      }
    }
    if (!isDeepStrictEqual(this.previousConfig, this.state.config)) {
      this.previousConfig = this.state.config;
      this.emit({ type: "config_changed" });
    }
    const nextUsage = usage(this.state);
    if (!isDeepStrictEqual(nextUsage, this.previousUsage)) {
      this.previousUsage = nextUsage;
      this.runEvent({
        type: "usage_updated",
        usage: nextUsage,
        turnId: this.active?.id,
      });
    }
    const ids = new Set(
      this.state.pendingInteractions.map((i) => i.interactionId),
    );
    for (const id of this.pending.keys())
      if (!ids.has(id)) {
        this.pending.delete(id);
        this.resolvedInteractions.add(id);
        this.runEvent({
          type: "permission_resolved",
          requestId: id,
          resolution: { behavior: "deny" },
        });
      }
    for (const interaction of this.state.pendingInteractions) {
      if (this.pending.has(interaction.interactionId)) continue;
      const p = presentInteraction(interaction);
      if (p) {
        this.pending.set(interaction.interactionId, p);
        this.runEvent({
          type: "permission_requested",
          request: p.request,
          turnId: this.active?.id,
        });
      }
    }
    if (
      this.state.workspaceHookAdmission ||
      this.state.pendingInteractions.some(
        (i) => i.kind === "workspaceHookReview",
      )
    ) {
      const item: ProviderTimelineItem = {
        id: "zcode:hook-trust",
        type: "notification",
        level: "warning",
        message:
          "ZCode workspace hooks require trust review. Review them with the official zcode hooks trust command.",
      };
      if (!this.presented.has(item.id)) {
        this.presented.set(item.id, { item });
        this.runEvent({ type: "timeline", item });
      }
    }
    this.changed();
    const run = this.active;
    if (
      run &&
      !run.stopping &&
      !run.cancelled &&
      this.state.queue.items.length &&
      (this.state.control.phase === "error" ||
        this.state.rows.window.some(
          (row) =>
            row.kind === "turnHeader" &&
            row.state === "failed" &&
            run.productTurns.has(this.productTurn(row)),
        ))
    ) {
      void this.interrupt().catch(() => {}); // interrupt reports terminal transport failures.
    }
    this.maybeComplete();
  }
  private maybeComplete(): void {
    const run = this.active;
    if (
      !run ||
      !run.announced ||
      run.inFlight ||
      this.pendingAdmissions ||
      run.stopping ||
      !this.conversation.idle
    )
      return;
    if (
      !run.cancelled &&
      [...run.inputs.values()].some((i) => !i.accepted || !i.consumed)
    )
      return;
    const headers = this.state.rows.window.filter(
      (r): r is TurnHeaderRow =>
        r.kind === "turnHeader" && run.productTurns.has(this.productTurn(r)),
    );
    if (
      !run.cancelled &&
      (!headers.length || headers.some((h) => h.state === "running"))
    )
      return;
    const failed =
      headers.some((h) => h.state === "failed") ||
      this.state.control.phase === "error";
    this.active = undefined;
    this.emit(
      failed
        ? {
            type: "turn_failed",
            turnId: run.id,
            error: "ZCode execution failed",
            code: "NATIVE_PROTOCOL_ERROR",
          }
        : {
            type:
              run.cancelled ||
              headers.some((h) => h.state === "completedInterrupted")
                ? "turn_canceled"
                : "turn_completed",
            turnId: run.id,
          },
    );
    this.changed();
  }
  private changed(): void {
    for (const listener of this.idleListeners) listener();
  }
  private waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleListeners.delete(check);
        reject(
          new AdapterError(
            "NATIVE_TIMEOUT",
            "ZCode did not settle input admission",
          ),
        );
      }, 30_000);
      const check = () => {
        if (this.failed || predicate()) {
          clearTimeout(timer);
          this.idleListeners.delete(check);
          this.failed
            ? reject(new AdapterError("NATIVE_EXITED", "ZCode disconnected"))
            : resolve();
        }
      };
      this.idleListeners.add(check);
      check();
    });
  }
  reserveInput(): () => void {
    this.pendingAdmissions++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingAdmissions--;
      this.maybeComplete();
    };
  }
  hasActiveTurn(): boolean {
    return !!this.active;
  }
  subscribe(listener: (event: NativeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "usage_updated", usage: usage(this.state) });
    return () => this.listeners.delete(listener);
  }
  historyItems(): readonly NativeTimelineEntry[] {
    return [...this.presented.values()];
  }
  getPendingPermissions(): ProviderPermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }
  listCommands(): ProviderCommand[] {
    return this.snapshot.slashCommands.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.inputHint ?? "",
    }));
  }
  getConfig(): ProviderConfigState {
    const c = this.state.config;
    return {
      model: c.modelSelection ? encodeModel(c.modelSelection) : undefined,
      mode: c.mode,
      thinkingOption: c.thought,
      models: catalogModels(this.modelCatalog, c.modelSelection),
      modes: ZCODE_MODES,
      thinkingOptions: c.thoughtLevels.map((id) => ({ id, label: id })),
      settings: [
        {
          type: "toggle",
          id: "plan_mode",
          label: "Toggle plan mode",
          value: c.planEnabled === true,
        },
      ],
    };
  }
  async applyInitialConfig(
    config: Partial<ProviderSessionConfig>,
  ): Promise<void> {
    if (config.model !== undefined) await this.setModel(config.model);
    if (config.thinkingOption !== undefined)
      await this.setThinkingOption(config.thinkingOption);
    await this.configureMode(
      config.mode,
      config.settings?.plan_mode as boolean | undefined,
    );
  }
  async configureMode(mode?: string | null, plan?: boolean): Promise<void> {
    this.assertIdle();
    if (
      mode === null ||
      (mode !== undefined && !ZCODE_MODES.some((m) => m.id === mode))
    )
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "Mode must be build, edit, or yolo",
      );
    const nextMode = mode ?? this.state.config.mode,
      nextPlan = plan ?? this.state.config.planEnabled === true;
    if (
      nextMode === this.state.config.mode &&
      nextPlan === (this.state.config.planEnabled === true)
    )
      return;
    if (
      nextMode !== this.state.config.mode ||
      (!nextPlan && this.state.config.planEnabled)
    ) {
      await this.control("switchCollaborationMode", { mode: nextMode });
      await this.conversation.waitFor(
        () =>
          this.state.config.mode === nextMode && !this.state.config.planEnabled,
      );
    }
    if (nextPlan && !this.state.config.planEnabled)
      await this.control("switchCollaborationMode", { mode: "plan" });
    await this.conversation.waitFor(
      () =>
        this.state.config.mode === nextMode &&
        (this.state.config.planEnabled === true) === nextPlan,
    );
  }
  async setModel(value: string | null): Promise<void> {
    this.assertIdle();
    if (value === null)
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode model cannot be cleared",
      );
    const view = await readModelSelection(this.bridge);
    this.modelCatalog = view.models;
    const selection = await resolveModelSelection(
      this.bridge,
      view,
      decodeModel(value),
    );
    this.assertIdle();
    await this.control("switchModelConfig", {
      provider: selection.providerId,
      model: selection.modelId,
      thought: selection.options!.reasoningLevel,
    });
    await this.conversation.waitFor(
      () =>
        this.state.config.modelSelection !== undefined &&
        encodeModel(this.state.config.modelSelection) === value &&
        this.state.config.thought === selection.options!.reasoningLevel,
    );
  }
  async setThinkingOption(value: string | null): Promise<void> {
    this.assertIdle();
    if (value === null || !this.state.config.thoughtLevels.includes(value))
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "Unknown reasoning level",
      );
    await this.control("switchModelConfig", {
      provider: this.state.config.provider,
      model: this.state.config.model,
      thought: value,
    });
    await this.conversation.waitFor(() => this.state.config.thought === value);
  }
  async startTurn(
    prompt: NativePromptInput,
    options?: {
      clientMessageId: string;
      delivery?: "auto" | "steer";
      beforeSend?: () => Promise<void>;
    },
  ): Promise<{ turnId: string }> {
    this.assertOpen();
    const previous = this.active;
    if (previous?.cancelled || (options?.delivery === "steer" && !previous))
      throw new AdapterError(
        "SESSION_BUSY",
        "ZCode cannot accept this input in its current execution state",
      );
    const run = previous ?? this.newRun();
    this.active = run;
    run.inFlight++;
    const commandId = randomUUID(),
      input: Admission = {
        clientMessageId: options?.clientMessageId,
        accepted: false,
        consumed: false,
      };
    run.inputs.set(commandId, input);
    this.admissions.set(commandId, input);
    let sent = false;
    const assertSending = () => {
      this.assertOpen();
      if (run.cancelled)
        throw new AdapterError(
          "SESSION_BUSY",
          "Input was cancelled before sending",
        );
    };
    try {
      const native = await mapPrompt(prompt, this.workspace);
      if (!native.content.trim() && !native.attachments.length)
        throw new AdapterError(
          "UNSUPPORTED_CONTENT",
          "ZCode requires nonempty input",
        );
      if (previous && native.content.trimStart().startsWith("/"))
        throw new AdapterError(
          "SESSION_BUSY",
          "ZCode commands require an idle session",
        );
      await options?.beforeSend?.();
      assertSending();
      if (!previous && !this.state.queue.autoDrain)
        await this.control("setAutoDrain", { autoDrain: true });
      const attachments = await uploadAttachments(
        this.bridge,
        this.workspace,
        this.id,
        native.attachments,
        assertSending,
      );
      assertSending();
      const config = this.state.config;
      if (!config.modelSelection?.options?.reasoningLevel)
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "Select a ZCode model and reasoning level before sending",
        );
      sent = true;
      const ack = await conversationCommand(
        this.bridge,
        this.workspace,
        this.id,
        "sendText",
        {
          text: native.content,
          attachments,
          modelSelection: config.modelSelection,
          mode: config.mode,
          planEnabled: config.planEnabled === true,
          requestedDelivery: previous
            ? attachments.length
              ? "queue"
              : "guide"
            : "startNow",
        },
        { commandId },
      );
      if (["failed", "rejected", "stale", "noop"].includes(ack.status))
        throw new AdapterError(
          "NATIVE_INPUT_REJECTED",
          "ZCode rejected the input",
        );
      if (
        ack.status !== "accepted" ||
        ack.result?.type !== "inputAccepted" ||
        ack.result.inputId !== commandId
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode input acknowledgement is inconsistent",
        );
      this.assertOpen();
      input.accepted = true;
      if (options?.clientMessageId)
        this.emit({
          type: "prompt_accepted",
          clientMessageId: options.clientMessageId,
          turnId: run.id,
          delivery: previous ? "steer" : "turn",
        });
      this.announce(run);
      this.observe();
      return { turnId: run.id };
    } catch (error) {
      if (
        !sent ||
        (error instanceof AdapterError &&
          error.code === "NATIVE_INPUT_REJECTED")
      ) {
        run.inputs.delete(commandId);
        this.admissions.delete(commandId);
        if (!previous && run.inputs.size === 0) this.active = undefined;
      } else this.runtimeFailed(diagnosticError(error, this.bridge.diagnostic));
      throw error;
    } finally {
      run.inFlight--;
      this.changed();
      this.maybeComplete();
    }
  }
  private async control(type: string, payload: unknown): Promise<void> {
    this.assertOpen();
    // A stale CAS proves no mutation occurred. No input is retried here.
    let revision = this.state.revision;
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
      "ZCode configuration remained stale",
    );
  }
  async respondToPermission(
    id: string,
    response: ProviderPermissionResponse,
  ): Promise<void> {
    this.assertOpen();
    // An observed terminal interaction is immutable. A delayed UI response cannot
    // resolve it again or interrupt a later turn.
    if (this.resolvedInteractions.has(id) || this.answering.has(id)) return;
    const pending = this.pending.get(id);
    if (!pending)
      throw new AdapterError(
        "SESSION_NOT_FOUND",
        "ZCode interaction is no longer pending",
      );
    const answer = pending.answer(response);
    this.answering.add(id);
    try {
      await this.control("resolveInteraction", { interactionId: id, answer });
      await this.conversation.waitFor(
        () =>
          !this.state.pendingInteractions.some((i) => i.interactionId === id),
      );
    } finally {
      this.answering.delete(id);
    }
  }
  async interrupt(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.cancelled = true;
    run.stopping ??= this.stop(run);
    try {
      await run.stopping;
      run.stopping = undefined;
      this.maybeComplete();
    } catch (error) {
      this.runtimeFailed(diagnosticError(error, this.bridge.diagnostic));
      throw error;
    }
  }
  private async stop(run: Run): Promise<void> {
    await this.control("setAutoDrain", { autoDrain: false });
    await this.waitFor(() => run.inFlight === 0);
    if (this.active !== run) return;
    const target = this.state.control.activeWorks.find(
      (w) => w.foregroundExecutionId,
    )?.foregroundExecutionId;
    if (this.state.control.canStop && !target)
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode did not identify its stoppable foreground execution",
      );
    if (target)
      await this.control("stop", { expectedForegroundExecutionId: target });
    await this.conversation.waitFor(
      () =>
        !this.state.control.canStop &&
        this.state.control.activeWorks.length === 0 &&
        this.state.control.phase !== "running" &&
        this.state.control.phase !== "prewarming",
    );
    for (const item of [...this.state.queue.items])
      await this.control("deleteQueueItem", { queueItemId: item.queueItemId });
    await this.conversation.waitFor(() => this.conversation.idle);
  }
  runtimeFailed(error?: AdapterError): void {
    if (this.failed) return;
    this.failed = true;
    const failure = diagnosticError(
      error ?? new AdapterError("NATIVE_EXITED", "ZCode Server disconnected"),
      { ...this.bridge.diagnostic, stage: "session" },
    );
    this.active = undefined;
    this.changed();
    this.emit({
      type: "runtime_failed",
      error: failure.message,
      code: failure.code,
      diagnostic: formatDiagnostic(failure),
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.failed) {
        await this.interrupt();
        await this.conversation.close();
        await this.bridge.request(
          "closeSession",
          { workspacePath: this.workspace, sessionId: this.id },
          z.boolean(),
        );
      } else await this.conversation.close();
    } finally {
      this.closed = true;
      this.unlistenFailure?.();
      this.listeners.clear();
      this.changed();
      this.onClose();
    }
  }
  private assertOpen(): void {
    if (this.closed || this.failed)
      throw new AdapterError("NATIVE_EXITED", "ZCode session is closed");
  }
  private assertIdle(): void {
    this.assertOpen();
    if (this.active)
      throw new AdapterError("SESSION_BUSY", "ZCode session is running");
  }
  private emit(event: NativeSessionEvent): void {
    for (const listener of this.listeners) listener(event);
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
): Promise<{ presentation: { mode: string }; selection: ModelSelectionView }> {
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
  const presentation = await bridge.request(
    "readWorkspacePresentation",
    { workspacePath: workspace },
    WorkspacePresentationSchema,
    60_000,
  );
  if (presentation.workspace.workspacePath !== workspace)
    throw new AdapterError(
      "INVALID_WORKSPACE",
      "ZCode returned a different workspace",
    );
  requireMode(presentation.mode);
  const selection = await readModelSelection(bridge);
  return { presentation, selection };
}
