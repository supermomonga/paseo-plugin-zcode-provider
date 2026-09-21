import { expect, it } from "vitest";
import { Conversation } from "./conversation.js";
import { FakeBridge, snapshot } from "../test/fake-host.js";
import { TopicWireFrameAssembler } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/wire-assembler.js";
import { conversationTopicFrameSchema } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/transport.js";
async function fixture() {
  const host = new FakeBridge(snapshot("/workspace"));
  const errors: unknown[] = [];
  const conversation = new Conversation(host, "/workspace", "session-1", (e) =>
    errors.push(e),
  );
  await conversation.open();
  return { host, conversation, errors };
}
it("uses official row delta semantics and ignores duplicate physical frames", async () => {
  const f = await fixture();
  await f.host.append({
    ...f.host.rowBase(),
    kind: "assistantText",
    text: "hello",
    state: "streaming",
  });
  const wire = f.host.wire(
    {
      kind: "deltas",
      deltas: [{ op: "row.delta", rowId: 1, path: "text", append: " world" }],
    },
    "online",
    f.host.state.seq,
  );
  (wire.frame as any).toSeq = f.host.state.seq + 1;
  f.conversation.accept(wire);
  f.conversation.accept(wire);
  expect(f.conversation.state?.rows.window[0]).toMatchObject({
    text: "hello world",
  });
  await f.conversation.close();
});
it("recovers a sequence gap through the official resync API", async () => {
  const f = await fixture();
  const wire = f.host.wire({ kind: "deltas", deltas: [] }, "online", 20);
  (wire.frame as any).toSeq = 21;
  f.conversation.accept(wire);
  await f.conversation.waitFor(() => f.conversation.idle);
  expect(f.host.calls.some((c) => c.method === "resyncConversationV4")).toBe(
    true,
  );
  expect(f.errors).toEqual([]);
  await f.conversation.close();
});
it("loads more than the snapshot tail by paging with coherent revision", async () => {
  const f = await fixture();
  for (let i = 0; i < 430; i++) {
    const row = {
      ...f.host.rowBase(),
      kind: "assistantText" as const,
      text: String(i),
      state: "complete" as const,
    };
    f.host.state.rows.window.push(row);
  }
  f.host.state.rows.totalCount = 430;
  await f.conversation.loadHistory();
  expect(f.conversation.state?.rows.window).toHaveLength(430);
  expect(
    f.host.calls.filter((c) => c.method === "conversationRowsRangeV4"),
  ).toHaveLength(4);
  await f.conversation.close();
});
it("ignores notifications after unsubscribe", async () => {
  const f = await fixture();
  const state = f.conversation.state;
  await f.conversation.close();
  f.conversation.accept(f.host.wire({ kind: "snapshot", snapshot: {} }));
  expect(f.conversation.state).toBe(state);
});
it("official assembler rejects corrupt fragments and releases their memory", () => {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const events = assembler.accept({
    wireVersion: 3,
    kind: "fragment",
    logicalFrameId: "f",
    logicalFrameOrdinal: 1,
    topic: "conversation/s",
    subscriptionId: "sub",
    deliveryKind: "online",
    fragmentIndex: 0,
    fragmentCount: 1,
    logicalBytes: 2,
    checksum: { algorithm: "crc32", value: "00000000" },
    dataBase64: "e30=",
  });
  expect(events[0]?.kind).toBe("fault");
  expect(assembler.getStats().stagedDecodedBytes).toBe(0);
});
it("never publishes a mixed history revision", async () => {
  const f = await fixture(),
    request = f.host.request.bind(f.host);
  f.host.request = async (method, params, schema) => {
    const result = await request(method, params, schema);
    if (method === "conversationRowsRangeV4")
      return { ...(result as Record<string, unknown>), atRevision: 999 } as any;
    return result;
  };
  const before = f.conversation.state;
  await expect(f.conversation.loadHistory()).rejects.toThrow(
    "no mixed history",
  );
  expect(f.conversation.state).toBe(before);
  await f.conversation.close();
});
it("hydrates a new epoch before notifying observers", async () => {
  const f = await fixture(),
    seen: number[] = [];
  f.conversation.subscribe(() =>
    seen.push(f.conversation.state!.rows.window.length),
  );
  const rows = Array.from({ length: 210 }, (_, i) => ({
    ...f.host.rowBase(),
    kind: "assistantText" as const,
    text: String(i),
    state: "complete" as const,
  }));
  f.host.state.logEpoch = "replacement";
  f.host.state.rows.window = rows;
  f.host.state.rows.totalCount = rows.length;
  const request = f.host.request.bind(f.host);
  f.host.request = async (method, params, schema) => {
    if (method === "resyncConversationV4") {
      const complete = f.host.state.rows.window;
      f.host.state.rows.window = complete.slice(-60);
      await f.host.emitSnapshot("recovery");
      f.host.state.rows.window = complete;
      return schema.parse({
        ack: {
          subscriptionId: "sub",
          mode: "snapshot",
          logEpoch: "replacement",
        },
      });
    }
    return request(method, params, schema);
  };
  await f.host.emitSnapshot();
  await f.conversation.waitFor(() => f.conversation.idle);
  expect(seen).toEqual([210]);
  expect(f.errors).toEqual([]);
  await f.conversation.close();
});
