import { beforeAll, afterAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ZCodeHostBridge } from "./host/bridge.js";
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
