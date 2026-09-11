import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsHandler } from "./status.js";
import type {
  DiscoveredRuntime,
  RuntimeSmokeResult,
} from "./discovery/types.js";
import { AdapterError } from "./errors.js";

function runtime(
  overrides: Partial<DiscoveredRuntime> = {},
): DiscoveredRuntime {
  return {
    paths: {
      installRoot: "/opt/ZCode",
      executable: "/opt/ZCode/zcode",
      cliEntry: "/opt/ZCode/resources/glm/zcode.cjs",
      metadata: "/opt/ZCode/resources/glm/.node-bundle-meta.json",
      appPackage: "/opt/ZCode/resources/app.asar/package.json",
      hostArchive: "/opt/ZCode/resources/app.asar",
    },
    identity: {
      platform: "linux-x64",
      appVersion: "3.12.0",
      cliVersion: "0.17.0",
      cliSha256: "a".repeat(64),
      metadataSha256: "b".repeat(64),
      bundle: {
        runtime: "electron-node",
        entry: "zcode.cjs",
        platform: "linux-x64",
        source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
      },
    },
    compatibility: "supported",
    compatibilityReason: "ZCode 3.12.0 is supported",
    writableInstallRoot: false,
    ...overrides,
  };
}

function dependencies(
  overrides: {
    discover?: () => Promise<DiscoveredRuntime>;
    smoke?: () => Promise<RuntimeSmokeResult>;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  return {
    environment: overrides.environment ?? {},
    sessionsDirectory: "/state/zcode/sessions",
    providerVersion: "9.9.9",
    discover: overrides.discover ?? (async () => runtime()),
    smoke:
      overrides.smoke ??
      (async () => {
        throw new Error("smoke must not run unless requested");
      }),
  };
}

describe("ZCode diagnostics handler", () => {
  it("reports discovery fields without running the smoke check", async () => {
    const discover = vi.fn(async () =>
      runtime({
        resolvedHost: {
          artifactMatch: false,
        } as DiscoveredRuntime["resolvedHost"],
      }),
    );
    const smoke = vi.fn();
    const handler = createDiagnosticsHandler({
      ...dependencies({ discover }),
      smoke: smoke as never,
    });

    const result = await handler({ smoke: false });

    expect(smoke).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ready",
      providerVersion: "9.9.9",
      installRoot: "/opt/ZCode",
      installRootSource: "default",
      platform: "linux-x64",
      appVersion: "3.12.0",
      cliVersion: "0.17.0",
      compatibility: "supported",
      compatibilityReason: "ZCode 3.12.0 is supported",
      artifactMatch: false,
      writableInstallRoot: false,
      sessionsDirectory: "/state/zcode/sessions",
    });
  });

  it("runs the requested smoke check and reports the environment source", async () => {
    const environment = { PASEO_ZCODE_INSTALL: "/custom/ZCode" };
    const smoke = vi.fn(async () => ({
      passed: true,
      cliVersion: "0.17.0",
      doctorPassed: true,
      authentication: "unknown" as const,
    }));
    const discover = vi.fn(async () => runtime());
    const handler = createDiagnosticsHandler(
      dependencies({ discover, smoke, environment }),
    );

    const result = await handler({ smoke: true });

    expect(discover).toHaveBeenCalledWith({ environment });
    expect(smoke).toHaveBeenCalledWith(expect.anything(), environment);
    expect(result).toMatchObject({
      status: "ready",
      installRootSource: "environment",
      smoke: {
        passed: true,
        cliVersion: "0.17.0",
        doctorPassed: true,
        authentication: "unknown",
      },
    });
  });

  it("reports an unsupported runtime as a successful read", async () => {
    const handler = createDiagnosticsHandler(
      dependencies({
        discover: async () =>
          runtime({
            compatibility: "unsupported",
            compatibilityReason: "ZCode 3.10.0 is older than 3.11.2",
          }),
      }),
    );

    const result = await handler({ smoke: false });

    expect(result).toMatchObject({
      status: "ready",
      compatibility: "unsupported",
      compatibilityReason: "ZCode 3.10.0 is older than 3.11.2",
    });
  });

  it("fails the smoke check without leaking native output", async () => {
    const error = new AdapterError(
      "RUNTIME_SMOKE_FAILED",
      "ZCode runtime smoke failed",
      {},
      { cause: new Error("native stderr secret") },
      { stage: "smoke", check: "cli-smoke", platform: "linux-x64" },
    );
    const handler = createDiagnosticsHandler(
      dependencies({
        smoke: async () => {
          throw error;
        },
      }),
    );

    const result = await handler({ smoke: true });

    expect(result).toMatchObject({
      status: "failed",
      code: "RUNTIME_SMOKE_FAILED",
      message: "ZCode runtime smoke failed",
    });
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.diagnostic).not.toContain("native stderr secret");
    expect(JSON.parse(result.diagnostic)).toMatchObject({
      code: "RUNTIME_SMOKE_FAILED",
      stage: "smoke",
      check: "cli-smoke",
    });
  });

  it("hides unexpected error messages behind the diagnostic report", async () => {
    const handler = createDiagnosticsHandler(
      dependencies({
        discover: async () => {
          throw new Error("raw native error with credential=secret");
        },
      }),
    );

    const result = await handler({ smoke: false });

    expect(result).toMatchObject({
      status: "failed",
      code: "UNKNOWN",
      message: "ZCode diagnostics failed",
    });
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.diagnostic).not.toContain("credential=secret");
  });
});
