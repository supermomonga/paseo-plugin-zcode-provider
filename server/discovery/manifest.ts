import { gte, parse } from "semver";
import type {
  VerifiedHostArtifact,
  HostProtocolDescriptor,
  RuntimeIdentity,
} from "./types.js";

export const CURRENT_HOST_PROTOCOL: HostProtocolDescriptor = {
  id: "zcode-task-v1",
  serviceChannels: {
    agent: "zcode-agent",
    task: "zcode-task",
    usage: "usage-stats",
    modelSelection: "model-selection",
  },
  operations: {
    cancelGeneration: {
      method: "stopGeneration",
      service: "task",
      sessionParameter: "taskId",
    },
    respondStructuredInput: {
      method: "respondElicitation",
      service: "task",
      sessionParameter: "taskId",
    },
    respondPermission: {
      method: "respondPermission",
      service: "task",
      sessionParameter: "taskId",
    },
  },
};

export const MINIMUM_ZCODE_VERSION = { app: "3.12.3", cli: "0.16.5" } as const;
export const HOST_INDEX_RELATIVE_PATH = "out/host/index.js";

// Evidence of an inspected release, not an allowlist for runtime discovery.
export const VERIFIED_ZCODE_ARTIFACT: VerifiedHostArtifact = {
  appVersion: "3.12.3",
  cliVersion: "0.16.5",
  cliSha256: "da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01",
  hostIndexSha256:
    "c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e",
  hostRpcModuleSha256:
    "718fdf848fb173372264fd40c0d155d3953cb737a4439c64ff1ef7c2a33f9c82",
};

export function assessCompatibility(identity: RuntimeIdentity): {
  status: "supported" | "unsupported";
  reason: string;
} {
  for (const [component, version, minimum] of [
    ["app", identity.appVersion, MINIMUM_ZCODE_VERSION.app],
    ["CLI", identity.cliVersion, MINIMUM_ZCODE_VERSION.cli],
  ] as const) {
    const parsed = version === undefined ? null : parse(version);
    if (
      parsed === null ||
      parsed.prerelease.length !== 0 ||
      !gte(parsed, minimum)
    ) {
      return {
        status: "unsupported",
        reason: `ZCode ${component} requires a stable version >=${minimum}`,
      };
    }
  }
  return {
    status: "supported",
    reason:
      "ZCode app and CLI meet the minimum stable versions; runtime compatibility is checked during use",
  };
}
