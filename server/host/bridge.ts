import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { once } from "node:events";
import { z } from "zod";

import { assertRuntimeSupported } from "../discovery/discover.js";
import type { DiscoveredRuntime } from "../discovery/types.js";
import { AdapterError } from "../errors.js";
import type { Logger } from "../logger.js";
import {
  ZCodeProtocolClient,
  type NativeTransport,
} from "../protocol/client.js";
import type { NativeNotification } from "../protocol/v1/schemas.js";
import {
  DynamicEventSchema,
  type DynamicEvent,
} from "../protocol/v1/host-schemas.js";
import { adaptHostRequest } from "./contract.js";
import { ZCODE_HOST_BRIDGE_SOURCE } from "./runtime-source.js";

const SubscriptionResponseSchema = z
  .object({ subscribed: z.literal(true) })
  .strict();
const UnsubscriptionResponseSchema = z
  .object({ unsubscribed: z.literal(true) })
  .strict();
const EventNotificationParamsSchema = z
  .object({ subscriptionId: z.string().min(1), event: DynamicEventSchema })
  .strict();

export interface HostSubscription {
  dispose(): Promise<void>;
}

export interface HostBridge {
  onFailure(listener: () => void): () => void;
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
    target: {
      workspacePath: string;
      sessionId: string;
      deliveryKind: "desktop-continuous";
      includeSnapshot: boolean;
    },
    handler: (event: DynamicEvent) => Promise<void> | void,
  ): Promise<HostSubscription>;
  close(): Promise<void>;
}

export class ZCodeHostBridge implements HostBridge {
  private readonly failures = new Set<() => void>();
  private failed = false;
  private readonly handlers = new Map<
    string,
    (event: DynamicEvent) => Promise<void> | void
  >();
  private readonly client: ZCodeProtocolClient;
  private closePromise: Promise<void> | undefined;
  private readonly exited: Promise<number>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    transport: NodeBridgeTransport,
    private readonly logger: Logger,
    private readonly runtime: DiscoveredRuntime,
  ) {
    this.client = new ZCodeProtocolClient(
      transport,
      logger,
      undefined,
      (notification) => this.handleNotification(notification),
      () => this.fail(),
    );
    this.client.start();
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal !== null) resolve(128);
        else resolve(code ?? 1);
      });
    });
    void drain(child.stderr).then(
      (byteCount) => {
        logger.log("debug", "zcode.host.stderr.closed", { byteCount });
      },
      () => this.fail(),
    );
  }

  static start(
    runtime: DiscoveredRuntime,
    logger: Logger,
    environment: NodeJS.ProcessEnv = process.env,
  ): ZCodeHostBridge {
    assertRuntimeSupported(runtime);
    const host = runtime.resolvedHost;
    if (host === undefined) {
      throw new AdapterError(
        "RUNTIME_DISCOVERY_FAILED",
        "Supported ZCode artifact has no resolved host contract",
      );
    }
    const child = spawn(
      runtime.paths.executable,
      ["-e", ZCODE_HOST_BRIDGE_SOURCE],
      {
        cwd: runtime.paths.installRoot,
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_ZCODE_HOST_INDEX: host.hostIndex,
          PASEO_ZCODE_HOST_RPC_MODULE: host.hostRpcModule,
          PASEO_ZCODE_HOST_ARTIFACT: JSON.stringify(host.artifact),
          PASEO_ZCODE_HOST_PROTOCOL: JSON.stringify(host.protocol),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const bridge = new ZCodeHostBridge(
      child,
      new NodeBridgeTransport(child),
      logger,
      runtime,
    );
    logger.log("info", "zcode.host.started", { hostPid: child.pid });
    void bridge.exited.then(
      (exitCode) => {
        if (!bridge.closePromise) bridge.fail();
        logger.log(exitCode === 0 ? "info" : "error", "zcode.host.exited", {
          hostPid: child.pid,
          exitCode,
        });
      },
      () => bridge.fail(),
    );
    return bridge;
  }

  onFailure(listener: () => void): () => void {
    this.failures.add(listener);
    if (this.failed) listener();
    return () => this.failures.delete(listener);
  }

  private fail(): void {
    if (this.failed || this.closePromise) return;
    this.failed = true;
    for (const listener of this.failures) listener();
  }

  request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    resultSchema: Schema,
    timeoutMs = 30_000,
    diagnosticContext?: {
      readonly sessionId: string;
      readonly inputId: string;
    },
  ): Promise<z.output<Schema>> {
    const contract = this.runtime.resolvedHost;
    if (contract === undefined) {
      throw new AdapterError(
        "RUNTIME_DISCOVERY_FAILED",
        "ZCode host artifact is unavailable",
      );
    }
    const adapted = adaptHostRequest(contract.protocol, method, params);
    return this.client.request(
      "__call",
      {
        service: adapted.service,
        method: adapted.method,
        params: adapted.params,
      },
      resultSchema,
      timeoutMs,
      diagnosticContext === undefined
        ? undefined
        : { operation: method, ...diagnosticContext },
    );
  }

  async subscribe(
    target: {
      workspacePath: string;
      sessionId: string;
      deliveryKind: "desktop-continuous";
      includeSnapshot: boolean;
    },
    handler: (event: DynamicEvent) => Promise<void> | void,
  ): Promise<HostSubscription> {
    const subscriptionId = randomUUID();
    this.handlers.set(subscriptionId, handler);
    try {
      await this.client.request(
        "__subscribe",
        { subscriptionId, target },
        SubscriptionResponseSchema,
      );
    } catch (error) {
      this.handlers.delete(subscriptionId);
      throw error;
    }
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        this.handlers.delete(subscriptionId);
        await this.client.request(
          "__unsubscribe",
          { subscriptionId },
          UnsubscriptionResponseSchema,
        );
      },
    };
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async handleNotification(
    notification: NativeNotification,
  ): Promise<void> {
    if (notification.method !== "event") {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported host notification: ${notification.method}`,
      );
    }
    const parsed = EventNotificationParamsSchema.parse(notification.params);
    const handler = this.handlers.get(parsed.subscriptionId);
    if (handler === undefined) {
      this.logger.log("debug", "zcode.host.event.after_unsubscribe", {
        subscriptionId: parsed.subscriptionId,
      });
      return;
    }
    await handler(parsed.event);
  }

  private async closeInternal(): Promise<void> {
    this.failures.clear();
    this.handlers.clear();
    await this.client.close();
    if (await waitForExit(this.exited, 4_000)) return;
    this.child.kill("SIGTERM");
    if (await waitForExit(this.exited, 2_000)) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

class NodeBridgeTransport implements NativeTransport {
  private closed = false;
  readonly readable: ReadableStream<Uint8Array>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  }

  async write(frame: string): Promise<void> {
    if (this.closed || !this.child.stdin.writable) {
      throw new AdapterError("NATIVE_EXITED", "ZCode host stdin is closed");
    }
    if (!this.child.stdin.write(frame, "utf8")) {
      await once(this.child.stdin, "drain");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
  }
}

async function drain(stream: NodeJS.ReadableStream): Promise<number> {
  let total = 0;
  for await (const chunk of stream) {
    total += Buffer.byteLength(chunk as Buffer);
  }
  return total;
}

async function waitForExit(
  exited: Promise<number>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
