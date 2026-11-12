// `/goal` and its alias `/target`. The Server's text input does not interpret
// them: ZCode Desktop reads the command itself and sends a V4 goal command
// (packages/ui/src/v4/slashCommands.ts at a9fe401). The first word decides, as
// there and in ZCode's terminal UI, so an objective cannot begin with one of
// the action words.
export type GoalCommand =
  /** `/goal <objective>` and `/goal replace <objective>`: both replace a goal. */
  | { kind: "set"; objective: string; displayText: string }
  | { kind: "resume" }
  /** A button in Desktop; here the command, as in the terminal UI. */
  | { kind: "pause" }
  /** `clear` and `show` have no V4 command. */
  | { kind: "unsupported"; action: string }
  | { kind: "empty" };

export function parseGoalCommand(text: string): GoalCommand | undefined {
  const displayText = text.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(displayText);
  const name = match?.[1]?.toLowerCase();
  if (name !== "goal" && name !== "target") return undefined;
  const args = match?.[2]?.trim() ?? "";
  if (!args) return { kind: "empty" };
  const action = args.split(/\s+/, 1)[0]!.toLowerCase();
  if (action === "resume" || action === "pause") return { kind: action };
  if (action === "clear" || action === "show")
    return { kind: "unsupported", action };
  const objective =
    action === "replace" ? args.replace(/^replace\s*/i, "").trim() : args;
  return objective
    ? { kind: "set", objective, displayText }
    : { kind: "empty" };
}
