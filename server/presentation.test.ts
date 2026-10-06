import { expect, it } from "vitest";
import { presentInteraction, rowTimeline } from "./presentation.js";
import type { PendingInteraction } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
const question: PendingInteraction = {
  interactionId: "question-1",
  kind: "userInput",
  anchorRowId: 1,
  createdAt: 1,
  payload: {
    kind: "userInput",
    prompt: "Choose",
    freeText: true,
    questions: [
      {
        question: "First",
        header: "a",
        options: [{ value: "native-one", label: "One" }],
      },
      {
        question: "Second",
        header: "b",
        multiSelect: true,
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      },
    ],
  },
};
it("preserves native values for multiple questions and accepts explicit empty/free text answers", () => {
  const p = presentInteraction(question)!;
  expect(
    p.answer({
      behavior: "allow",
      updatedInput: { answers: { a: "One", b: "X, Y" } },
    }),
  ).toMatchObject({
    action: "accept",
    content: {
      answer_0: "native-one",
      answer_1: ["x", "y"],
      answers: { First: ["native-one"], Second: ["x", "y"] },
    },
  });
  expect(
    p.answer({
      behavior: "allow",
      updatedInput: { answers: { a: "", b: "free text" } },
    }),
  ).toMatchObject({
    content: { answers: { First: [], Second: ["free text"] } },
  });
});
it.each([false, true])(
  "distinguishes decline and cancel (interrupt=%s)",
  (interrupt) => {
    expect(
      presentInteraction(question)!.answer({ behavior: "deny", interrupt }),
    ).toEqual({ action: interrupt ? "cancel" : "decline" });
  },
);
it("does not offer full access as allow once", () => {
  const p = presentInteraction({
    interactionId: "p",
    kind: "permission",
    anchorRowId: 1,
    createdAt: 1,
    payload: {
      kind: "permission",
      toolCallId: "t",
      toolName: "Bash",
      summary: "run",
      detail: { command: "pwd" },
      options: [
        { optionId: "once", label: "Once", kind: "allowOnce" },
        { optionId: "deny", label: "Deny", kind: "deny" },
      ],
      fullAccessOption: {
        optionId: "fullAccess",
        label: "Full access",
        kind: "custom",
      },
    },
  })!;
  expect(p.request.actions?.map((a) => a.id)).toEqual(["once", "deny"]);
  expect(() =>
    p.answer({ behavior: "allow", selectedActionId: "fullAccess" }),
  ).toThrow();
  expect(p.answer({ behavior: "allow", selectedActionId: "once" })).toEqual({
    optionId: "once",
  });
});
it("marks bounded tool output as truncated", () => {
  const row: any = {
    rowId: 1,
    turnId: "p",
    productTurnId: "p",
    entityId: "t",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: "t",
    toolName: "Bash",
    status: "success",
    inputText: "",
    input: { command: "pwd" },
    output: {
      text: "head and tail",
      truncated: { totalBytes: 90000, ref: "artifact:x" },
    },
  };
  const item = rowTimeline(row);
  expect(item).toMatchObject({
    status: "completed",
    metadata: { truncated: true },
    detail: {
      output: expect.stringContaining("full result has not been loaded"),
    },
  });
});

const hookRow = (executions: Record<string, unknown>[], state = "completed") =>
  ({
    rowId: 7,
    turnId: "p",
    productTurnId: "p",
    entityId: "hook",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "hookInvocation",
    hookInvocationId: "hook",
    hookEventName: "PreToolUse",
    hookCount: executions.length,
    state,
    startedAt: 1,
    lane: "toolBefore",
    executions: executions.map((execution, hookIndex) => ({
      hookRunId: `run-${hookIndex}`,
      hookIndex,
      didExecute: true,
      state: "completed",
      startedAt: 1,
      sourceKind: "plugin",
      ...execution,
    })),
  }) as any;

it("hides running and successful hooks", () => {
  expect(
    rowTimeline(
      hookRow([{ displayName: "check", state: "running" }], "running"),
    ),
  ).toBeUndefined();
  expect(
    rowTimeline(
      hookRow([
        { displayName: "check", outcome: "success" },
        { displayName: "skipped", didExecute: false, outcome: "blocked" },
      ]),
    ),
  ).toBeUndefined();
});

it("reports a finished hook that did not succeed once, with the worst level", () => {
  expect(
    rowTimeline(
      hookRow([
        { displayName: "check", outcome: "success" },
        { displayName: "guard", outcome: "blocked", blockReason: "No rm" },
      ]),
    ),
  ).toEqual({
    id: "zcode:row:7",
    type: "notification",
    level: "warning",
    message: "PreToolUse hook blocked: guard (No rm)",
  });
  expect(
    rowTimeline(
      hookRow(
        [
          { displayName: "slow", outcome: "timed_out" },
          { displayName: "lint", state: "failed" },
        ],
        "failed",
      ),
    ),
  ).toMatchObject({
    level: "error",
    message: "PreToolUse hook timed out: slow; failed: lint",
  });
});

it("reports context compaction only when it ends", () => {
  const marker = (status: string) =>
    ({
      rowId: 8,
      turnId: "p",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "timelineMarker",
      marker: { type: "compact", origin: "auto", status },
    }) as any;
  expect(rowTimeline(marker("running"))).toBeUndefined();
  expect(rowTimeline(marker("success"))).toMatchObject({
    type: "notification",
    message: "Context compaction: success",
  });
});
