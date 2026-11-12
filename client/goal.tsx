import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { type PluginButtonContentProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import {
  formatGoalElapsed,
  goalInProgress,
  goalStatusLabel,
  zcodeGoals,
  type GoalView,
} from "../shared/goal";
import { goalElapsedSeconds } from "./goal-pills";

type Theme = PluginButtonContentProps["theme"];

/** How often the open popover reads a goal that is in progress. */
const READ_MS = 3_000;

function statusColor(status: GoalView["status"], theme: Theme): string {
  switch (status) {
    case "verified":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    case "paused":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foreground;
  }
}

function hint(goal: GoalView): string | undefined {
  if (goal.status === "paused") return "Send /goal resume to continue.";
  if (goalInProgress(goal)) return "Stopping the turn pauses the goal.";
  return undefined;
}

// One row per iteration, as in ZCode Desktop's status panel: a finished
// iteration carries its number, and the count is of its task list.
function Iteration({
  row,
  theme,
}: {
  row: GoalView["iterations"][number];
  theme: Theme;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <View
        style={{
          width: 18,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {row.completed ? (
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.statusSuccess,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: theme.colors.statusSuccess,
                fontSize: 10,
                lineHeight: 12,
              }}
            >
              {row.iteration}
            </Text>
          </View>
        ) : (
          <Icon name="Goal" size={16} color={theme.colors.foregroundMuted} />
        )}
      </View>
      <Text
        numberOfLines={3}
        style={{
          flex: 1,
          minWidth: 0,
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {row.title ?? `Iteration ${row.iteration}`}
      </Text>
      {row.totalCount > 0 ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 13,
            lineHeight: 20,
            fontVariant: ["tabular-nums"],
          }}
        >
          {row.completedCount}/{row.totalCount}
        </Text>
      ) : null}
    </View>
  );
}

/** The body of the Goal pill's popover (ADR 27). */
export function GoalPopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : undefined;
  const fetchGoals = useRpc(zcodeGoals);
  const [read, setRead] = useState<
    { goal: GoalView | null; readAt: number } | "failed" | undefined
  >();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let open = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const { goals } = await fetchGoals({});
        if (!open) return;
        const goal = goals.find((g) => g.agentId === agentId) ?? null;
        setRead({ goal, readAt: Date.now() });
        if (goal && goalInProgress(goal)) timer = setTimeout(load, READ_MS);
      } catch {
        if (open) setRead("failed");
      }
    };
    void load();
    return () => {
      open = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fetchGoals, agentId]);

  const goal = typeof read === "object" ? read.goal : null;
  const running = goal?.running === true;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const muted = {
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    lineHeight: 20,
  };
  const frame = {
    gap: 12,
    ...(layout.compact ? {} : { width: 320 }),
  };
  if (typeof read !== "object" || !goal)
    return (
      <View style={frame}>
        <Text style={muted}>
          {read === undefined
            ? "Loading…"
            : read === "failed"
              ? "The goal could not be read."
              : "This agent has no goal."}
        </Text>
      </View>
    );

  const note = hint(goal);
  return (
    <View style={frame}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            flex: 1,
            color: statusColor(goal.status, theme),
            fontSize: 14,
            lineHeight: 20,
            fontWeight: "600",
          }}
        >
          {goalStatusLabel(goal.status)}
        </Text>
        <Text style={{ ...muted, fontVariant: ["tabular-nums"] }}>
          {formatGoalElapsed(
            goalElapsedSeconds(goal, read.readAt, Math.max(now, read.readAt)),
            { seconds: true },
          )}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        {goal.iterations.map((row) => (
          <Iteration key={row.iteration} row={row} theme={theme} />
        ))}
      </View>
      {note ? <Text style={muted}>{note}</Text> : null}
    </View>
  );
}
