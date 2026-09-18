import { describe, expect, test } from "vitest";
import {
  DynamicEventSchema,
  PermissionRequestSchema,
  SessionSnapshotSchema,
} from "./protocol/v1/host-schemas.js";
import { snapshot } from "../test/fake-host.js";

describe("ZCode host schemas", () => {
  test("accepts a 3.12.3 session before a model is selected", () => {
    const value = snapshot("/workspace");
    Reflect.deleteProperty(value.settings.model, "current");
    expect(SessionSnapshotSchema.safeParse(value).success).toBe(true);
  });

  test.each([false, true])(
    "accepts the 3.12.3 runtime-header model selection (accountAccess=%s)",
    (hasAccount) => {
      expect(
        DynamicEventSchema.safeParse({
          type: "providerRuntimeHeaders.request",
          request: {
            requestId: "r",
            sessionId: "s",
            workspace: { workspacePath: "/w" },
            modelSelection: {
              providerId: "p",
              modelId: "m",
              options: { reasoningLevel: "high" },
            },
            providerId: "p",
            ...(hasAccount
              ? {
                  accountAccess: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "individual-coding-plan",
                    entitled: true,
                  },
                }
              : {}),
            reason: "model-request",
          },
        }).success,
      ).toBe(true);
    },
  );
  test("accepts the observed permission shape without widening it", () => {
    const request = {
      requestId: "permission-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "Write",
      reason: "Write a file",
      riskLevel: "medium" as const,
      input: { path: "/tmp/example" },
      options: [
        {
          optionId: "allow-once",
          kind: "allow_once",
          name: "Allow once",
          response: { decision: "allow" as const },
        },
        {
          optionId: "deny-once",
          kind: "deny_once",
          name: "Deny",
          response: { decision: "deny" as const, reason: "Denied" },
        },
      ],
    };
    expect(PermissionRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      PermissionRequestSchema.parse({ ...request, unexpected: true }),
    ).toThrow();
  });

  test("accepts observed model and tool events and rejects malformed sequence", () => {
    const base = {
      eventId: "event-1",
      sessionId: "session-1",
      turnId: "turn-1",
      seq: 1,
      timestamp: 1,
      deliveryKind: "desktop-continuous",
    };
    expect(
      DynamicEventSchema.parse({
        type: "session.event",
        event: {
          ...base,
          type: "model.streaming",
          payload: { kind: "text_delta", delta: "hi" },
        },
      }),
    ).toBeTruthy();
    expect(
      DynamicEventSchema.parse({
        type: "session.event",
        event: {
          ...base,
          eventId: "event-2",
          seq: 2,
          type: "tool.updated",
          payload: { kind: "result", toolCallId: "tool-1" },
        },
      }),
    ).toBeTruthy();
    expect(
      DynamicEventSchema.parse({
        type: "session.event",
        event: {
          ...base,
          eventId: "event-3",
          seq: 3,
          type: "tool.updated",
          payload: {
            kind: "progress",
            toolCallId: "tool-1",
            toolName: "Bash",
            elapsedMs: 1_500,
            pid: 42,
            stdoutBytes: 120,
            stderrBytes: 5,
            outputBytes: 125,
            stdoutTail: "partial output",
            stderrTail: "warning",
          },
        },
      }),
    ).toBeTruthy();
    expect(() =>
      DynamicEventSchema.parse({
        type: "session.event",
        event: {
          ...base,
          seq: -1,
          type: "turn.completed",
          payload: { resultType: "success" },
        },
      }),
    ).toThrow();
  });
});
