import { randomUUID } from "node:crypto";
import { applyConversationDeltas } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/apply.js";
import { TopicWireFrameAssembler } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/wire-assembler.js";
import {
  commandAckSchema,
  parseCommandEnvelope,
} from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/command.js";
import {
  conversationTopicFrameSchema,
  v4ConversationResyncResultSchema,
  v4ConversationRowsRangeResultSchema,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
} from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/transport.js";
import type { ConversationSnapshot } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import type { ConversationRow } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";
import type { HostBridge, HostSubscription } from "./host/bridge.js";
import { AdapterError } from "./errors.js";
export type ConversationState = ConversationSnapshot;

/** One authoritative V4 state. No legacy session events participate in it. */
export class Conversation {
  state?: ConversationSnapshot;
  private subscription?: HostSubscription;
  private readonly assembler = new TopicWireFrameAssembler(
    conversationTopicFrameSchema,
  );
  private expiry?: ReturnType<typeof setTimeout>;
  private recovery?: Promise<void>;
  private recovering = false;
  private hydrating = false;
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private failure?: unknown;
  constructor(
    private readonly bridge: HostBridge,
    private readonly workspacePath: string,
    private readonly sessionId: string,
    private readonly onFailure: (error: unknown) => void,
  ) {}
  async open(): Promise<void> {
    const early: ConversationTopicWireCandidate[] = [];
    this.subscription = await this.bridge.subscribe(
      { workspacePath: this.workspacePath, sessionId: this.sessionId },
      (frame) => {
        if (this.subscription) this.accept(frame);
        else early.push(frame);
      },
    );
    for (const frame of early) this.accept(frame);
    await this.waitFor(() => this.state !== undefined && !this.recovering);
    await this.loadHistory();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const waiter of this.waiters) waiter();
    if (!this.hydrating) for (const listener of this.listeners) listener();
  }
  private fail(error: unknown): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.changed();
    this.onFailure(error);
  }
  accept(wire: ConversationTopicWireCandidate): void {
    if (
      this.closed ||
      wire.subscriptionId !== this.subscription?.id ||
      wire.topic !== `conversation/${this.sessionId}`
    )
      return;
    for (const event of this.assembler.accept(wire)) {
      if (event.kind === "fault") {
        if (event.fault.deliveryKind === "recovery")
          this.fail(
            new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "ZCode recovery frame is invalid",
            ),
          );
        else this.resync();
        continue;
      }
      if (this.recovering && event.deliveryKind !== "recovery") continue;
      this.apply(event.frame, event.deliveryKind === "recovery");
    }
    this.scheduleExpiry();
  }
  private apply(frame: ConversationTopicFrame, recovery: boolean): void {
    if (frame.payload.kind === "snapshot") {
      const snapshot = frame.payload.snapshot;
      if (
        snapshot.sessionId !== this.sessionId ||
        snapshot.seq !== frame.toSeq ||
        frame.fromSeq !== 0
      ) {
        this.resync();
        return;
      }
      if (
        this.state &&
        !recovery &&
        (snapshot.logEpoch !== this.state.logEpoch ||
          snapshot.seq < this.state.seq)
      ) {
        this.resync();
        return;
      }
      this.state = snapshot;
      this.recovering = false;
    } else {
      if (!this.state || frame.fromSeq !== this.state.seq) {
        this.resync();
        return;
      }
      if (frame.toSeq < frame.fromSeq) {
        this.resync();
        return;
      }
      this.state = {
        ...applyConversationDeltas(this.state, frame.payload.deltas),
        seq: frame.toSeq,
      };
    }
    this.changed();
  }
  private scheduleExpiry(): void {
    clearTimeout(this.expiry);
    const expiry = this.assembler.nextExpiryAt;
    if (expiry === null) return;
    this.expiry = setTimeout(
      () => {
        if (this.assembler.expire().length) this.resync();
        this.scheduleExpiry();
      },
      Math.max(1, expiry - Date.now()),
    );
    this.expiry.unref();
  }
  private resync(): void {
    if (this.closed || this.recovery) return;
    this.recovering = true;
    this.hydrating = true;
    this.recovery = (async () => {
      await this.bridge.request(
        "resyncConversationV4",
        {
          workspacePath: this.workspacePath,
          subscriptionId: this.subscription!.id,
          base: null,
          forceSnapshot: true,
        },
        v4ConversationResyncResultSchema,
      );
      await this.waitFor(() => !this.recovering);
      await this.loadHistory();
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.recovery = undefined;
        this.hydrating = false;
        this.changed();
      });
  }
  async loadHistory(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = this.state!;
      let beforeRowId: number | undefined;
      const rows = new Map<number, ConversationRow>();
      let consistent = true;
      do {
        const page = await this.bridge.request(
          "conversationRowsRangeV4",
          {
            workspacePath: this.workspacePath,
            sessionId: this.sessionId,
            limit: 200,
            ...(beforeRowId === undefined ? {} : { beforeRowId }),
          },
          v4ConversationRowsRangeResultSchema,
        );
        if (
          page.atLogEpoch !== base.logEpoch ||
          page.atRevision !== base.revision ||
          page.atSeq !== base.seq ||
          this.state?.logEpoch !== base.logEpoch ||
          this.state?.seq !== base.seq
        ) {
          consistent = false;
          break;
        }
        for (const row of page.rows) rows.set(row.rowId, row);
        if (!page.hasMore) break;
        const next = page.rows[0]?.rowId;
        if (
          next === undefined ||
          (beforeRowId !== undefined && next >= beforeRowId)
        )
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode history cursor did not advance",
          );
        beforeRowId = next;
      } while (!this.closed);
      if (this.closed) return;
      if (consistent) {
        this.state = {
          ...base,
          rows: {
            ...base.rows,
            window: [...rows.values()].sort((a, b) => a.rowId - b.rowId),
          },
        };
        this.changed();
        return;
      }
    }
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode history changed during pagination; no mixed history was published",
    );
  }
  get idle(): boolean {
    const c = this.state?.control;
    return (
      !!c &&
      !this.recovering &&
      !this.hydrating &&
      !c.canStop &&
      c.activeWorks.length === 0 &&
      c.phase !== "running" &&
      c.phase !== "prewarming" &&
      this.state!.queue.items.length === 0
    );
  }
  waitFor(predicate: () => boolean): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new AdapterError(
            "NATIVE_TIMEOUT",
            "ZCode did not confirm the requested state",
          ),
        );
      }, 30_000);
      const off = () => this.waiters.delete(check);
      const check = () => {
        if (this.failure || this.closed || predicate()) {
          clearTimeout(timer);
          off();
          this.failure
            ? reject(this.failure)
            : this.closed
              ? reject(new AdapterError("NATIVE_EXITED", "Conversation closed"))
              : resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.expiry);
    this.assembler.clear();
    this.changed();
    await this.subscription?.dispose();
    this.listeners.clear();
  }
}
export async function conversationCommand(
  bridge: HostBridge,
  workspacePath: string,
  sessionId: string,
  type: string,
  payload: unknown,
  options: { commandId?: string; revision?: number } = {},
) {
  const commandId = options.commandId ?? randomUUID();
  const envelope = {
    commandId,
    clientId: "paseo-zcode-provider",
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
    ...(options.revision === undefined
      ? {}
      : { baseRevision: options.revision }),
  };
  const validated = parseCommandEnvelope(envelope);
  if (!validated.ok)
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "Invalid ZCode command",
      {},
      { cause: validated.error },
    );
  const ack = await bridge.request(
    "sendConversationCommandV4",
    { workspacePath, envelope },
    commandAckSchema,
    60_000,
    { sessionId, inputId: commandId },
  );
  if (ack.commandId !== commandId)
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode acknowledged a different command",
    );
  return ack;
}
