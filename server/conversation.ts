import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AdapterError } from "./errors.js";
import type { HostBridge } from "./host/bridge.js";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const Delivery = z.enum(["startNow", "queue", "guide"]);
export const CommandAckSchema = z
  .object({
    commandId: id,
    status: z.enum([
      "accepted",
      "duplicate",
      "noop",
      "stale",
      "failed",
      "rejected",
    ]),
    revisionAtDecision: count,
    reasonCode: z.string().optional(),
    result: z
      .object({
        type: id,
        inputId: id.optional(),
        delivery: Delivery.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const QueueItem = z
  .object({
    sourceCommandId: id,
    queueItemId: id,
    clientId: id,
    delivery: z
      .object({
        requested: z.enum(["auto", "startNow", "queue", "guide"]),
        admitted: Delivery,
      })
      .passthrough(),
    dispatch: z
      .object({
        state: z.enum([
          "admitted",
          "queued",
          "reserved",
          "promoting",
          "drained",
        ]),
      })
      .passthrough(),
  })
  .passthrough();
const Control = z
  .object({
    phase: z.enum([
      "draft",
      "prewarming",
      "running",
      "completedSuccess",
      "completedInterrupted",
      "error",
    ]),
    canStop: z.boolean(),
  })
  .passthrough();
const Queue = z
  .object({ autoDrain: z.boolean(), items: z.array(QueueItem) })
  .passthrough();
const State = z
  .object({
    sessionId: id,
    logEpoch: id,
    seq: count,
    revision: count,
    control: Control,
    queue: Queue,
  })
  .passthrough();
const Patch = z
  .object({
    revision: count.optional(),
    control: Control.optional(),
    queue: Queue.optional(),
  })
  .passthrough();
const Delta = z.discriminatedUnion("op", [
  z.object({ op: z.literal("state.updated"), patch: Patch }),
  z.object({ op: z.enum(["row.appended", "row.upserted"]), row: z.unknown() }),
  z.object({ op: z.literal("row.removed"), fromRowId: count }),
  z.object({
    op: z.literal("row.delta"),
    rowId: count,
    path: z.string(),
    append: z.string(),
  }),
]);
const Frame = z.object({
  topic: id,
  subscriptionId: id,
  fromSeq: count,
  toSeq: count,
  sentAt: z.number(),
  payload: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("snapshot"), snapshot: State }),
    z.object({ kind: z.literal("deltas"), deltas: z.array(Delta) }),
  ]),
});
const WireBase = z.object({
  wireVersion: z.literal(3),
  deliveryKind: z.enum(["initial", "online", "recovery"]),
  logicalFrameId: id,
  logicalFrameOrdinal: count,
  topic: id,
  subscriptionId: id,
});
export const ConversationWireSchema = z.discriminatedUnion("kind", [
  WireBase.extend({ kind: z.literal("complete"), frame: Frame }),
  WireBase.extend({
    kind: z.literal("fragment"),
    fragmentIndex: count,
    fragmentCount: z.number().int().min(1).max(1024),
    logicalBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    checksum: z.object({
      algorithm: z.literal("crc32"),
      value: z.string().regex(/^[0-9a-f]{8}$/),
    }),
    dataBase64: z.string(),
  }),
]);
type Wire = z.infer<typeof ConversationWireSchema>;
export type ConversationState = z.infer<typeof State>;

function invalid(message: string): never {
  throw new AdapterError("NATIVE_PROTOCOL_ERROR", message);
}

/** The host owns the queue. This projection only observes its native V4 frames. */
export class Conversation {
  state?: ConversationState;
  private subscriptionId?: string;
  private ordinal = 0;
  private assembly?: {
    wire: Extract<Wire, { kind: "fragment" }>;
    parts: Buffer[];
    bytes: number;
  };
  constructor(private readonly sessionId: string) {}

  accept(raw: unknown): boolean {
    const wire = ConversationWireSchema.parse(raw);
    if (wire.topic !== `conversation/${this.sessionId}`)
      invalid("Conversation belongs to another session");
    if (this.subscriptionId && wire.subscriptionId !== this.subscriptionId)
      invalid("Conversation subscription changed");
    this.subscriptionId = wire.subscriptionId;
    if (wire.logicalFrameOrdinal <= this.ordinal)
      invalid("Conversation frame is duplicated or out of order");
    let frame: z.infer<typeof Frame>;
    if (wire.kind === "fragment") {
      this.assembly ??= { wire, parts: [], bytes: 0 };
      const a = this.assembly;
      if (
        wire.logicalFrameId !== a.wire.logicalFrameId ||
        wire.logicalFrameOrdinal !== a.wire.logicalFrameOrdinal ||
        wire.fragmentCount !== a.wire.fragmentCount ||
        wire.logicalBytes !== a.wire.logicalBytes ||
        wire.checksum.value !== a.wire.checksum.value ||
        wire.fragmentIndex !== a.parts.length
      )
        invalid("Conversation fragments are inconsistent");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          wire.dataBase64,
        )
      )
        invalid("Invalid conversation fragment encoding");
      const part = Buffer.from(wire.dataBase64, "base64");
      a.parts.push(part);
      a.bytes += part.length;
      if (a.bytes > wire.logicalBytes)
        invalid("Conversation fragment size exceeded");
      if (a.parts.length < wire.fragmentCount) return false;
      const bytes = Buffer.concat(a.parts);
      if (a.bytes !== wire.logicalBytes || crc32(bytes) !== wire.checksum.value)
        invalid("Conversation fragment checksum mismatch");
      frame = Frame.parse(JSON.parse(bytes.toString("utf8")));
      this.assembly = undefined;
    } else {
      if (this.assembly)
        invalid("Conversation fragment assembly was interrupted");
      frame = wire.frame;
    }
    if (
      frame.topic !== wire.topic ||
      frame.subscriptionId !== wire.subscriptionId ||
      frame.toSeq < frame.fromSeq
    )
      invalid("Conversation frame identity is invalid");
    if (frame.payload.kind === "snapshot") {
      const state = frame.payload.snapshot;
      if (
        state.sessionId !== this.sessionId ||
        frame.fromSeq !== 0 ||
        state.seq !== frame.toSeq
      )
        invalid("Conversation snapshot is inconsistent");
      this.state = state;
    } else {
      if (!this.state || frame.fromSeq !== this.state.seq)
        invalid("Conversation delta sequence has a gap");
      for (const delta of frame.payload.deltas) {
        if (delta.op === "state.updated")
          this.state = State.parse({ ...this.state, ...delta.patch });
      }
      this.state.seq = frame.toSeq;
    }
    this.ordinal = wire.logicalFrameOrdinal;
    return true;
  }

  get idle(): boolean {
    return (
      !!this.state &&
      !this.state.control.canStop &&
      this.state.control.phase !== "running" &&
      this.state.control.phase !== "prewarming" &&
      this.state.queue.items.length === 0
    );
  }
}

function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
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
  const ack = await bridge.request(
    "sendConversationCommandV4",
    {
      workspacePath,
      sessionId,
      envelope: {
        commandId,
        clientId: "paseo-zcode-provider",
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        ...(options.revision === undefined
          ? {}
          : { baseRevision: options.revision }),
      },
    },
    CommandAckSchema,
    60_000,
    { sessionId, inputId: commandId },
  );
  if (ack.commandId !== commandId)
    invalid("ZCode acknowledged another command");
  return ack;
}
