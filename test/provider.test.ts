import { afterEach, expect, it, vi } from "vitest";
import { providerFixture } from "./provider-fixture.js";
import { completeTurn } from "./fake-host.js";
import { AdapterError } from "../server/errors.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await providerFixture();
  cleanups.push(f.close);
  return f;
}
it("accepts only after ACK even if rows and terminal state arrive first", async () => {
  const f = await fixture();
  await f.open();
  f.host.afterAdmit = () => completeTurn(f.host);
  await f.prompt();
  await f.wait((e) => e.type === "session.turn" && e.state === "completed");
  const ack = f.events.findIndex((e) => e.type === "session.prompt_result");
  expect(
    f.events.findIndex(
      (e) => e.type === "session.turn" && e.state === "started",
    ),
  ).toBeGreaterThan(ack);
  expect(
    f.events.filter((e) => e.type === "session.prompt_result"),
  ).toHaveLength(1);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("aggregates guide input and emits complete row snapshots with stable IDs", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await f.host.append({
    ...f.host.rowBase(),
    kind: "assistantText",
    text: "a",
    state: "streaming",
  });
  const row = f.host.state.rows.window.at(-1)!;
  await f.host.deltas([
    { op: "row.delta", rowId: row.rowId, path: "text", append: "b" },
  ]);
  const second = await f.prompt("m2", "guide");
  expect(second).toMatchObject({ result: { type: "steer" } });
  await completeTurn(f.host);
  const items = f.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(
    items
      .slice(0, 2)
      .map((e) => (e.type === "timeline.item" ? e.item : undefined)),
  ).toMatchObject([
    { id: `zcode:row:${row.rowId}`, text: "a" },
    { id: `zcode:row:${row.rowId}`, text: "ab" },
  ]);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("preserves native row timestamps during replay, live updates and resume", async () => {
  const f = await fixture();
  const createdAt = Date.parse("2026-01-02T03:04:05.000Z");
  const original = {
    ...f.host.rowBase(),
    createdAt,
    kind: "assistantText" as const,
    text: "Earlier response",
    state: "complete" as const,
  };
  await f.host.append(original);
  await f.open();
  const replay = await f.wait(
    (e) =>
      e.type === "timeline.item" && e.item.id === `zcode:row:${original.rowId}`,
  );
  expect(replay).toMatchObject({
    timestamp: new Date(createdAt).toISOString(),
  });
  await f.prompt();
  const live = {
    ...f.host.rowBase(),
    createdAt: createdAt + 60_000,
    kind: "assistantText" as const,
    text: "Live",
    state: "streaming" as const,
  };
  await f.host.append(live);
  await f.host.deltas([
    { op: "row.delta", rowId: live.rowId, path: "text", append: " response" },
  ]);
  const updates = f.events.filter(
    (e) =>
      e.type === "timeline.item" && e.item.id === `zcode:row:${live.rowId}`,
  );
  expect(updates).toHaveLength(2);
  for (const event of updates)
    expect(event).toMatchObject({
      timestamp: new Date(live.createdAt).toISOString(),
    });
  await completeTurn(f.host);
  const persisted = f.events.find((e) => e.type === "session.opened");
  if (persisted?.type !== "session.opened")
    throw new Error("Missing persistence");
  await f.send({
    type: "session.close",
    sessionId: "public",
    requestId: "close",
  });
  f.events.length = 0;
  await f.open({}, persisted.persistence);
  expect(
    await f.wait(
      (e) =>
        e.type === "timeline.item" && e.item.id === `zcode:row:${live.rowId}`,
    ),
  ).toMatchObject({ timestamp: new Date(live.createdAt).toISOString() });
});
it("does not infer queue consumption from disappearance", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.deferConsumption = true;
  await f.prompt("m2", "queued");
  const item = f.host.state.queue.items[0]!;
  await f.host.deltas([
    { op: "state.updated", patch: { queue: { autoDrain: true, items: [] } } },
  ]);
  await f.host.finish();
  expect(
    f.events.some((e) => e.type === "session.turn" && e.state === "completed"),
  ).toBe(false);
  await f.host.consume(item.sourceCommandId, "queued");
  await completeTurn(f.host);
  expect(
    f.events.filter(
      (e) => e.type === "session.turn" && e.state === "completed",
    ),
  ).toHaveLength(1);
});
it("never resends an input with an unknown admission result", async () => {
  const f = await fixture();
  await f.open();
  f.host.failAdmission = "unknown";
  expect(await f.prompt()).toMatchObject({ result: { type: "failed" } });
  expect(
    f.host.calls.filter((c) => c.params?.envelope?.type === "sendText"),
  ).toHaveLength(1);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(true);
});
it("rejects failed admission without destroying a running turn", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.failAdmission = "rejected";
  expect(await f.prompt("m2")).toMatchObject({ result: { type: "failed" } });
  expect(f.host.closed).toBe(false);
  await completeTurn(f.host);
});
it("targets stop by foreground execution ID and cancels queued input", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const target = f.host.activeProductTurn;
  f.host.deferConsumption = true;
  await f.prompt("m2");
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  await f.wait((e) => e.type === "request.completed" && e.requestId === "stop");
  expect(
    f.host.calls.find((c) => c.params?.envelope?.type === "stop")?.params
      .envelope.payload,
  ).toEqual({ expectedForegroundExecutionId: target });
  expect(f.host.state.queue).toMatchObject({ autoDrain: false, items: [] });
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "canceled"),
  ).toHaveLength(1);
  f.host.deferConsumption = false;
  await f.prompt("m3", "resume");
  expect(f.host.state.queue.autoDrain).toBe(true);
  await completeTurn(f.host);
});
it("records the native ID before sending and rejects write failure", async () => {
  const f = await fixture();
  await f.open();
  vi.spyOn(f.store, "save").mockRejectedValue(
    new AdapterError("PERSISTENCE_WRITE_FAILED", "test"),
  );
  expect(await f.prompt()).toMatchObject({
    result: { type: "failed", error: { code: "PERSISTENCE_WRITE_FAILED" } },
  });
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "sendText"),
  ).toBe(false);
});
it.each([1, 2])(
  "rejects old persistence version %s without creating a replacement",
  async (version) => {
    const f = await fixture();
    expect(
      await f.open(
        {},
        { version, data: { kind: "native", sessionId: "old", cwd: f.cwd } },
      ),
    ).toMatchObject({
      type: "request.failed",
      error: { code: "PERSISTENCE_VERSION_UNSUPPORTED" },
    });
    expect(f.host.calls).toEqual([]);
  },
);
it.each([
  { persist: false },
  { systemPrompt: "custom" },
  { providerOptions: { unknown: true } },
])("explicitly rejects unsupported configuration", async (override) => {
  const f = await fixture();
  expect(await f.open(override)).toMatchObject({ type: "request.failed" });
});
it("reports cumulative usage without adding repeated snapshots", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await completeTurn(f.host);
  await f.host.emitSnapshot();
  await f.host.emitSnapshot();
  expect(
    f.events.filter(
      (e) => e.type === "session.usage" && e.usage.inputTokens === 20,
    ),
  ).toHaveLength(1);
});
it("announces background continuation without fabricating user input", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  await completeTurn(f.host);
  const before = f.events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "user_message",
  ).length;
  f.host.activeProductTurn = "background-1";
  await f.host.append({
    ...f.host.rowBase(),
    kind: "turnHeader",
    origin: "backgroundResult",
    state: "running",
    startedAt: 2,
  });
  await f.host.finish();
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "started"),
  ).toHaveLength(2);
  expect(
    f.events.filter(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  ).toHaveLength(before);
});
it("cancels unconsumed queue input after a native failure and finishes once", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  f.host.deferConsumption = true;
  await f.prompt("second");
  await f.host.finish("failed");
  await f.wait((e) => e.type === "session.turn" && e.state === "failed");
  expect(f.host.state.queue.items).toEqual([]);
  expect(
    f.events.filter((e) => e.type === "session.turn" && e.state === "failed"),
  ).toHaveLength(1);
});
it("renders configuration markers without inventing a product turn", async () => {
  const f = await fixture();
  await f.open();
  const { productTurnId, turnId, ...base } = f.host.rowBase();
  await f.host.append({
    ...base,
    turnId: "",
    kind: "timelineMarker",
    marker: {
      type: "modelChange",
      toProvider: "provider",
      toModel: "model",
      toThought: "high",
    },
  });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  expect(
    f.events.some(
      (e) => e.type === "timeline.item" && e.item.type === "notification",
    ),
  ).toBe(true);
});
it("lists native sessions using the current handle version", async () => {
  const f = await fixture();
  await f.send({ type: "sessions", requestId: "list", cwd: f.cwd });
  const result = await f.wait((e) => e.type === "sessions");
  expect(result).toMatchObject({
    sessions: [
      {
        persistence: {
          version: 3,
          data: { kind: "native", sessionId: "session-1" },
        },
      },
    ],
  });
});
it("completes /plan without creating a model turn or persisting a draft", async () => {
  const f = await fixture();
  await f.open();
  expect(await f.prompt("plan", "/plan")).toMatchObject({
    result: { type: "completed" },
  });
  expect(f.host.state.config.planEnabled).toBe(true);
  expect(f.events.some((e) => e.type === "session.turn")).toBe(false);
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "sendText"),
  ).toBe(false);
});
it("answers native interactions once and ignores responses after their observed resolution", async () => {
  const f = await fixture();
  await f.open();
  await f.prompt();
  const interaction = {
    interactionId: "child-question",
    kind: "userInput" as const,
    anchorRowId: 1,
    createdAt: 1,
    payload: {
      kind: "userInput" as const,
      prompt: "Choose",
      freeText: true,
      questions: [
        {
          header: "Choice",
          question: "Select",
          options: [{ label: "One", value: "native-one" }],
        },
      ],
    },
  };
  await f.host.deltas([
    { op: "state.updated", patch: { pendingInteractions: [interaction] } },
  ]);
  await f.wait((e) => e.type === "session.permission");
  const answer = {
    type: "session.permission" as const,
    sessionId: "public",
    permissionId: interaction.interactionId,
    response: {
      behavior: "allow" as const,
      updatedInput: { answers: { Choice: "One" } },
    },
  };
  await f.send(answer);
  await f.wait((e) => e.type === "session.permission_resolved");
  await completeTurn(f.host);
  await f.prompt("next");
  await f.send(answer);
  expect(await f.prompt("after-late")).toMatchObject({
    result: { type: "steer" },
  });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  await completeTurn(f.host);
  await f.connection.close();
  const calls = f.host.calls.filter(
    (c) => c.params?.envelope?.type === "resolveInteraction",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.params.envelope.payload).toMatchObject({
    interactionId: "child-question",
    answer: {
      action: "accept",
      content: { answers: { Select: ["native-one"] } },
    },
  });
});
