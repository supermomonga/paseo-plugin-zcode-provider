import { ProviderStatusSchema } from "@getpaseo/plugin/server/provider";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredRuntime } from "./discovery/types.js";
import { AdapterError } from "./errors.js";
import { createRuntimeStatus } from "./provider-status.js";

const runtime = (
  overrides: Partial<DiscoveredRuntime> = {},
): DiscoveredRuntime => ({
  source: "managed",
  paths: {
    installRoot: "/data/zcode/runtime",
    executable: "/data/zcode/node/bin/node",
    cliEntry: "/data/zcode/runtime/agent/zcode.cjs",
    serverEntry: "/data/zcode/runtime/server/remote/zcode-server.cjs",
    appPackage: "/data/zcode/runtime/package.json",
    builtinProviderConfig:
      "/data/zcode/runtime/agent/provider/zcode-builtin.json",
  },
  identity: {
    platform: "darwin-arm64",
    appVersion: "3.14.3",
    cliVersion: "0.16.9",
    nodeVersion: "24.21.0",
    cliSha256: "a".repeat(64),
    serverSha256: "b".repeat(64),
  },
  compatibility: "supported",
  compatibilityReason: "Supported",
  writableInstallRoot: true,
  ...overrides,
});

describe("provider status", () => {
  it("reports the runtime in Paseo's diagnostic format without paths", async () => {
    const status = createRuntimeStatus({ discover: async () => runtime() });
    const result = await status({});
    expect(ProviderStatusSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      available: true,
      diagnostic: [
        "ZCode",
        "  Runtime: managed, Server 3.14.3, Agent 0.16.9",
        "  Node.js: 24.21.0",
        "  Platform: darwin-arm64",
      ].join("\n"),
    });
    expect(result.diagnostic).not.toContain("/data/");
  });

  it("names the environment override", async () => {
    const status = createRuntimeStatus({
      discover: async () => runtime({ source: "environment" }),
    });
    expect((await status()).diagnostic).toContain(
      "Runtime: PASEO_ZCODE_RUNTIME, Server 3.14.3",
    );
  });

  it("is unavailable until the managed runtime is set up", async () => {
    const message =
      "ZCode runtime is not set up. Install it in Settings → Plugins → zcode-provider → Settings → Runtime.";
    const status = createRuntimeStatus({
      discover: async () => {
        throw new AdapterError("RUNTIME_SETUP_REQUIRED", message);
      },
    });
    const result = await status();
    expect(ProviderStatusSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      available: false,
      diagnostic: `ZCode\n  Error: ${message}`,
    });
  });

  it("is unavailable for an unsupported override", async () => {
    const status = createRuntimeStatus({
      discover: async () =>
        runtime({
          source: "environment",
          compatibility: "unsupported",
          compatibilityReason: "ZCode Server 3.13.0 is older than 3.14.0",
        }),
    });
    expect(await status()).toEqual({
      available: false,
      diagnostic: "ZCode\n  Error: ZCode Server 3.13.0 is older than 3.14.0",
    });
  });

  it("keeps unexpected errors out of the diagnostic", async () => {
    const status = createRuntimeStatus({
      discover: async () => {
        throw new Error("EACCES /Users/me/secret");
      },
    });
    const result = await status();
    expect(result).toEqual({
      available: false,
      diagnostic: "ZCode\n  Error: ZCode runtime could not be inspected",
    });
  });

  it("inspects the runtime once per interval", async () => {
    let time = 0;
    const discover = vi.fn(async () => runtime());
    const status = createRuntimeStatus({
      discover,
      ttlMs: 30_000,
      now: () => time,
    });
    await Promise.all([status(), status()]);
    time += 29_999;
    await status();
    expect(discover).toHaveBeenCalledTimes(1);
    time += 1;
    await status();
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
