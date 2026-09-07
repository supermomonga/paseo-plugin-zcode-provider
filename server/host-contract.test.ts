import { describe, expect, test } from "vitest";
import { AdapterError } from "./errors.js";
import {
  resolvedHostMismatch,
  resolveHostContractPaths,
} from "./discovery/host-contract.js";
import {
  CURRENT_HOST_PROTOCOL,
  CURRENT_ZCODE_ARTIFACT,
} from "./discovery/manifest.js";
import type { HostProtocolDescriptor } from "./discovery/types.js";
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

  test("rejects host paths that escape the install root", () => {
    expect(() =>
      resolveHostContractPaths(
        "/Applications/ZCode.app",
        "/Applications/ZCode.app/app.asar",
        {
          ...CURRENT_ZCODE_ARTIFACT,
          hostRpcModuleRelativePath: "../../../outside.js",
        },
      ),
    ).toThrow("outside the install root");
  });

  test("rejects host hashes and required RPC exports independently", () => {
    const valid = {
      hostIndexSha256: CURRENT_ZCODE_ARTIFACT.hostIndexSha256,
      hostRpcModuleSha256: CURRENT_ZCODE_ARTIFACT.hostRpcModuleSha256,
      exports: ["g", "i", "j"],
    };
    expect(
      resolvedHostMismatch(
        CURRENT_ZCODE_ARTIFACT,
        CURRENT_HOST_PROTOCOL,
        valid,
      ),
    ).toBeUndefined();
    expect(
      resolvedHostMismatch(CURRENT_ZCODE_ARTIFACT, CURRENT_HOST_PROTOCOL, {
        ...valid,
        hostIndexSha256: "c".repeat(64),
      }),
    ).toBe("ZCode host index hash does not match the compatibility manifest");
    expect(
      resolvedHostMismatch(CURRENT_ZCODE_ARTIFACT, CURRENT_HOST_PROTOCOL, {
        ...valid,
        hostRpcModuleSha256: "c".repeat(64),
      }),
    ).toBe(
      "ZCode host RPC module hash does not match the compatibility manifest",
    );
    expect(
      resolvedHostMismatch(CURRENT_ZCODE_ARTIFACT, CURRENT_HOST_PROTOCOL, {
        ...valid,
        exports: ["g", "i"],
      }),
    ).toBe("ZCode host RPC module is missing required export: j");
  });

  test("rejects an operation whose service channel is unavailable", () => {
    const protocol = structuredClone(
      CURRENT_HOST_PROTOCOL,
    ) as HostProtocolDescriptor;
    delete (protocol.serviceChannels as { task?: string }).task;
    expect(
      resolvedHostMismatch(CURRENT_ZCODE_ARTIFACT, protocol, {
        hostIndexSha256: CURRENT_ZCODE_ARTIFACT.hostIndexSha256,
        hostRpcModuleSha256: CURRENT_ZCODE_ARTIFACT.hostRpcModuleSha256,
        exports: ["g", "i", "j"],
      }),
    ).toBe(
      "ZCode host protocol operation cancelGeneration references an unavailable service: task",
    );
  });
});
