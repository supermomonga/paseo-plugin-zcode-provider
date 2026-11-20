import type { GoalState } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "./vendor/zcode/packages/ui/src/v4/conversationGoalSummaryModel.js";
import type { GoalView } from "../shared/goal.js";
import { logger } from "./logger.js";

/** The goal as ZCode Desktop's status panel lays it out. */
export function goalView(
  agentId: string,
  goal: GoalState,
  now: number,
): GoalView {
  const inProgress =
    goal.status === "active" ||
    goal.status === "verifying" ||
    goal.status === "notSatisfied";
  return {
    agentId,
    status: goal.status,
    // The daemon's clock and ZCode's are the same host's; a client's is not.
    elapsedSeconds: getConversationGoalElapsedSeconds(goal, now),
    running: inProgress && goal.activeRunStartedAtMs != null,
    iterations: buildConversationGoalIterationSummaries(goal).map((row) => ({
      iteration: row.iteration,
      title: row.title,
      completedCount: row.completedCount,
      totalCount: row.totalCount,
      completed: row.completed,
    })),
  };
}

/** What the directory reads from an open session. */
export interface GoalSource {
  /** The conversation's goal now. */
  read(): GoalState | null;
  /** Calls `changed` whenever ZCode changes the goal; returns the stop. */
  watch(changed: () => void): () => void;
}

/**
 * The open sessions by Paseo agent. A provider session ID is Paseo's own and
 * changes on every open, so clients name the agent instead (ADR 27).
 */
export class GoalDirectory {
  private readonly sessions = new Map<string, GoalSource>();
  private readonly listeners = new Set<() => void>();
  private notifying = false;

  /** Returns the function that removes the session again. */
  register(agentId: string, source: GoalSource): () => void {
    this.sessions.set(agentId, source);
    const unwatch = source.watch(() => {
      if (this.sessions.get(agentId) === source) this.changed();
    });
    this.changed();
    return () => {
      unwatch();
      // Paseo can open an agent's next session before closing the previous one.
      if (this.sessions.get(agentId) !== source) return;
      this.sessions.delete(agentId);
      this.changed();
    };
  }

  views(now = Date.now()): GoalView[] {
    const views: GoalView[] = [];
    for (const [agentId, source] of this.sessions) {
      const goal = source.read();
      if (goal) views.push(goalView(agentId, goal, now));
    }
    return views;
  }

  /**
   * Calls `listener` after the goals change: a goal, or which sessions are
   * open. Changes in the same tick reach it once (ADR 30).
   */
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    if (this.notifying || !this.listeners.size) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

/** Where the goals subscription sends its events. */
export interface GoalSubscriber {
  push(event: { goals: GoalView[] }): Promise<void>;
  signal: AbortSignal;
}

/**
 * Serves `zcode.goals.watch`: the goals now, then again whenever they change
 * (ADR 30). The elapsed time is the daemon's when it sends; clients add to it
 * with their own clock while it runs.
 */
export function serveGoals(directory: GoalDirectory) {
  return (_input: unknown, subscriber: GoalSubscriber): void => {
    const { push, signal } = subscriber;
    if (signal.aborted) return;
    const send = () => {
      push({ goals: directory.views() }).catch((error: unknown) => {
        if (!signal.aborted) logger.error("zcode.goals.push_failed", error);
      });
    };
    const stop = directory.watch(send);
    signal.addEventListener("abort", stop, { once: true });
    send();
  };
}
