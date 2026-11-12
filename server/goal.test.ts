import { describe, expect, it } from "vitest";
import type { GoalState } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import { GoalDirectory, goalView } from "./goal.js";
import {
  formatGoalElapsed,
  goalInProgress,
  goalStatusLabel,
} from "../shared/goal.js";

const item = (
  content: string,
  status: "pending" | "inProgress" | "completed",
) => ({ id: content, content, status });
const goal = (patch: Partial<GoalState> = {}): GoalState => ({
  targetId: "target-1",
  objective: "Implement and verify 128 service codes",
  summaryTitle: "Service codes",
  timeUsedSeconds: 3600,
  activeRunStartedAtMs: 1_000_000,
  status: "active",
  iteration: 1,
  verifications: [
    {
      iteration: 1,
      outcome: "notSatisfied",
      at: 1,
      anchorRowId: null,
      nextAction: "Type the FopMaster parser",
    },
  ],
  iterations: [
    {
      iteration: 1,
      items: [item("a", "completed"), item("b", "completed")],
      updatedAt: 1,
    },
    {
      iteration: 2,
      items: [item("c", "inProgress"), item("d", "pending")],
      updatedAt: 2,
    },
  ],
  ...patch,
});

describe("goalView", () => {
  it("lays out the iterations as ZCode Desktop does", () => {
    expect(goalView("agent-1", goal(), 1_000_000 + 202_000)).toEqual({
      agentId: "agent-1",
      status: "active",
      // The time ZCode recorded plus the run in progress.
      elapsedSeconds: 3600 + 202,
      running: true,
      iterations: [
        {
          iteration: 1,
          title: "Service codes",
          completedCount: 2,
          totalCount: 2,
          completed: true,
        },
        {
          iteration: 2,
          // The verifier's next action names the following iteration.
          title: "Type the FopMaster parser",
          completedCount: 0,
          totalCount: 2,
          completed: false,
        },
      ],
    });
  });

  it("stops the clock for a goal that is not being worked on", () => {
    const paused = goalView(
      "agent-1",
      goal({ status: "paused", activeRunStartedAtMs: null }),
      9_999_999,
    );
    expect(paused).toMatchObject({ elapsedSeconds: 3600, running: false });
    // A recorded start does not count once the goal is verified.
    expect(
      goalView("agent-1", goal({ status: "verified" }), 9_999_999),
    ).toMatchObject({ elapsedSeconds: 3600, running: false });
  });

  it("falls back to the objective for a goal without a summary title", () => {
    const view = goalView(
      "agent-1",
      goal({
        summaryTitle: null,
        iteration: 0,
        verifications: [],
        iterations: [],
      }),
      1_000_000,
    );
    expect(view.iterations).toEqual([
      {
        iteration: 1,
        title: "Implement and verify 128 service codes",
        completedCount: 0,
        totalCount: 0,
        completed: false,
      },
    ]);
  });
});

describe("GoalDirectory", () => {
  it("lists the goals of the registered sessions", () => {
    const directory = new GoalDirectory();
    let current: GoalState | null = null;
    directory.register("agent-1", () => current);
    directory.register("agent-2", () => goal({ status: "paused" }));
    expect(directory.views(0).map((v) => v.agentId)).toEqual(["agent-2"]);
    current = goal();
    expect(directory.views(0).map((v) => [v.agentId, v.status])).toEqual([
      ["agent-1", "active"],
      ["agent-2", "paused"],
    ]);
  });

  it("keeps an agent's newer session when the older one closes", () => {
    const directory = new GoalDirectory();
    const forgetOld = directory.register("agent-1", () => goal());
    const forgetNew = directory.register("agent-1", () =>
      goal({ status: "paused" }),
    );
    forgetOld();
    expect(directory.views(0)).toMatchObject([{ status: "paused" }]);
    forgetNew();
    expect(directory.views(0)).toEqual([]);
  });
});

describe("goal presentation", () => {
  it("writes the elapsed time as ZCode Desktop does", () => {
    const seconds = { seconds: true };
    expect(formatGoalElapsed(3802, seconds)).toBe("1h 3m 22s");
    expect(formatGoalElapsed(3600, seconds)).toBe("1h");
    expect(formatGoalElapsed(3605, seconds)).toBe("1h 5s");
    expect(formatGoalElapsed(0, seconds)).toBe("0s");
    expect(formatGoalElapsed(-5, seconds)).toBe("0s");
  });

  it("drops the seconds for the pill", () => {
    const minutes = { seconds: false };
    expect(formatGoalElapsed(3802, minutes)).toBe("1h 3m");
    expect(formatGoalElapsed(7200, minutes)).toBe("2h");
    expect(formatGoalElapsed(125, minutes)).toBe("2m");
    expect(formatGoalElapsed(59, minutes)).toBe("<1m");
  });

  it("tells which goals can change on their own", () => {
    const view = (status: GoalState["status"]) =>
      goalView("agent-1", goal({ status }), 0);
    expect(
      (
        [
          "active",
          "verifying",
          "notSatisfied",
          "paused",
          "verified",
          "failed",
        ] as const
      ).map((status) => goalInProgress(view(status))),
    ).toEqual([true, true, true, false, false, false]);
    expect(goalStatusLabel("notSatisfied")).toBe("Incomplete, continuing");
  });
});
