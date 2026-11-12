import type { GoalState } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "./vendor/zcode/packages/ui/src/v4/conversationGoalSummaryModel.js";
import type { GoalView } from "../shared/goal.js";

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

/**
 * The open sessions by Paseo agent. A provider session ID is Paseo's own and
 * changes on every open, so clients name the agent instead (ADR 27).
 */
export class GoalDirectory {
  private readonly sessions = new Map<string, () => GoalState | null>();

  /** Returns the function that removes the session again. */
  register(agentId: string, read: () => GoalState | null): () => void {
    this.sessions.set(agentId, read);
    return () => {
      // Paseo can open an agent's next session before closing the previous one.
      if (this.sessions.get(agentId) === read) this.sessions.delete(agentId);
    };
  }

  views(now = Date.now()): GoalView[] {
    const views: GoalView[] = [];
    for (const [agentId, read] of this.sessions) {
      const goal = read();
      if (goal) views.push(goalView(agentId, goal, now));
    }
    return views;
  }
}
