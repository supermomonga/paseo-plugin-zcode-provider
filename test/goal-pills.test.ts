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

interface Subscription {
  name: string;
  onEvent(event: { goals: GoalView[] }): void;
  onClosed?: (closed: { error?: Error }) => void;
  signal?: AbortSignal;
  released: boolean;
}

// The parts of Paseo's client that the pills use.
function paseo() {
  const pills = new Map<string, Record<string, unknown>>();
  const updates: Array<Record<string, unknown>> = [];
  let observer:
    | { snapshot(s: unknown): void; update(m: unknown): void }
    | undefined;
  const subscriptions: Subscription[] = [];
  const subscribe = vi.fn(
    (
      contract: { name: string },
      _input: unknown,
      onEvent: Subscription["onEvent"],
      options: {
        signal?: AbortSignal;
        onClosed?: Subscription["onClosed"];
      } = {},
    ) => {
      const subscription: Subscription = {
        name: contract.name,
        onEvent,
        onClosed: options.onClosed,
        signal: options.signal,
        released: false,
      };
      options.signal?.addEventListener("abort", () => {
        subscription.released = true;
      });
      subscriptions.push(subscription);
      return Object.assign(() => {}, {
        ready: Promise.resolve(),
        release: async () => {},
      });
    },
  );
  const list = vi.fn(async (_options: { signal: AbortSignal }) => ({
    subscription: {
      subscribe(next: typeof observer) {
        observer = next;
        return () => {};
      },
    },
  }));
  const client = {
    subscribe,
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
  /** The subscription the pills follow now. */
  const current = () => subscriptions.at(-1)!;
  return {
    client,
    pills,
    updates,
    subscribe,
    subscriptions,
    list,
    /** The daemon sends the goals. */
    send: (...goals: GoalView[]) => current().onEvent({ goals }),
    close: (error?: Error) => current().onClosed?.({ error }),
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
  expect(p.subscriptions.map((s) => s.name)).toEqual(["zcode.goals.watch"]);
  p.snapshot(agent("agent-1"), agent("other", "claude"), agent("agent-3"));
  p.send(goal(), goal({ agentId: "other" }));
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
  expect(p.subscriptions[0]!.released).toBe(true);
});

it("shows goals that arrive before the agents are known", async () => {
  const p = await started();
  p.send(goal());
  expect(p.pills.size).toBe(0);
  p.snapshot(agent("agent-1"));
  expect([...p.pills.keys()]).toEqual(["workspace-1/agent-1"]);
  p.stop();
});

it("counts the minutes by its own clock between the daemon's events", async () => {
  const p = await started();
  p.snapshot(agent("agent-1"));
  p.send(goal({ elapsedSeconds: 3775 }));
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 2m");
  await settle(4_000);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 2m");
  // The daemon's figure plus the time since it arrived.
  await settle(1_000);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 3m");
  // An agent update long after the event keeps the time it arrived.
  await settle(60_000);
  p.upsert(agent("agent-1"));
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 4m");
  // Nothing is read in between; the subscription is the only source.
  expect(p.subscribe).toHaveBeenCalledTimes(1);
  p.stop();
});

it("follows the goal in place and stops counting once it rests", async () => {
  const p = await started();
  p.snapshot(agent("agent-1"));
  p.send(goal());
  p.send(goal({ status: "paused", running: false }));
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Paused",
    icon: "CirclePause",
    label: "Goal 1h 3m",
  });
  // Replacing the behavior would close an open popover.
  expect(p.updates).toEqual([{ title: "Goal: Paused", icon: "CirclePause" }]);
  await settle(120_000);
  expect(p.pills.get("workspace-1/agent-1")!.label).toBe("Goal 1h 3m");

  p.send();
  expect(p.pills.size).toBe(0);
  p.stop();
});

it("moves the pill with its agent and removes it with the agent", async () => {
  const p = await started();
  p.snapshot(agent("agent-1"));
  p.send(goal({ status: "verified", running: false }));
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Complete",
    icon: "CircleCheckBig",
  });
  p.upsert(agent("agent-1", "zcode", "workspace-2"));
  expect([...p.pills.keys()]).toEqual(["workspace-2/agent-1"]);
  p.remove("agent-1");
  expect(p.pills.size).toBe(0);
  // Other providers' agents never show a pill.
  p.upsert(agent("agent-1", "claude"));
  expect(p.pills.size).toBe(0);
  p.stop();
});

it("keeps what it shows when the subscription fails and follows again", async () => {
  const p = await started();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  p.snapshot(agent("agent-1"));
  p.send(goal());
  p.close(new Error("plugin stopped"));
  expect(logged).toHaveBeenCalledTimes(1);
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({ icon: "Goal" });
  await settle(4_999);
  expect(p.subscribe).toHaveBeenCalledTimes(1);
  await settle(1);
  expect(p.subscribe).toHaveBeenCalledTimes(2);
  p.send(goal({ status: "verifying", running: false }));
  expect(p.pills.get("workspace-1/agent-1")).toMatchObject({
    title: "Goal: Verifying",
    icon: "ScanSearch",
  });
  p.stop();
  // A stopped client does not follow again.
  p.close();
  await settle(10_000);
  expect(p.subscribe).toHaveBeenCalledTimes(2);
});

it("replaces what it knows on a new snapshot, as after a reconnect", async () => {
  const p = await started();
  p.snapshot(agent("agent-1"), agent("agent-2"));
  p.send(goal(), goal({ agentId: "agent-2" }));
  expect(p.pills.size).toBe(2);
  p.snapshot(agent("agent-2"));
  expect([...p.pills.keys()]).toEqual(["workspace-1/agent-2"]);
  p.stop();
});
