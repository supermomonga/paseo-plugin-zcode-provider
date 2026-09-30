import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import {
  CancellationTokenSource,
  Emitter,
} from "../vendor/zcode/packages/rpc/src/foundation.js";
import { VSBuffer } from "../vendor/zcode/packages/rpc/src/buffer.js";
import { SocketProtocol } from "../vendor/zcode/packages/rpc/src/protocol.js";
import { ChannelClient } from "../vendor/zcode/packages/rpc/src/channelClient.js";
import {
  helloMessageSchema,
  conversationTopicWireCandidateSchema,
  type ConversationTopicWireCandidate,
  v4ConversationSubscribeResultSchema,
} from "../vendor/zcode/packages/shared/src/zcode-protocol-v4/transport.js";
import {
  assertRuntimeSupported,
  runtimeEnvironment,
} from "../discovery/discover.js";
import type { DiscoveredRuntime } from "../discovery/types.js";
import { AdapterError } from "../errors.js";
import {
  diagnosticError,
  runtimeDiagnostic,
  type RuntimeDiagnostic,
} from "../diagnostics.js";
import type { Logger } from "../logger.js";
import { PROVIDER_VERSION } from "../build-info.js";

export interface HostSubscription {
  readonly id: string;
  dispose(): Promise<void>;
}
export interface HostBridge {
  readonly diagnostic: RuntimeDiagnostic;
  onFailure(listener: (error: AdapterError) => void): () => void;
  request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
    timeoutMs?: number,
    diagnosticContext?: {
      readonly sessionId: string;
      readonly inputId: string;
    },
  ): Promise<z.output<Schema>>;
  subscribe(
    target: { workspacePath: string; sessionId: string },
    handler: (frame: ConversationTopicWireCandidate) => Promise<void> | void,
  ): Promise<HostSubscription>;
  close(): Promise<void>;
}
const nativeViewSchema = z.object({
  revision: z.number(),
  providers: z.array(
    z.object({
      providerId: z.string(),
      providerName: z.string(),
      models: z.array(
        z.object({
          modelId: z.string(),
          config: z.object({
            optionSpecs: z.object({
              reasoningLevel: z.object({ values: z.array(z.string()) }),
            }),
          }),
        }),
      ),
    }),
  ),
  preferredSelection: z.unknown().optional(),
  effectiveSelection: z.unknown().optional(),
  selectionIssue: z.unknown().optional(),
});
function projectModelSelection(value: unknown) {
  const view = nativeViewSchema.parse(value);
  const { providers, ...selection } = view;
  return {
    ...selection,
    models: view.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        ref: { providerId: provider.providerId, modelId: model.modelId },
        label: model.modelId,
        providerLabel: provider.providerName,
        reasoningLevels: model.config.optionSpecs.reasoningLevel.values,
      })),
    ),
  };
}
export class ZCodeHostBridge implements HostBridge {
  private readonly failures = new Set<(error: AdapterError) => void>();
  private failure?: AdapterError;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;
  private client?: ChannelClient;
  private protocol?: SocketProtocol;
  private readonly ready: Promise<void>;
  private readonly subscriptions = new Set<HostSubscription>();
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly runtime: DiscoveredRuntime,
    private readonly logger: Logger,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("error", () => resolve());
      child.once("exit", (code) => {
        resolve();
        if (!this.closing)
          this.fail(
            new AdapterError(
              "NATIVE_EXITED",
              "ZCode Server exited",
              {},
              {},
              { ...this.diagnostic, exitCode: code ?? 1 },
            ),
          );
      });
    });
    child.stderr.resume(); // Never log raw native output: it may contain credentials or prompts.
    child.stdin.on("error", () =>
      this.fail(new AdapterError("NATIVE_EXITED", "ZCode Server input closed")),
    );
    this.ready = this.initialize();
    void this.ready.catch((error) => this.fail(error));
  }
  static start(
    runtime: DiscoveredRuntime,
    logger: Logger,
    environment: NodeJS.ProcessEnv = process.env,
    workspace = runtime.paths.installRoot,
  ): ZCodeHostBridge {
    assertRuntimeSupported(runtime);
    const child = spawn(runtime.paths.executable, [runtime.paths.serverEntry], {
      cwd: workspace,
      env: {
        ...runtimeEnvironment(environment),
        ZCODE_SERVICE_AUTHORITY_MODE: "standalone-server",
        ZCODE_AGENT_SERVER_COMMAND: runtime.paths.executable,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
          runtime.paths.cliEntry,
          "app-server",
          "--stdio",
        ]),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new ZCodeHostBridge(child, runtime, logger);
  }
  private async initialize(): Promise<void> {
    const hello = await new Promise<unknown>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(
        () =>
          finish(
            new AdapterError(
              "NATIVE_TIMEOUT",
              "ZCode Server handshake timed out",
            ),
          ),
        10_000,
      );
      const exit = () =>
        finish(
          new AdapterError(
            "NATIVE_EXITED",
            "ZCode Server exited before handshake",
          ),
        );
      const finish = (error?: unknown, value?: unknown) => {
        clearTimeout(timer);
        this.child.stdout.off("data", data);
        this.child.off("exit", exit);
        this.child.off("error", finish);
        error ? reject(error) : resolve(value);
      };
      const data = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 64 * 1024) {
          finish(
            new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "ZCode Server handshake is too large",
            ),
          );
          return;
        }
        const end = buffer.indexOf(10);
        if (end < 0) return;
        this.child.stdout.pause();
        try {
          const parsed = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          finish(undefined, parsed);
          if (buffer.length > end + 1)
            this.child.stdout.unshift(buffer.subarray(end + 1));
        } catch {
          finish(
            new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "Invalid ZCode Server handshake",
            ),
          );
        }
      };
      this.child.stdout.on("data", data);
      this.child.once("exit", exit);
      this.child.once("error", finish);
    });
    const checked = z
      .object({
        type: z.literal("zcode-hello"),
        version: z.literal(this.runtime.identity.appVersion),
        platform: z.string(),
        arch: z.string(),
        pid: z.number().int().positive(),
      })
      .parse(hello);
    if (
      `${checked.platform}-${checked.arch}` !==
        this.runtime.identity.platform ||
      checked.pid !== this.child.pid
    )
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode Server runtime identity changed",
      );
    const onData = new Emitter<VSBuffer>(),
      onClose = new Emitter<void>(),
      onEnd = new Emitter<void>();
    this.protocol = new SocketProtocol({
      onData: onData.event,
      onClose: onClose.event,
      onEnd: onEnd.event,
      write: (buffer) => {
        if (!this.child.stdin.writable) throw new Error("Server input closed");
        this.child.stdin.write(Buffer.from(buffer.buffer));
      },
      end: () => this.child.stdin.end(),
      drain: async () => {
        if (this.child.stdin.writableNeedDrain)
          await once(this.child.stdin, "drain");
      },
      dispose: () => {
        onData.dispose();
        onClose.dispose();
        onEnd.dispose();
      },
    });
    this.client = new ChannelClient(this.protocol);
    this.child.stdout.on("data", (chunk) => {
      try {
        onData.fire(VSBuffer.wrap(chunk));
      } catch (error) {
        this.fail(error);
      }
    });
    this.child.stdout.resume();
    this.child.stdin.write(
      JSON.stringify({
        type: "zcode-hello-ack",
        version: PROVIDER_VERSION,
        clientId: "paseo-zcode-provider",
      }) + "\n",
    );
    const v4 = helloMessageSchema.parse(
      await this.call("zcode-agent", "helloConversationV4", undefined, 10_000),
    );
    if (
      v4.clientMode !== "desktop-continuous" ||
      v4.capabilities.independentPlanState !== true
    )
      throw new AdapterError(
        "UNSUPPORTED_ZCODE",
        "ZCode V4 conversation contract is unsupported",
      );
    await this.call(
      "zcode-agent",
      "initializeConversationV4",
      {
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "paseo-zcode-provider",
        appVersion: PROVIDER_VERSION,
      },
      10_000,
    );
    await this.call(
      "zcode-agent",
      "syncAppRuntimePreferences",
      { askUserQuestionAutoResolutionEnabled: false },
      10_000,
    );
  }
  get diagnostic(): RuntimeDiagnostic {
    return runtimeDiagnostic(this.runtime);
  }
  onFailure(listener: (error: AdapterError) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failures.delete(listener);
  }
  private fail(error: unknown): void {
    if (this.failure || this.closing) return;
    this.failure = diagnosticError(error, {
      ...this.diagnostic,
      stage: "transport",
    });
    this.client?.dispose();
    for (const listener of this.failures) listener(this.failure);
    void this.close();
  }
  private async call(
    channel: string,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.client)
      throw new AdapterError("NATIVE_EXITED", "ZCode RPC is unavailable");
    const cancellation = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.client
          .getChannel(channel)
          .call(
            method,
            params === undefined ? [] : [params],
            cancellation.token,
          ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new AdapterError("NATIVE_TIMEOUT", "ZCode RPC timed out"));
            cancellation.cancel();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      cancellation.dispose();
    }
  }
  async request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
    timeoutMs = 30_000,
  ): Promise<z.output<Schema>> {
    try {
      await this.ready;
      if (this.failure) throw this.failure;
      if (this.closing)
        throw new AdapterError("NATIVE_EXITED", "ZCode Server is closing");
      let result: unknown;
      if (method === "readModelSelection")
        result = projectModelSelection(
          await this.call("model-selection", "getView", params, timeoutMs),
        );
      else
        result = await this.call(
          method === "getEntitlementSnapshot" ||
            method === "getCodingPlanResetStatus"
            ? "usage-stats"
            : "zcode-agent",
          method,
          params,
          timeoutMs,
        );
      return resultSchema.parse(result);
    } catch (error) {
      throw diagnosticError(error, {
        ...this.diagnostic,
        stage: "request",
        operation: method,
      });
    }
  }
  async subscribe(
    target: { workspacePath: string; sessionId: string },
    handler: (frame: ConversationTopicWireCandidate) => Promise<void> | void,
  ): Promise<HostSubscription> {
    await this.ready;
    let disposed = false;
    const listener = this.client!.getChannel("zcode-agent").listen(
      "onDynamicConversationFrame",
      target,
    )((value: unknown) => {
      if (disposed) return;
      try {
        const frame = conversationTopicWireCandidateSchema.parse(value);
        if (frame.topic === `conversation/${target.sessionId}`)
          Promise.resolve(handler(frame)).catch((error) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
    });
    try {
      const result = await this.request(
        "subscribeConversationV4",
        target,
        v4ConversationSubscribeResultSchema,
      );
      const subscription: HostSubscription = {
        id: result.ack.subscriptionId,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          listener.dispose();
          this.subscriptions.delete(subscription);
          if (!this.closing && !this.failure)
            await this.request(
              "unsubscribeConversationV4",
              {
                workspacePath: target.workspacePath,
                subscriptionId: subscription.id,
              },
              z.void(),
            );
        },
      };
      this.subscriptions.add(subscription);
      return subscription;
    } catch (error) {
      disposed = true;
      listener.dispose();
      throw error;
    }
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.closeInternal());
    return this.closing;
  }
  private async closeInternal(): Promise<void> {
    this.failures.clear();
    for (const subscription of this.subscriptions) await subscription.dispose();
    this.client?.dispose();
    this.protocol?.dispose();
    this.child.stdin.end();
    if (await waitForExit(this.exited, 6_000)) return;
    this.child.kill("SIGTERM");
    if (await waitForExit(this.exited, 5_000)) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
async function waitForExit(
  exited: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
