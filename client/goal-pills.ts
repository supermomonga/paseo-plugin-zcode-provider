import type { ComponentType } from "react";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import {
  formatGoalElapsed,
  goalStatusLabel,
  zcodeGoals,
  type GoalView,
} from "../shared/goal";

/** The provider ID the agents of this plugin carry. */
const PROVIDER = "zcode";
/** How long to wait before following the goals again after a failure. */
const RESUBSCRIBE_MS = 5_000;

export type GoalPillHost = Pick<
  PluginClientContext,
  "addComposerPill" | "subscribe" | "paseo"
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
  /** This client's clock when the daemon's goals arrived. */
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
 * to Paseo's Tasks (ADR 27). The daemon sends the goals whenever they change
 * (ADR 30). Returns the cleanup.
 */
export function followGoals(
  client: GoalPillHost,
  Content: ComponentType<PluginButtonContentProps>,
): () => void {
  /** The ZCode agents this client knows, with their workspaces. */
  const agents = new Map<string, string>();
  const pills = new Map<string, Pill>();
  const lifetime = new AbortController();
  /** The goals the daemon sent last, and when they arrived. */
  let goals: readonly GoalView[] = [],
    receivedAt = 0;
  let stopped = false;
  let retryTimer: Timer | undefined, labelTimer: Timer | undefined;

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

  /** Shows the goals of the agents whose workspace this client knows. */
  const apply = () => {
    const current = new Set<string>();
    for (const goal of goals) {
      const workspaceId = agents.get(goal.agentId);
      if (workspaceId === undefined) continue;
      current.add(goal.agentId);
      show(goal, workspaceId, receivedAt);
    }
    for (const agentId of [...pills.keys()])
      if (!current.has(agentId)) hide(agentId);
    scheduleLabels();
  };

  const follow = () => {
    if (stopped) return;
    // A refused subscription can both reject `ready` and close.
    let retried = false;
    const retry = (error?: Error) => {
      if (stopped || retried) return;
      retried = true;
      if (error) console.error("Following ZCode goals failed", error);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        follow();
      }, RESUBSCRIBE_MS);
    };
    const handle = client.subscribe(
      zcodeGoals,
      {},
      (event) => {
        if (stopped) return;
        goals = event.goals;
        receivedAt = Date.now();
        apply();
      },
      {
        signal: lifetime.signal,
        // The pills keep what they show until the goals arrive again.
        onClosed: ({ error }) => retry(error),
      },
    );
    handle.ready.catch((error: unknown) =>
      retry(error instanceof Error ? error : new Error(String(error))),
    );
  };

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
          apply();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            hide(update.agentId);
          } else if (track(update.agent)) apply();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Observing Paseo agents failed", error);
    });

  follow();

  return () => {
    stopped = true;
    lifetime.abort();
    cancel(retryTimer);
    cancel(labelTimer);
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
