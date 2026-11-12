import type { ComponentType } from "react";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import {
  formatGoalElapsed,
  goalInProgress,
  goalStatusLabel,
  zcodeGoals,
  type GoalView,
} from "../shared/goal";

/** The provider ID the agents of this plugin carry. */
const PROVIDER = "zcode";
/** The least time between two reads of the goals. */
const READ_SPACING_MS = 1_000;
/**
 * A goal in progress changes without its agent changing in Paseo, as when
 * ZCode titles it, and Paseo 0.15 gives the daemon no way to tell a client.
 */
const IN_PROGRESS_READ_MS = 10_000;

export type GoalPillHost = Pick<
  PluginClientContext,
  "addComposerPill" | "rpc" | "paseo"
>;

type Timer = ReturnType<typeof setTimeout>;
// React Native's clearTimeout takes no undefined.
function cancel(timer: Timer | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

interface Pill {
  workspaceId: string;
  registration: PluginButtonRegistration;
  goal: GoalView;
  /** This client's clock when the daemon answered. */
  readAt: number;
  shown: { title: string; icon: string; label: string };
}

/** The seconds spent on the goal now, by this client's clock. */
export function goalElapsedSeconds(
  goal: GoalView,
  readAt: number,
  now: number,
): number {
  return (
    goal.elapsedSeconds +
    (goal.running ? Math.max(0, Math.floor((now - readAt) / 1000)) : 0)
  );
}

function goalIcon(status: GoalView["status"]): string {
  switch (status) {
    case "active":
    case "notSatisfied":
      return "Goal";
    case "verifying":
      return "ScanSearch";
    case "paused":
      return "CirclePause";
    case "verified":
      return "CircleCheckBig";
    case "failed":
      return "CircleAlert";
  }
}

function present(goal: GoalView, readAt: number, now: number): Pill["shown"] {
  return {
    title: `Goal: ${goalStatusLabel(goal.status)}`,
    icon: goalIcon(goal.status),
    label: `Goal ${formatGoalElapsed(goalElapsedSeconds(goal, readAt, now), {
      seconds: false,
    })}`,
  };
}

/**
 * Shows a pill above the composer of every ZCode agent that has a goal, next
 * to Paseo's Tasks (ADR 27). Returns the cleanup.
 */
export function followGoals(
  client: GoalPillHost,
  Content: ComponentType<PluginButtonContentProps>,
): () => void {
  /** The ZCode agents this client knows, with their workspaces. */
  const agents = new Map<string, string>();
  const pills = new Map<string, Pill>();
  const lifetime = new AbortController();
  let stopped = false,
    reading = false,
    again = false,
    lastRead = Number.NEGATIVE_INFINITY;
  let readTimer: Timer | undefined, labelTimer: Timer | undefined;

  const hide = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const show = (goal: GoalView, workspaceId: string, readAt: number) => {
    const shown = present(goal, readAt, readAt);
    let pill = pills.get(goal.agentId);
    if (pill && pill.workspaceId !== workspaceId) {
      hide(goal.agentId);
      pill = undefined;
    }
    if (!pill) {
      pills.set(goal.agentId, {
        workspaceId,
        goal,
        readAt,
        shown,
        registration: client.addComposerPill({
          id: "goal",
          workspaceId,
          agentId: goal.agentId,
          button: { ...shown, behavior: { kind: "popover", Content } },
        }),
      });
      return;
    }
    pill.goal = goal;
    pill.readAt = readAt;
    relabel(pill, shown);
  };

  // An update of the behavior would close an open popover.
  const relabel = (pill: Pill, next: Pill["shown"]) => {
    const patch = Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) => pill.shown[key as keyof Pill["shown"]] !== value,
      ),
    );
    pill.shown = next;
    if (Object.keys(patch).length) pill.registration.update(patch);
  };

  /** The label counts minutes; the next change is at the next full minute. */
  const scheduleLabels = () => {
    cancel(labelTimer);
    labelTimer = undefined;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const pill of pills.values()) {
      if (!pill.goal.running) continue;
      relabel(pill, present(pill.goal, pill.readAt, now));
      const elapsed = goalElapsedSeconds(pill.goal, pill.readAt, now);
      next = Math.min(next, 60 - (elapsed % 60));
    }
    if (Number.isFinite(next))
      labelTimer = setTimeout(scheduleLabels, next * 1000);
  };

  const apply = (goals: readonly GoalView[]) => {
    const readAt = Date.now();
    const current = new Set<string>();
    for (const goal of goals) {
      const workspaceId = agents.get(goal.agentId);
      if (workspaceId === undefined) continue;
      current.add(goal.agentId);
      show(goal, workspaceId, readAt);
    }
    for (const agentId of [...pills.keys()])
      if (!current.has(agentId)) hide(agentId);
    scheduleLabels();
  };

  const read = async () => {
    reading = true;
    lastRead = Date.now();
    try {
      const { goals } = await client.rpc(zcodeGoals, {});
      if (!stopped) apply(goals);
    } catch (error) {
      // The pills keep what they show; the next read replaces it.
      if (!stopped) console.error("Reading ZCode goals failed", error);
    } finally {
      reading = false;
      if (!stopped) {
        if (again) refresh();
        else if ([...pills.values()].some((p) => goalInProgress(p.goal)))
          readTimer = setTimeout(refresh, IN_PROGRESS_READ_MS);
      }
    }
  };

  /** Reads the goals now, or as soon as the spacing allows. */
  function refresh() {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    again = false;
    cancel(readTimer);
    readTimer = undefined;
    const wait = lastRead + READ_SPACING_MS - Date.now();
    if (wait > 0) readTimer = setTimeout(refresh, wait);
    else void read();
  }

  const track = (agent: {
    id: string;
    provider: string;
    workspaceId?: string | null;
  }): boolean => {
    if (agent.provider !== PROVIDER) return false;
    if (agent.workspaceId) agents.set(agent.id, agent.workspaceId);
    else agents.delete(agent.id);
    return true;
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        // Also delivered after a reconnect: it replaces what is known.
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) track(agent);
          refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            hide(update.agentId);
          } else if (track(update.agent)) refresh();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Observing Paseo agents failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    cancel(readTimer);
    cancel(labelTimer);
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
