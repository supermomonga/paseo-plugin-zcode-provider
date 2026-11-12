import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "./goal-command.js";

describe("parseGoalCommand", () => {
  it("leaves other input alone", () => {
    for (const text of ["hello", "/goalpost", "/plan Ship it", "goal Ship it"])
      expect(parseGoalCommand(text)).toBeUndefined();
  });

  it("reads an objective, with or without replace", () => {
    expect(parseGoalCommand("  /goal Ship it\nby Friday  ")).toEqual({
      kind: "set",
      objective: "Ship it\nby Friday",
      displayText: "/goal Ship it\nby Friday",
    });
    expect(parseGoalCommand("/Target REPLACE  Ship it")).toEqual({
      kind: "set",
      objective: "Ship it",
      displayText: "/Target REPLACE  Ship it",
    });
  });

  it("reads the actions from the first word", () => {
    expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal Resume now")).toEqual({ kind: "resume" });
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("/goal clear")).toEqual({
      kind: "unsupported",
      action: "clear",
    });
    expect(parseGoalCommand("/goal show")).toEqual({
      kind: "unsupported",
      action: "show",
    });
  });

  it("reports a command without an objective", () => {
    for (const text of ["/goal", "/goal   ", "/target", "/goal replace"])
      expect(parseGoalCommand(text)).toEqual({ kind: "empty" });
  });
});
