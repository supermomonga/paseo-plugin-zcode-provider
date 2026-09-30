import { expect, it, vi } from "vitest";
import { createDiagnosticsHandler } from "./status.js";
import { AdapterError } from "./errors.js";
import type { DiscoveredRuntime } from "./discovery/types.js";
const runtime: DiscoveredRuntime = {
  paths: {
    installRoot: "/runtime",
    executable: "/node",
    cliEntry: "/runtime/agent/zcode.cjs",
    serverEntry: "/runtime/server/remote/zcode-server.cjs",
    appPackage: "/runtime/package.json",
    builtinProviderConfig: "/runtime/agent/provider/zcode-builtin.json",
  },
  identity: {
    appVersion: "3.14.0",
    cliVersion: "0.16.9",
    nodeVersion: "24.20.0",
    platform: "darwin-arm64",
    cliSha256: "a".repeat(64),
    serverSha256: "b".repeat(64),
  },
  compatibility: "supported",
  compatibilityReason: "Minimum version met; runtime checked during use",
  writableInstallRoot: false,
};
it("reports explicit paths and hashes separately without claiming source equality", async () => {
  const smoke = vi.fn();
  const result = await createDiagnosticsHandler({
    discover: async () => runtime,
    smoke,
  })({ smoke: false });
  expect(smoke).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: "ready",
    installRoot: "/runtime",
    nodeExecutable: "/node",
    serverSha256: "b".repeat(64),
  });
  expect(result).not.toHaveProperty("artifactMatch");
});
it("only runs requested version check", async () => {
  const smoke = vi.fn(async () => ({ passed: true }));
  const result = await createDiagnosticsHandler({
    discover: async () => runtime,
    smoke,
  })({ smoke: true });
  expect(smoke).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ smoke: { passed: true } });
});
it("does not publish raw discovery errors", async () => {
  const result = await createDiagnosticsHandler({
    discover: async () => {
      throw new Error("secret");
    },
  })({ smoke: false });
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("reports missing required runtime configuration", async () => {
  const result = await createDiagnosticsHandler({
    discover: async () => {
      throw new AdapterError(
        "RUNTIME_DISCOVERY_FAILED",
        "PASEO_ZCODE_NODE must be an absolute path",
      );
    },
  })({ smoke: false });
  expect(result).toMatchObject({
    status: "failed",
    code: "RUNTIME_DISCOVERY_FAILED",
  });
});
