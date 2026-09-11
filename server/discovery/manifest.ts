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

export const MINIMUM_ZCODE_VERSION = { app: "3.11.2", cli: "0.16.5" } as const;
export const HOST_INDEX_RELATIVE_PATH = "out/host/index.js";

// Evidence of an inspected release, not an allowlist for runtime discovery.
export const VERIFIED_ZCODE_ARTIFACT: VerifiedHostArtifact = {
  appVersion: "3.11.2",
  cliVersion: "0.16.5",
  cliSha256: "e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8",
  hostIndexSha256:
    "30911a90dadc5c384959d00d95ccc70c8cf38c74a9cb99c3168b0897d046d215",
  hostRpcModuleSha256:
    "e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31",
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
