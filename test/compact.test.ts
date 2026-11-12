import { afterEach, expect, it } from "vitest";
import { providerFixture } from "./provider-fixture.js";
import { completeTurn } from "./fake-host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await providerFixture();
  cleanups.push(f.close);
  await f.open();
  const turns = () =>
    f.events
      .filter((e) => e.type === "session.turn")
      .map((e) => (e.type === "session.turn" ? e.state : undefined));
  const notifications = () =>
    f.events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "notification"
        ? [e.item.message]
        : [],
    );
  const settled = (state: string) =>
    f.wait((e) => e.type === "session.turn" && e.state === state);
  return { ...f, turns, notifications, settled };
}

it("completes the turn of /compact, which adds no user input row", async () => {
  const f = await fixture();
  expect(await f.prompt("m1", "/compact keep the API notes")).toMatchObject({
    result: { type: "turn" },
  });
  // The Server reads the command and its instructions from the text.
  expect(
    f.host.calls.find((c) => c.params?.envelope?.type === "sendText")?.params
      .envelope.payload.text,
  ).toBe("/compact keep the API notes");
  expect(f.host.state.rows.window.map((row) => row.kind)).toEqual([
    "turnHeader",
    "timelineMarker",
  ]);
  expect(f.turns()).toEqual(["started"]);
  await f.host.finishCompact("success");
  await f.settled("completed");
  expect(f.turns()).toEqual(["started", "completed"]);
  expect(f.notifications()).toEqual(["Context compaction: success"]);
  // The next input starts a turn of its own.
  expect(await f.prompt("m2")).toMatchObject({ result: { type: "turn" } });
  await completeTurn(f.host);
  await f.wait(
    (e) =>
      e.type === "session.turn" &&
      e.state === "completed" &&
      f.turns().length === 4,
  );
});

it("reports a failed compaction as a failed turn", async () => {
  const f = await fixture();
  await f.prompt("m1", "/compact");
  await f.host.finishCompact("failed", {
    code: "1310",
    message: "native-provider-text",
    recoverable: true,
    at: 3,
    source: "provider",
    attribution: {
      source: "provider",
      reason: "rate_limited",
      statusCode: 429,
      providerErrorCode: "1310",
    },
  });
  expect(await f.settled("failed")).toMatchObject({
    error: { code: "MODEL_RATE_LIMITED" },
  });
  expect(f.notifications()).toEqual(["Context compaction: failed"]);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
});

it("stops a compaction, whose works name no foreground execution", async () => {
  const f = await fixture();
  await f.prompt("m1", "/compact");
  expect(f.host.state.control).toMatchObject({
    canStop: true,
    activeWorks: [{ kind: "primaryTurn" }, { kind: "compact" }],
  });
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  expect(
    await f.wait((e) => "requestId" in e && e.requestId === "stop"),
  ).toMatchObject({ type: "request.completed" });
  // ZCode Desktop also stops without a target when no work names one.
  expect(
    f.host.calls.find((c) => c.params?.envelope?.type === "stop")?.params
      .envelope.payload,
  ).toEqual({});
  expect(f.turns()).toEqual(["started", "canceled"]);
  expect(f.notifications()).toEqual(["Context compaction: cancelled"]);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  expect(f.host.closed).toBe(false);
  expect(await f.prompt("m2")).toMatchObject({ result: { type: "turn" } });
  await completeTurn(f.host);
});
