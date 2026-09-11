import { describe, expect, it } from "vitest";
import { Conversation } from "./conversation.js";

function snapshot() {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: "f1",
    logicalFrameOrdinal: 1,
    topic: "conversation/s",
    subscriptionId: "sub",
    frame: {
      topic: "conversation/s",
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 0,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          sessionId: "s",
          logEpoch: "epoch",
          seq: 0,
          revision: 0,
          control: { phase: "draft", canStop: false },
          queue: { autoDrain: true, items: [] },
        },
      },
    },
  };
}
function delta() {
  const initial = snapshot();
  return {
    ...initial,
    logicalFrameId: "f2",
    logicalFrameOrdinal: 2,
    deliveryKind: "online",
    frame: {
      ...initial.frame,
      fromSeq: 0,
      toSeq: 5,
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              revision: 2,
              control: { phase: "running", canStop: true },
            },
          },
          {
            op: "row.appended",
            row: { kind: "assistantText", rowId: 1, text: "hi" },
          },
          { op: "row.delta", rowId: 1, path: "text", append: "there" },
        ],
      },
    },
  };
}
it("applies V4 exclusive fromSeq ranges and queue/control projections", () => {
  const conversation = new Conversation("s");
  expect(conversation.idle).toBe(false);
  conversation.accept(snapshot());
  expect(conversation.idle).toBe(true);
  conversation.accept(delta());
  expect(conversation.state).toMatchObject({
    seq: 5,
    revision: 2,
    control: { phase: "running" },
  });
  expect(conversation.idle).toBe(false);
});
it.each([
  "session",
  "subscription",
  "sequence",
  "duplicate",
  "control",
  "queue",
])("rejects invalid %s state", (what) => {
  const conversation = new Conversation("s");
  conversation.accept(snapshot());
  const frame = delta();
  if (what === "session") frame.topic = "conversation/other";
  if (what === "subscription") frame.subscriptionId = "other";
  if (what === "sequence") frame.frame.fromSeq = 7;
  if (what === "duplicate") frame.logicalFrameOrdinal = 1;
  if (what === "control")
    frame.frame.payload.deltas[0]!.patch!.control!.phase = "unknown";
  if (what === "queue")
    Object.assign(frame.frame.payload.deltas[0]!.patch!, {
      queue: { autoDrain: true, items: [{ sourceCommandId: "unknown" }] },
    });
  expect(() => conversation.accept(frame)).toThrow();
});
function fragments() {
  const initial = snapshot();
  const bytes = Buffer.from(JSON.stringify(initial.frame));
  // Independently calculated standard CRC32 test fixture.
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const checksum = ((crc ^ -1) >>> 0).toString(16).padStart(8, "0");
  return [bytes.subarray(0, 31), bytes.subarray(31)].map(
    (part, fragmentIndex) => ({
      ...initial,
      frame: undefined,
      kind: "fragment",
      fragmentIndex,
      fragmentCount: 2,
      logicalBytes: bytes.length,
      checksum: { algorithm: "crc32", value: checksum },
      dataBase64: part.toString("base64"),
    }),
  );
}
it("reassembles fragments before applying the native snapshot", () => {
  const conversation = new Conversation("s");
  const parts = fragments();
  expect(conversation.accept(parts[0])).toBe(false);
  expect(conversation.state).toBeUndefined();
  expect(conversation.accept(parts[1])).toBe(true);
  expect(conversation.idle).toBe(true);
});
describe("fragment corruption", () => {
  it.each(["order", "checksum", "size", "interleaved"])(
    "rejects %s",
    (kind) => {
      const conversation = new Conversation("s");
      const parts = fragments();
      conversation.accept(parts[0]);
      if (kind === "order") parts[1]!.fragmentIndex = 0;
      if (kind === "checksum")
        parts[1]!.dataBase64 = Buffer.alloc(
          Buffer.from(parts[1]!.dataBase64, "base64").length,
        ).toString("base64");
      if (kind === "size") parts[1]!.logicalBytes++;
      expect(() =>
        conversation.accept(kind === "interleaved" ? snapshot() : parts[1]),
      ).toThrow();
    },
  );
});
