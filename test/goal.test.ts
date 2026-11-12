import { afterEach, expect, it } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { providerFixture } from "./provider-fixture.js";
import { completeTurn } from "./fake-host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await providerFixture();
  cleanups.push(f.close);
  // Paseo sets the agent's ID in the launch environment of every session.
  const open = () => f.open({ env: { PASEO_AGENT_ID: "agent-1" } });
  const commands = (type: string) =>
    f.host.calls
      .filter((c) => c.params?.envelope?.type === type)
      .map((c) => c.params.envelope.payload);
  const turns = () =>
    f.events
      .filter((e) => e.type === "session.turn")
      .map((e) => (e.type === "session.turn" ? e.state : undefined));
  const command = async (id: string, argumentsText: string) => {
    await f.send({
      type: "session.prompt",
      sessionId: "public",
      prompt: {
        clientMessageId: id,
        input: { type: "command", name: "goal", arguments: argumentsText },
        delivery: "auto",
      },
    });
    return f.wait(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === id,
    );
  };
  return { ...f, open, commands, turns, command };
}
const failure = (event: ProviderEvent) =>
  event.type === "session.prompt_result" && event.result.type === "failed"
    ? event.result.error.message
    : undefined;

it("sends /goal as the goal command and follows it to verification in one turn", async () => {
  const f = await fixture();
  await f.open();
  expect(f.goals.views()).toEqual([]);
  expect(await f.command("m1", "Ship it")).toMatchObject({
    result: { type: "turn" },
  });
  // Text input would hand the command to the model as it is.
  expect(f.commands("sendText")).toEqual([]);
  expect(f.commands("sendGoalCommand")).toEqual([
    {
      text: "Ship it",
      displayText: "/goal Ship it",
      modelSelection: f.host.state.config.modelSelection,
      mode: "build",
      planEnabled: false,
    },
  ]);
  expect(
    await f.wait(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  ).toMatchObject({ item: { text: "/goal Ship it", clientMessageId: "m1" } });
  expect(f.goals.views()).toMatchObject([
    { agentId: "agent-1", status: "active", running: true },
  ]);
  // A goal that is not satisfied continues without the conversation idling.
  await f.host.verifyGoal("notSatisfied");
  expect(f.turns()).toEqual(["started"]);
  await f.host.verifyGoal("pass");
  await f.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(f.turns()).toEqual(["started", "completed"]);
  expect(f.goals.views()).toMatchObject([
    {
      agentId: "agent-1",
      status: "verified",
      running: false,
      elapsedSeconds: 120,
      iterations: [
        { iteration: 1, title: "Ship it" },
        { iteration: 2, title: "Finish the rest" },
      ],
    },
  ]);
});

it("accepts the goal only after its acknowledgement, which follows the turn's rows", async () => {
  const f = await fixture();
  await f.open();
  let started = false;
  f.host.afterAdmit = async () => {
    started = f.events.some((e) => e.type === "session.turn");
  };
  await f.command("m1", "Ship it");
  expect(started).toBe(false);
  expect(f.events.findIndex((e) => e.type === "session.turn")).toBeGreaterThan(
    f.events.findIndex((e) => e.type === "session.prompt_result"),
  );
});

it("reads /goal typed as a message, with its alias and replace", async () => {
  const f = await fixture();
  await f.open();
  expect(await f.prompt("m1", " /target replace Ship it ")).toMatchObject({
    result: { type: "turn" },
  });
  expect(f.commands("sendGoalCommand")).toMatchObject([
    { text: "Ship it", displayText: "/target replace Ship it" },
  ]);
  expect(f.commands("sendText")).toEqual([]);
});

it("resumes the goal that stopping its turn paused", async () => {
  const f = await fixture();
  await f.open();
  await f.command("m1", "Ship it");
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  await f.wait((e) => e.type === "session.turn" && e.state === "canceled");
  expect(f.goals.views()).toMatchObject([{ status: "paused", running: false }]);
  // Paseo stops the turn before it sends a command typed during it.
  expect(await f.command("pause", "pause")).toMatchObject({
    result: { type: "completed" },
  });
  expect(f.commands("pauseGoal")).toEqual([]);
  f.events.length = 0;
  expect(await f.command("m2", "resume")).toMatchObject({
    result: { type: "turn" },
  });
  expect(f.commands("resumeGoal")).toEqual([{}]);
  expect(f.commands("sendGoalCommand")).toHaveLength(1);
  expect(f.goals.views()).toMatchObject([{ status: "active", running: true }]);
  // The resumed turn is the run's evidence; resuming adds no user input row.
  expect(f.turns()).toEqual(["started"]);
  await f.host.verifyGoal("pass");
  await f.wait((e) => e.type === "session.turn" && e.state === "completed");
  expect(f.turns()).toEqual(["started", "completed"]);
});

it("pauses an active goal that has no turn, without starting one", async () => {
  const f = await fixture();
  await f.open();
  await f.command("m1", "Ship it");
  await f.send({
    type: "session.interrupt",
    sessionId: "public",
    requestId: "stop",
  });
  await f.wait((e) => e.type === "session.turn" && e.state === "canceled");
  // An active goal whose turn ended, as after a failed turn.
  await f.host.deltas([
    {
      op: "state.updated",
      patch: {
        goal: { ...f.host.state.goal!, status: "active" },
        availability: {
          ...f.host.state.availability,
          pauseGoal: { allowed: true },
        },
      },
    },
  ]);
  f.events.length = 0;
  expect(await f.command("m2", "pause")).toMatchObject({
    result: { type: "completed" },
  });
  expect(f.commands("pauseGoal")).toEqual([{}]);
  expect(f.goals.views()).toMatchObject([{ status: "paused" }]);
  expect(f.turns()).toEqual([]);
});

it("explains goal commands it cannot run and sends nothing for them", async () => {
  const f = await fixture();
  await f.open();
  expect(failure(await f.command("m1", ""))).toBe(
    "Usage: /goal <objective>, /goal pause or /goal resume",
  );
  expect(failure(await f.command("m2", "clear"))).toMatch(
    /has no \/goal clear/,
  );
  expect(failure(await f.command("m3", "resume"))).toBe(
    "ZCode has no paused goal to resume",
  );
  expect(failure(await f.command("m4", "pause"))).toBe(
    "ZCode has no active goal to pause",
  );
  // The Server rejects a goal while Plan mode is on.
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "plan",
    changes: { settings: { plan_mode: true } },
  });
  await f.wait((e) => e.type === "request.completed" && e.requestId === "plan");
  expect(failure(await f.command("m5", "Ship it"))).toMatch(/Plan mode/);
  for (const type of ["sendText", "sendGoalCommand", "resumeGoal", "pauseGoal"])
    expect(f.commands(type)).toEqual([]);
  expect(f.turns()).toEqual([]);
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
});

it("does not send /goal with an attachment to the model as text", async () => {
  const f = await fixture();
  await f.open();
  await f.send({
    type: "session.prompt",
    sessionId: "public",
    prompt: {
      clientMessageId: "m1",
      input: {
        type: "message",
        content: [
          { type: "text", text: "/goal Ship it" },
          { type: "text", text: "and this" },
        ],
      },
      delivery: "auto",
    },
  });
  expect(failure(await f.wait((e) => e.type === "session.prompt_result"))).toBe(
    "The /goal command requires a single text input without attachments",
  );
  expect(f.commands("sendText")).toEqual([]);
  expect(f.commands("sendGoalCommand")).toEqual([]);
});

it("keeps the session usable when ZCode rejects the goal", async () => {
  const f = await fixture();
  await f.open();
  f.host.failAdmission = "rejected";
  expect(
    (await f.command("m1", "Ship it")).type === "session.prompt_result",
  ).toBe(true);
  expect(
    f.events.find(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === "m1",
    ),
  ).toMatchObject({ result: { type: "failed" } });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  f.host.failAdmission = undefined;
  expect(await f.prompt("m2")).toMatchObject({ result: { type: "turn" } });
  await completeTurn(f.host);
  await f.wait((e) => e.type === "session.turn" && e.state === "completed");
});

it("lists a goal only for a session that names its Paseo agent, until it closes", async () => {
  const anonymous = await fixture();
  // Only Paseo's launch environment names the agent.
  await anonymous.send({
    type: "session.open",
    sessionId: "public",
    requestId: "open",
    config: anonymous.config,
    history: "replay",
  });
  await anonymous.wait((e) => e.type === "session.ready");
  await anonymous.command("m1", "Ship it");
  expect(anonymous.goals.views()).toEqual([]);

  const f = await fixture();
  await f.open();
  await f.command("m1", "Ship it");
  expect(f.goals.views()).toMatchObject([{ agentId: "agent-1" }]);
  await f.send({
    type: "session.close",
    sessionId: "public",
    requestId: "close",
  });
  await f.wait((e) => e.type === "session.closed");
  expect(f.goals.views()).toEqual([]);
});
