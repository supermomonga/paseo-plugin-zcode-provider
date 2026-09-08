import {
  PROVIDER_PROTOCOL_VERSION,
  ProviderInputSchema,
  ProviderEventSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderRegistration,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderCapability,
  type ProviderError,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import {
  SessionPersistenceStore,
  parsePersistence,
  persistenceHandle,
  type PersistenceData,
} from "./persistence.js";
import { homedir } from "node:os";
import { z } from "zod";
import {
  assertRuntimeSupported,
  discoverRuntime,
  runRuntimeSmoke,
} from "./discovery/discover.js";
import { ZCodeHostBridge, type HostBridge } from "./host/bridge.js";
import { logger } from "./logger.js";
import { AdapterError } from "./errors.js";
import { catalogModels, mapMcpServers, ZCODE_MODES } from "./mapping.js";
import {
  ZCodeSession,
  initializeWorkspace,
  resolveWorkspace,
} from "./session.js";
import {
  SessionSnapshotSchema,
  SessionListSchema,
} from "./protocol/v1/host-schemas.js";
import { TimelineSnapshots } from "./timeline.js";
import type { NativeSessionEvent } from "./session-types.js";

export const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
] as const satisfies readonly ProviderCapability[];

export type BridgeFactory = (
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<HostBridge>;

async function createHost(
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<HostBridge> {
  const env = { ...process.env, ...environment };
  const runtime = await discoverRuntime({ environment: env, signal });
  assertRuntimeSupported(runtime);
  const smoke = await runRuntimeSmoke(runtime, env, signal);
  if (!smoke.passed)
    throw new AdapterError(
      "RUNTIME_SMOKE_FAILED",
      "ZCode runtime smoke failed",
    );
  signal.throwIfAborted();
  return ZCodeHostBridge.start(runtime, logger, env);
}

const optionsSchema = z.object({}).strict();
const settingsSchema = z.object({ plan_mode: z.boolean().optional() }).strict();

interface SessionEntry {
  native: ZCodeSession;
  persistence: PersistenceData;
  submitted: boolean;
  bridge: HostBridge;
  unsubscribe: () => void;
  unsubscribeFailure: () => void;
  timeline: TimelineSnapshots;
  messages: Set<string>;
  queue: Promise<void>;
  prompt?: { id: string; resolved: boolean };
}

export function createZCodeProvider(
  bridgeFactory: BridgeFactory = createHost,
  persistenceStore = new SessionPersistenceStore(),
): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    description:
      "ZCode workspace agent with native planning, tools, and model selection",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION))
        throw new Error("ZCode requires provider protocol version 1");
      return new ZCodeConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        bridgeFactory,
        persistenceStore,
      );
    },
  };
}

export class ZCodeConnection implements ProviderConnection {
  readonly version = PROVIDER_PROTOCOL_VERSION;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly opening = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly hosts = new Set<HostBridge>();
  private readonly abort = new AbortController();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    readonly capabilities: readonly string[],
    private readonly bridgeFactory: BridgeFactory,
    private readonly persistenceStore: SessionPersistenceStore,
  ) {}

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    if (this.closed) throw new Error("ZCode connection is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(raw: ProviderInput): Promise<void> {
    if (this.closed) throw new Error("ZCode connection is closed");
    const input = ProviderInputSchema.parse(raw);
    requireProviderCapabilities(this.capabilities, input);
    if (input.type === "session.open") {
      if (
        this.sessions.has(input.sessionId) ||
        this.opening.has(input.sessionId)
      )
        throw new Error("Duplicate ZCode session ID");
      this.opening.add(input.sessionId);
    }
    if (input.type === "session.prompt") {
      const entry = this.requireSession(input.sessionId);
      if (entry.messages.has(input.prompt.clientMessageId))
        throw new Error("Duplicate ZCode clientMessageId");
      entry.messages.add(input.prompt.clientMessageId);
    }
    const entry =
      input.type === "session.prompt" || input.type === "session.configure"
        ? this.requireSession(input.sessionId)
        : undefined;
    const operation = entry
      ? entry.queue.then(() => this.dispatch(input))
      : this.dispatch(input);
    if (entry) entry.queue = operation.catch(() => undefined);
    const job = operation
      .catch((error: unknown) => {
        if (input.type === "session.prompt") {
          const entry = this.sessions.get(input.sessionId);
          if (
            entry?.prompt?.id === input.prompt.clientMessageId &&
            entry.prompt.resolved
          )
            return;
          if (entry?.prompt?.id === input.prompt.clientMessageId)
            entry.prompt.resolved = true;
          this.emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "failed", error: publicError(error) },
          });
        } else if ("requestId" in input) {
          this.emit({
            type: "request.failed",
            requestId: input.requestId,
            error: publicError(error),
          });
        } else {
          // Permission send has no request ID; fail and close the native runtime too.
          const entry = this.sessions.get(input.sessionId);
          if (entry)
            entry.native.runtimeFailed(
              error instanceof AdapterError
                ? error
                : new AdapterError(
                    "NATIVE_PROTOCOL_ERROR",
                    "ZCode permission response failed",
                  ),
            );
          else
            this.emit({
              type: "session.runtime_failed",
              sessionId: input.sessionId,
              error: publicError(error),
            });
        }
      })
      .finally(() => {
        this.jobs.delete(job);
        if (input.type === "session.open") this.opening.delete(input.sessionId);
      });
    this.jobs.add(job);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    this.closing = this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    // Closing the transport rejects pending RPCs and releases turns awaiting a terminal event.
    for (const entry of this.sessions.values()) entry.native.runtimeFailed();
    await Promise.allSettled([
      ...[...this.sessions.keys()].map((id) => this.closeSession(id)),
      ...[...this.hosts].map((host) => host.close()),
    ]);
    await Promise.allSettled([...this.jobs]);
    this.listeners.clear();
  }

  private async host(
    env: Readonly<Record<string, string>>,
  ): Promise<HostBridge> {
    const host = await this.bridgeFactory(env, this.abort.signal);
    if (this.closed) {
      await host.close();
      throw new Error("ZCode connection is closed");
    }
    this.hosts.add(host);
    return host;
  }

  private async dispatch(input: ProviderInput): Promise<void> {
    if (input.type === "catalog" || input.type === "sessions") {
      if (input.type === "sessions" && !input.cwd)
        throw new AdapterError(
          "INVALID_WORKSPACE",
          "ZCode session listing requires a workspace",
        );
      const cwd = await resolveWorkspace(input.cwd ?? homedir());
      const host = await this.host({});
      try {
        const settings = await initializeWorkspace(host, cwd);
        if (input.type === "catalog") {
          const models = catalogModels(settings);
          this.emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models,
              modes: ZCODE_MODES,
              defaultModel: models.find((model) => model.isDefault)?.id,
              defaultMode:
                settings.mode.current === "plan"
                  ? "build"
                  : settings.mode.current,
            },
          });
        } else {
          const rows = await host.request(
            "listSessions",
            { workspacePath: cwd, includeArchived: false },
            SessionListSchema,
          );
          const sessions = rows
            .map((row) => {
              if (row.workspace.workspacePath !== cwd)
                throw new AdapterError(
                  "INVALID_WORKSPACE",
                  "ZCode returned a session from another workspace",
                );
              return {
                persistence: {
                  version: 2,
                  data: { kind: "native", sessionId: row.sessionId, cwd },
                },
                cwd,
                title: row.title,
                ...(row.updatedAt === undefined
                  ? {}
                  : { updatedAt: new Date(row.updatedAt).toISOString() }),
              };
            })
            .filter(
              (row) =>
                !input.query ||
                (row.title ?? "")
                  .toLowerCase()
                  .includes(input.query.toLowerCase()),
            )
            .slice(0, input.limit);
          this.emit({ type: "sessions", requestId: input.requestId, sessions });
        }
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      return;
    }
    if (input.type === "session.open") return this.openSession(input);
    if (
      input.type === "session.archive" ||
      input.type === "session.unarchive" ||
      input.type === "session.revert"
    )
      throw new Error("Unsupported ZCode operation");
    const entry = this.requireSession(input.sessionId);
    switch (input.type) {
      case "session.prompt": {
        if (entry.prompt && !entry.prompt.resolved)
          throw new AdapterError(
            "SESSION_BUSY",
            "ZCode is accepting another prompt",
          );
        const prompt = input.prompt.input;
        if (
          prompt.type === "command" &&
          !(await entry.native.listCommands()).some(
            (command) => command.name === prompt.name,
          )
        )
          throw new Error("Unknown ZCode command");
        // ZCode desktop implements /plan as setMode plus an optional task.
        // sendPrompt does not interpret this shortcut; forwarding it asks the model.
        const text =
          prompt.type === "message" && prompt.content[0]?.type === "text"
            ? prompt.content[0].text.trim()
            : undefined;
        const planTask =
          prompt.type === "command" && prompt.name === "plan"
            ? prompt.arguments.trim()
            : (text?.match(/^\/plan(?:\s+([\s\S]*))?$/)?.[1]?.trim() ??
              (text === "/plan" ? "" : undefined));
        if (planTask !== undefined) {
          if (prompt.type === "message" && prompt.content.length !== 1)
            throw new AdapterError(
              "INVALID_CONFIGURATION",
              "The /plan shortcut requires text without attachments",
            );
          await entry.native.configureMode(undefined, true);
          if (!planTask) {
            this.emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "completed" },
            });
            return;
          }
        }
        entry.prompt = { id: input.prompt.clientMessageId, resolved: false };
        await entry.native.startTurn(
          planTask ??
            (prompt.type === "command"
              ? `/${prompt.name}${prompt.arguments ? ` ${prompt.arguments}` : ""}`
              : prompt.content),
          {
            clientMessageId: input.prompt.clientMessageId,
            beforeSend: async () => {
              if (!entry.submitted) {
                await this.persistenceStore.save(
                  entry.persistence,
                  entry.native.id,
                );
                entry.submitted = true;
              }
            },
          },
        );
        return;
      }
      case "session.configure": {
        const settings = settingsSchema.parse(input.changes.settings ?? {});
        if (
          input.changes.mode !== undefined &&
          !ZCODE_MODES.some((mode) => mode.id === input.changes.mode)
        )
          throw new AdapterError(
            "INVALID_CONFIGURATION",
            "ZCode editing mode must be build, edit, or yolo",
          );
        if (input.changes.model !== undefined)
          await entry.native.setModel(input.changes.model);
        if (input.changes.thinkingOption !== undefined)
          await entry.native.setThinkingOption(input.changes.thinkingOption);
        if (
          input.changes.mode !== undefined ||
          settings.plan_mode !== undefined
        )
          await entry.native.configureMode(
            input.changes.mode,
            settings.plan_mode,
          );
        this.emitConfig(input.sessionId, entry);
        break;
      }
      case "session.interrupt":
        await entry.native.interrupt();
        break;
      case "session.permission":
        await entry.native.respondToPermission(
          input.permissionId,
          input.response,
        );
        return;
      case "session.close":
        await this.closeSession(input.sessionId);
        this.emit({ type: "session.closed", sessionId: input.sessionId });
        return;
    }
    this.emit({ type: "request.completed", requestId: input.requestId });
  }

  private async openSession(
    input: Extract<ProviderInput, { type: "session.open" }>,
  ): Promise<void> {
    const config = input.config;
    optionsSchema.parse(config.providerOptions ?? {});
    const settings = settingsSchema.parse(config.settings);
    if (
      config.mode !== undefined &&
      !ZCODE_MODES.some((mode) => mode.id === config.mode)
    )
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode editing mode must be build, edit, or yolo",
      );
    if (config.systemPrompt?.trim())
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "Custom system prompts are unsupported by the verified ZCode host",
      );
    if (!config.persist)
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "The verified ZCode host requires persistent sessions",
      );
    const cwd = await resolveWorkspace(config.cwd);
    const persistence = input.persistence
      ? parsePersistence(input.persistence)
      : { kind: "logical" as const, id: randomUUID(), cwd };
    if (persistence.cwd !== cwd)
      throw new AdapterError(
        "INVALID_WORKSPACE",
        "ZCode persistence belongs to another workspace",
      );
    const nativeId = await this.persistenceStore.resolve(persistence);
    const host = await this.host(config.env);
    let native: ZCodeSession | undefined;
    try {
      await initializeWorkspace(host, cwd);
      const snapshot = await host.request(
        nativeId ? "resumeSession" : "createSession",
        {
          workspacePath: cwd,
          ...(nativeId ? { sessionId: nativeId } : { persistence: "deferred" }),
          mcpServers: mapMcpServers(config.mcpServers),
        },
        SessionSnapshotSchema,
        60000,
      );
      if (nativeId && snapshot.session.sessionId !== nativeId)
        throw new Error("ZCode resumed a different session");
      native = await ZCodeSession.create({
        bridge: host,
        logger,
        workspace: cwd,
        snapshot,
        onClose() {},
      });
      await native.applyInitialConfig({
        ...config,
        settings: {
          ...settings,
          plan_mode:
            settings.plan_mode ??
            (nativeId ? snapshot.settings.mode.current === "plan" : false),
        },
      });
      if (this.closed) throw new Error("ZCode connection is closed");
      const entry: SessionEntry = {
        native,
        persistence,
        submitted: nativeId !== undefined,
        bridge: host,
        unsubscribe() {},
        unsubscribeFailure() {},
        timeline: new TimelineSnapshots(),
        messages: new Set(),
        queue: Promise.resolve(),
      };
      this.sessions.set(input.sessionId, entry);
      this.emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: this.capabilities,
        restoration: "core",
        persistence: persistenceHandle(persistence),
        cwd,
        title: config.title ?? snapshot.session.title,
      });
      this.emitConfig(input.sessionId, entry);
      if (input.history === "replay")
        for (const item of native.historyItems())
          this.emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: entry.timeline.replay(item),
          });
      entry.unsubscribe = native.subscribe((event) =>
        this.accept(input.sessionId, entry, event),
      );
      entry.unsubscribeFailure = host.onFailure(() => native!.runtimeFailed());
      if (!this.sessions.has(input.sessionId))
        throw new AdapterError(
          "NATIVE_EXITED",
          "ZCode disconnected during session open",
        );
      for (const request of native.getPendingPermissions())
        this.emit({
          type: "session.permission",
          sessionId: input.sessionId,
          request,
        });
      this.emit({
        type: "session.ready",
        requestId: input.requestId,
        sessionId: input.sessionId,
      });
    } catch (error) {
      this.sessions.delete(input.sessionId);
      try {
        await native?.close();
      } finally {
        this.hosts.delete(host);
        await host.close();
      }
      throw error;
    }
  }

  private emitConfig(id: string, entry: SessionEntry): void {
    this.emit({
      type: "session.config",
      sessionId: id,
      config: entry.native.getConfig(),
    });
    this.emit({
      type: "session.commands",
      sessionId: id,
      commands: entry.native.listCommands(),
    });
  }

  private accept(
    id: string,
    entry: SessionEntry,
    event: NativeSessionEvent,
  ): void {
    switch (event.type) {
      case "timeline":
        this.emit({
          type: "timeline.item",
          sessionId: id,
          item: entry.timeline.live(event.item, event.turnId),
        });
        break;
      case "usage_updated":
        this.emit({
          type: "session.usage",
          sessionId: id,
          turnId: event.turnId,
          usage: event.usage,
        });
        break;
      case "turn_started":
        if (!entry.prompt) throw new Error("ZCode started an unrequested turn");
        entry.prompt.resolved = true;
        this.emit({
          type: "session.prompt_result",
          sessionId: id,
          clientMessageId: entry.prompt.id,
          result: { type: "turn", turnId: event.turnId },
        });
        this.emit({
          type: "session.turn",
          sessionId: id,
          turnId: event.turnId,
          state: "started",
        });
        break;
      case "turn_completed":
      case "turn_canceled":
        this.emit({
          type: "session.turn",
          sessionId: id,
          turnId: event.turnId,
          state: event.type === "turn_completed" ? "completed" : "canceled",
        });
        break;
      case "turn_failed":
        if (event.turnId)
          this.emit({
            type: "session.turn",
            sessionId: id,
            turnId: event.turnId,
            state: "failed",
            error: { code: event.code, message: "ZCode turn failed" },
          });
        break;
      case "runtime_failed": {
        this.emit({
          type: "session.runtime_failed",
          sessionId: id,
          error: { code: event.code, message: "ZCode session failed" },
        });
        if (this.sessions.get(id) !== entry) break;
        const cleanup = this.closeSession(id)
          .catch(() => undefined)
          .finally(() => this.jobs.delete(cleanup));
        this.jobs.add(cleanup);
        break;
      }
      case "permission_requested":
        this.emit({
          type: "session.permission",
          sessionId: id,
          request: event.request,
        });
        break;
      case "permission_resolved":
        this.emit({
          type: "session.permission_resolved",
          sessionId: id,
          permissionId: event.requestId,
        });
        break;
      case "config_changed":
        this.emitConfig(id, entry);
        break;
    }
  }

  private requireSession(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry)
      throw new AdapterError("SESSION_NOT_FOUND", "Unknown ZCode session");
    return entry;
  }

  private async closeSession(id: string): Promise<void> {
    const entry = this.requireSession(id);
    this.sessions.delete(id);
    try {
      await entry.native.close();
    } finally {
      entry.unsubscribe();
      entry.unsubscribeFailure();
      this.hosts.delete(entry.bridge);
      await entry.bridge.close();
    }
  }

  private emit(event: ProviderEvent): void {
    if (this.closed) return;
    const valid = ProviderEventSchema.parse(event);
    for (const listener of this.listeners) listener(valid);
  }
}

function publicError(error: unknown): ProviderError {
  const persistenceMessages: Record<string, string> = {
    PERSISTENCE_VERSION_UNSUPPORTED:
      "ZCode persistence version is unsupported. Import the saved conversation from the session list.",
    PERSISTENCE_INVALID:
      "ZCode resume information is unreadable or invalid. No replacement conversation was created.",
    PERSISTENCE_WRITE_FAILED:
      "ZCode resume information could not be saved. The prompt was not sent.",
  };
  return {
    code: error instanceof AdapterError ? error.code : "INVALID_CONFIGURATION",
    message:
      error instanceof AdapterError
        ? (persistenceMessages[error.code] ??
          `ZCode operation failed (${error.code})`)
        : "Invalid ZCode provider request",
  };
}
