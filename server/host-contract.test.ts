import { describe, expect, test } from "vitest";
import { AdapterError } from "./errors.js";
import { CURRENT_HOST_PROTOCOL } from "./discovery/manifest.js";
import { adaptHostRequest } from "./host/contract.js";

describe("ZCode host artifact and protocol", () => {
  test.each(["getEntitlementSnapshot", "getCodingPlanResetStatus"])(
    "routes %s through the usage service",
    (method) => {
      expect(CURRENT_HOST_PROTOCOL.serviceChannels.usage).toBe("usage-stats");
      expect(
        adaptHostRequest(CURRENT_HOST_PROTOCOL, method, {
          preferredProviderId: "builtin:zai-coding-plan",
        }),
      ).toEqual({
        service: "usage",
        method,
        params: { preferredProviderId: "builtin:zai-coding-plan" },
      });
      expect(
        adaptHostRequest(CURRENT_HOST_PROTOCOL, "useCodingPlanReset", {}),
      ).toEqual({
        service: "agent",
        method: "useCodingPlanReset",
        params: {},
      });
    },
  );

  test("maps current task interactions to the native task protocol", () => {
    expect(
      adaptHostRequest(CURRENT_HOST_PROTOCOL, "cancelGeneration", {
        sessionId: "s",
        workspacePath: "/w",
      }),
    ).toEqual({
      service: "task",
      method: "stopGeneration",
      params: { taskId: "s", workspacePath: "/w" },
    });
    expect(
      adaptHostRequest(CURRENT_HOST_PROTOCOL, "respondStructuredInput", {
        sessionId: "s",
        requestId: "r",
        response: { action: "accept", content: { answer: "yes" } },
      }),
    ).toEqual({
      service: "task",
      method: "respondElicitation",
      params: {
        taskId: "s",
        requestId: "r",
        action: "accept",
        content: { answer: "yes" },
      },
    });
    expect(
      adaptHostRequest(CURRENT_HOST_PROTOCOL, "respondPermission", {
        sessionId: "s",
        requestId: "r",
        optionId: "allow-once",
        response: { decision: "allow" },
      }),
    ).toEqual({
      service: "task",
      method: "respondPermission",
      params: { taskId: "s", requestId: "r", optionId: "allow-once" },
    });
  });

  test("rejects a missing permission option ID", () => {
    expect(() =>
      adaptHostRequest(CURRENT_HOST_PROTOCOL, "respondPermission", {
        sessionId: "s",
        requestId: "r",
        response: { decision: "deny" },
      }),
    ).toThrow(AdapterError);
  });
});
