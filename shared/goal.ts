import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// ZCode's goal as its Desktop status panel shows it (ADR 27): one row per
// iteration and the time spent. The daemon reads it from the V4 state of the
// agent's Server; nothing here is stored.
const goalIterationSchema = z
  .object({
    iteration: z.number().int().positive(),
    /** Null when ZCode has no title for the iteration. */
    title: z.string().nullable(),
    completedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    completed: z.boolean(),
  })
  .strict();

export const goalViewSchema = z
  .object({
    /** Paseo's agent, from the PASEO_AGENT_ID of the session's launch. */
    agentId: z.string(),
    status: z.enum([
      "active",
      "paused",
      "verifying",
      "verified",
      "notSatisfied",
      "failed",
    ]),
    /** Seconds spent on the goal when the daemon answered. */
    elapsedSeconds: z.number().int().nonnegative(),
    /** Whether the time keeps counting. The client's clock adds to it. */
    running: z.boolean(),
    iterations: z.array(goalIterationSchema),
  })
  .strict();
export type GoalView = z.output<typeof goalViewSchema>;

// The goals of the agents that have a ZCode session open on this host.
export const zcodeGoals = defineRpc({
  name: "zcode.goals",
  input: z.object({}).strict(),
  output: z.object({ goals: z.array(goalViewSchema) }).strict(),
});

/** A goal that can change without the agent's state changing in Paseo. */
export function goalInProgress(goal: GoalView): boolean {
  return (
    goal.status === "active" ||
    goal.status === "verifying" ||
    goal.status === "notSatisfied"
  );
}

export function goalStatusLabel(status: GoalView["status"]): string {
  switch (status) {
    case "active":
      return "In progress";
    case "verifying":
      return "Verifying";
    case "notSatisfied":
      return "Incomplete, continuing";
    case "paused":
      return "Paused";
    case "verified":
      return "Complete";
    case "failed":
      return "Verification failed";
  }
}

/**
 * `1h 3m 22s`, as ZCode Desktop's status panel writes it: units that are zero
 * are left out. Without seconds, `1h 3m`, and `<1m` below a minute.
 */
export function formatGoalElapsed(
  totalSeconds: number,
  options: { seconds: boolean },
): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600),
    minutes = Math.floor((whole % 3600) / 60),
    seconds = whole % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (options.seconds && (seconds || !parts.length)) parts.push(`${seconds}s`);
  return parts.join(" ") || "<1m";
}
