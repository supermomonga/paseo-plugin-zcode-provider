import { beforeAll, afterAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  serverArguments,
  windowsRuntimeHostEnvironment,
  windowsRuntimeHostPath,
  ZCodeHostBridge,
} from "./host/bridge.js";
import type { DiscoveredRuntime } from "./discovery/types.js";
import { logger } from "./logger.js";
let directory: string, runtime: DiscoveredRuntime;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcode-stdio-contract-"));
  const serverEntry = join(directory, "server.cjs");
  await build({
    entryPoints: [resolve("test/stdio-server.ts")],
    outfile: serverEntry,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  runtime = {
    paths: {
      installRoot: directory,
      executable: process.execPath,
      serverEntry,
      cliEntry: "/unused-agent",
      appPackage: "/unused",
      builtinProviderConfig: "/unused",
    },
    identity: {
      platform: `${process.platform}-${process.arch}`,
      appVersion: "3.14.0",
      cliVersion: "0.16.9",
      nodeVersion: process.versions.node,
      cliSha256: "a".repeat(64),
      serverSha256: "b".repeat(64),
    },
    compatibility: "supported",
    compatibilityReason: "test fixture",
    writableInstallRoot: true,
    source: "environment",
  };
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("negotiates stdio plus V4 and disables question auto resolution", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger);
  try {
    expect(await bridge.request("initialize", {}, z.unknown())).toEqual({
      available: true,
      autoResolution: { askUserQuestionAutoResolutionEnabled: false },
    });
  } finally {
    await bridge.close();
  }
});
it("starts the Server without unsupported capabilities, whatever the caller sets", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger, {
    ...process.env,
    ZCODE_CUA_PRODUCT_HELPER: "1",
    PASEO_ZCODE_SUPPRESSED_PLUGINS: "",
  });
  try {
    expect(
      await bridge.request(
        "readEnvironment",
        ["ZCODE_CUA_PRODUCT_HELPER", "PASEO_ZCODE_SUPPRESSED_PLUGINS"],
        z.unknown(),
      ),
    ).toEqual({
      ZCODE_CUA_PRODUCT_HELPER: "0",
      PASEO_ZCODE_SUPPRESSED_PLUGINS:
        "computer-use@zcode-plugins-official,browser-use@zcode-plugins-official,visualize@zcode-plugins-official",
    });
  } finally {
    await bridge.close();
  }
});
it("gives the Server the runtime's app version, as Desktop does", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger, {
    ...process.env,
    ZCODE_APP_VERSION: "0.0.1",
  });
  try {
    expect(
      await bridge.request(
        "readEnvironment",
        ["ZCODE_APP_VERSION"],
        z.unknown(),
      ),
    ).toEqual({ ZCODE_APP_VERSION: "3.14.0" });
  } finally {
    await bridge.close();
  }
});
it.each(["bad-hello", "bad-v4"])(
  "rejects %s and collects the process",
  async (scenario) => {
    const bridge = ZCodeHostBridge.start(runtime, logger, {
      ...process.env,
      STDIO_SCENARIO: scenario,
    });
    try {
      await expect(
        bridge.request("initialize", {}, z.unknown()),
      ).rejects.toThrow();
    } finally {
      await bridge.close();
    }
  },
);
it("passes positional arguments to settings services", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger);
  try {
    expect(
      await bridge.invoke(
        "provider-settings",
        "savePersonalProviderOverlay",
        ["provider", { api: { baseUrl: "https://example.com" } }, {}],
        z.unknown(),
      ),
    ).toEqual(["provider", { api: { baseUrl: "https://example.com" } }, {}]);
  } finally {
    await bridge.close();
  }
});
it("cancels pending RPC bookkeeping on timeout without retry", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger);
  try {
    await expect(
      bridge.request("never", {}, z.unknown(), 20),
    ).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    expect(await bridge.request("initialize", {}, z.unknown())).toHaveProperty(
      "available",
      true,
    );
  } finally {
    await bridge.close();
  }
});
it("rejects pending requests on abnormal exit", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger);
  try {
    await expect(bridge.request("crash", {}, z.unknown())).rejects.toThrow();
  } finally {
    await bridge.close();
  }
});
it("closes active subscriptions through EOF without racing an unsubscribe RPC", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger);
  await bridge.subscribe(
    { workspacePath: directory, sessionId: "test" },
    () => {},
  );
  await expect(bridge.close()).resolves.toBeUndefined();
  await expect(bridge.close()).resolves.toBeUndefined();
});

// ZCode 3.18 opens its credential store before serving anything (ADR 32).
it("starts 3.18 Servers so that they prepare a credential key", () => {
  const at = (appVersion: string) =>
    serverArguments({
      ...runtime,
      identity: { ...runtime.identity, appVersion },
    });
  expect(at("3.17.2")).toEqual([runtime.paths.serverEntry]);
  for (const version of ["3.18.2", "4.0.0"])
    expect(at(version)).toEqual([
      runtime.paths.serverEntry,
      "--prepare-credentials",
    ]);
});
it("reports a Server that cannot open its credential store", async () => {
  const bridge = ZCodeHostBridge.start(runtime, logger, {
    ...process.env,
    STDIO_SCENARIO: "credential-store",
  });
  try {
    await expect(
      bridge.request("initialize", {}, z.unknown()),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORE_UNAVAILABLE" });
  } finally {
    await bridge.close();
  }
});

// ZCode 3.18 starts its Agent on Windows through zcode-runtime-host.exe (ADR 33).
it("passes the bundled Windows runtime host to 3.18 Servers on Windows", () => {
  const at = (appVersion: string) => ({
    ...runtime,
    identity: { ...runtime.identity, appVersion },
  });
  const helper = windowsRuntimeHostPath(runtime.paths.installRoot, "arm64");
  const present = (path: string) => path === helper;
  for (const version of ["3.18.2", "4.0.0"])
    expect(
      windowsRuntimeHostEnvironment(at(version), {}, "win32", "arm64", present),
    ).toEqual({ ZCODE_RUNTIME_HOST_PATH: helper });
  // Not needed before 3.18 or elsewhere; the daemon's own setting wins.
  expect(
    windowsRuntimeHostEnvironment(at("3.17.2"), {}, "win32", "arm64", present),
  ).toEqual({});
  expect(
    windowsRuntimeHostEnvironment(at("3.18.2"), {}, "linux", "arm64", present),
  ).toEqual({});
  expect(
    windowsRuntimeHostEnvironment(
      at("3.18.2"),
      { ZCODE_RUNTIME_HOST_PATH: "C:\\host.exe" },
      "win32",
      "x64",
      () => false,
    ),
  ).toEqual({});
  // An override runtime without one fails before the Agent would.
  expect(() =>
    windowsRuntimeHostEnvironment(at("3.18.2"), {}, "win32", "x64", present),
  ).toThrow(expect.objectContaining({ code: "WINDOWS_RUNTIME_HOST_MISSING" }));
});
