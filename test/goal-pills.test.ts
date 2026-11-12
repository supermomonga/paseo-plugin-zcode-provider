import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { followGoals, type GoalPillHost } from "../client/goal-pills";
import type { GoalView } from "../shared/goal";

const Content = () => null;
const goal = (patch: Partial<GoalView> = {}): GoalView => ({
  agentId: "agent-1",
  status: "active",
  elapsedSeconds: 3780,
  running: true,
  iterations: [],
  ...patch,
});
const agent = (
  id: string,
  provider = "zcode",
  workspaceId = "workspace-1",
) => ({
  id,
  provider,
  workspaceId,
});

// The parts of Paseo's client that the pills use.
function paseo() {
  const pills = new Map<string, Record<string, unknown>>();
  const updates: Array<Record<string, unknown>> = [];
  let observer:
    | { snapshot(s: unknown): void; update(m: unknown): void }
    | undefined;
  const state = { goals: [] as GoalView[], fail: false };
  const rpc = vi.fn(async () => {
    if (state.fail) throw new Error("offline");
    return { goals: state.goals };
  });
  const list = vi.fn(async (_options: { signal: AbortSignal }) => ({
    subscription: {
      subscribe(next: typeof observer) {
        observer = next;
        return () => {};
      },
    },
  }));
  const client = {
    rpc,
    paseo: { agents: { list } },
    addComposerPill(contribution: {
      id: string;
      workspaceId: string;
      agentId: string;
      button: Record<string, unknown>;
    }) {
      const key = `${contribution.workspaceId}/${contribution.agentId}`;
      if (pills.has(key)) throw new Error(`Duplicate plugin button: ${key}`);
      const button = { ...contribution.button };
      pills.set(key, button);
      return {
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          Object.assign(button, patch);
        },
        remove: () => void pills.delete(key),
      };
    },
  } as unknown as GoalPillHost;
  return {
    client,
    pills,
    updates,
    rpc,
    list,
    state,
    snapshot: (...agents: Array<ReturnType<typeof agent>>) =>
      observer!.snapshot({ entries: agents.map((a) => ({ agent: a })) }),
    upsert: (a: ReturnType<typeof agent>) =>
      observer!.update({
        type: "agent_update",
        payload: { kind: "upsert", agent: a },
      }),
    remove: (agentId: string) =>
      observer!.update({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      }),
  };
}
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function started() {
  const p = paseo();
  const stop = followGoals(p.client, Content);
  await settle();
  return { ...p, stop };
}

it("shows a pill on the composer of a ZCode agent that has a goal", async () => {
  const p = await started();
  p.state.goals = [goal(), goal({ agentId: "other" })];
  p.snapshot(agent("agent-1"), agent("other", "claude"), agent("agent-3"));
  await settle();
  expect([...p.pills]).toEqual([
    [
      "workspace-1/agent-1",
      {
        title: "Goal: In progress",
        icon: "Goal",
        label: "Goal 1h 3m",
        behavior: { kind: "popover", Content },
      },
    ],
  ]);
  p.stop();
  expect(p.pills.size).toBe(0);
  expect(p.list.mock.calls[0]![0].signal.aborted).toBe(true);
});

it("counts the minutes by its own clock and rereads a goal in progress", async () => {
  const p = await started();
  p.state.goals = [goal({ elapsedSeconds: 3775 })];
  p.snapshot(agent("agent-1"));
  await settle();
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 2m");
  await settle(4_000);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 2m");
  // The daemon's figure plus the time since it arrived, without a read.
  await settle(1_000);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 3m");
  expect(p.rpc).toHaveBeenCalledTimes(1);
  // ZCode titles a goal without anything changing in Paseo.
  p.state.goals = [goal({ elapsedSeconds: 3785 })];
  await settle(5_000);
  expect(p.rpc).toHaveBeenCalledTimes(2);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 3m");
  p.stop();
});

it("follows the goal in place and stops reading once it rests", async () => {
  const p = await started();
  p.state.goals = [goal()];
  p.snapshot(agent("agent-1"));
  await settle();
  p.state.goals = [goal({ status: "paused", running: false })];
  p.upsert(agent("agent-1"));
  await settle(1_000);
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Paused",
    icon: "CirclePause",
    label: "Goal 1h 3m",
  });
  // Replacing the behavior would close an open popover.
  expect(p.updates).toEqual([{ title: "Goal: Paused", icon: "CirclePause" }]);
  const reads = p.rpc.mock.calls.length;
  await settle(120_000);
  expect(p.rpc).toHaveBeenCalledTimes(reads);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 3m");

  p.state.goals = [];
  p.upsert(agent("agent-1"));
  await settle(1_000);
  expect(p.pills.size).toBe(0);
  p.stop();
});

it("reads when a ZCode agent changes, at most once a second", async () => {
  const p = await started();
  p.snapshot(agent("agent-1"));
  await settle();
  expect(p.rpc).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 5; i++) p.upsert(agent("agent-1"));
  p.upsert(agent("other", "claude"));
  await settle(500);
  expect(p.rpc).toHaveBeenCalledTimes(1);
  await settle(500);
  expect(p.rpc).toHaveBeenCalledTimes(2);
  // Other providers' agents never cause a read.
  p.upsert(agent("other", "claude"));
  await settle(5_000);
  expect(p.rpc).toHaveBeenCalledTimes(2);
  p.stop();
});

it("moves the pill with its agent and removes it with the agent", async () => {
  const p = await started();
  p.state.goals = [goal({ status: "verified", running: false })];
  p.snapshot(agent("agent-1"));
  await settle();
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Complete",
    icon: "CircleCheckBig",
  });
  p.upsert(agent("agent-1", "zcode", "workspace-2"));
  await settle(1_000);
  expect([...p.pills.keys()]).toEqual(["workspace-2/agent-1"]);
  p.remove("agent-1");
  expect(p.pills.size).toBe(0);
  p.stop();
});

it("keeps what it shows when a read fails and recovers on the next", async () => {
  const p = await started();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  p.state.goals = [goal()];
  p.snapshot(agent("agent-1"));
  await settle();
  p.state.fail = true;
  await settle(10_000);
  expect(logged).toHaveBeenCalledTimes(1);
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({ icon: "Goal" });
  p.state.fail = false;
  p.state.goals = [goal({ status: "verifying", running: false })];
  await settle(10_000);
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Verifying",
    icon: "ScanSearch",
  });
  p.stop();
});

it("replaces what it knows on a new snapshot, as after a reconnect", async () => {
  const p = await started();
  p.state.goals = [goal(), goal({ agentId: "agent-2" })];
  p.snapshot(agent("agent-1"), agent("agent-2"));
  await settle();
  expect(p.pills.size).toBe(2);
  p.snapshot(agent("agent-2"));
  await settle(1_000);
  expect([...p.pills.keys()]).toEqual(["workspace-1/agent-2"]);
  p.stop();
});
