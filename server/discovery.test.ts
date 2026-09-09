import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { posix, win32 } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CURRENT_ZCODE_ARTIFACT as artifact } from "./discovery/manifest.js";

const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

async function fixture(target: string) {
  vi.resetModules();
  const [platform, architecture] = target.split("-") as [
    NodeJS.Platform,
    string,
  ];
  const path = platform === "win32" ? win32 : posix;
  vi.doMock("node:path", () => path);
  const metadata = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: target,
    source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
  };
  const files = {
    realpath: vi.fn(async (value: string) => value),
    access: vi.fn(async () => {}),
    stat: vi.fn(async () => ({
      mode: 0o755,
      isFile: () => true,
      isDirectory: () => false,
    })),
    readFile: vi.fn(async (value: string) =>
      value.endsWith(".node-bundle-meta.json")
        ? JSON.stringify(metadata)
        : "cli",
    ),
    constants: { R_OK: 4, X_OK: 1 },
  };
  vi.doMock("node:fs/promises", () => files);
  const inspection = {
    hostIndexSha256: artifact.hostIndexSha256,
    hostRpcModuleSha256: artifact.hostRpcModuleSha256,
    exports: ["g", "i", "j"],
  };
  const children: Array<
    EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    }
  > = [];
  let packageVersion = "3.11.2";
  let stall = false;
  let onSpawn = () => {};
  const spawn = vi.fn(
    (command: string, args: string[], options: { signal?: AbortSignal }) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(),
      });
      children.push(child);
      onSpawn();
      queueMicrotask(() => {
        if (args[1]?.includes("PASEO_ZCODE_HOST_INDEX")) {
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0, null);
          return;
        }
        if (options.signal?.aborted) {
          child.emit("error", new DOMException("Aborted", "AbortError"));
          return;
        }
        if (stall) {
          child.emit("exit", null, "SIGTERM");
          return;
        }
        const output = command.includes("PlistBuddy")
          ? "3.11.2"
          : args.includes("version")
            ? "0.16.5"
            : args[1]?.includes("const value=require")
              ? packageVersion
              : JSON.stringify(inspection);
        child.stdout.end(output);
        child.emit("exit", 0, null);
      });
      return child;
    },
  );
  vi.doMock("node:child_process", () => ({ spawn }));
  const discovery = await import("./discovery/discover.js");
  return {
    ...discovery,
    platform,
    architecture,
    path,
    files,
    metadata,
    inspection,
    spawn,
    children,
    setVersion: (value: string) => {
      packageVersion = value;
    },
    onSpawn: (callback: () => void) => {
      onSpawn = callback;
    },
    terminate: () => {
      stall = true;
    },
  };
}

afterEach(() => {
  vi.doUnmock("node:path");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("runtime discovery on each OS", () => {
  test.each(targets)(
    "discovers and starts the bundled host on %s",
    async (target) => {
      const f = await fixture(target);
      const signal = new AbortController().signal;
      const environment = {
        TEST_ENV: "retained",
        ...(f.platform === "win32"
          ? { LOCALAPPDATA: "C:\\Users\\code\\AppData\\Local" }
          : {}),
      };
      const runtime = await f.discoverRuntime({
        platform: f.platform,
        architecture: f.architecture,
        environment,
        signal,
      });
      expect(runtime.compatibility).toBe("supported");
      expect(runtime.identity.platform).toBe(target);
      const root =
        f.platform === "win32"
          ? "C:\\Users\\code\\AppData\\Local\\Programs\\ZCode"
          : f.platform === "linux"
            ? "/opt/ZCode"
            : "/Applications/ZCode.app";
      expect(runtime.paths.installRoot).toBe(root);
      expect(runtime.paths.executable).toBe(
        f.path.join(
          root,
          f.platform === "win32"
            ? "ZCode.exe"
            : f.platform === "linux"
              ? "zcode"
              : "Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper",
        ),
      );
      for (const [, , options] of f.spawn.mock.calls)
        expect(options).toMatchObject({
          signal,
          timeout: 60000,
          env: { TEST_ENV: "retained", ELECTRON_RUN_AS_NODE: "1" },
        });
      if (f.platform !== "darwin") {
        expect(
          f.spawn.mock.calls.some(([command]) =>
            command.includes("PlistBuddy"),
          ),
        ).toBe(false);
        expect(
          f.spawn.mock.calls.some(([, args]) =>
            args[1]?.includes(JSON.stringify(runtime.paths.appPackage)),
          ),
        ).toBe(true);
      }
      const { ZCodeHostBridge } = await import("./host/bridge.js");
      ZCodeHostBridge.start(runtime, { log() {}, error() {} }, environment);
      expect(f.spawn.mock.calls.at(-1)).toEqual([
        runtime.paths.executable,
        ["-e", expect.any(String)],
        expect.objectContaining({
          cwd: root,
          env: expect.objectContaining({
            TEST_ENV: "retained",
            ELECTRON_RUN_AS_NODE: "1",
            PASEO_ZCODE_HOST_INDEX: runtime.resolvedHost?.hostIndex,
          }),
        }),
      ]);
    },
  );

  test.each([
    "C:\\Users\\code\\AppData\\Local",
    "D:\\Users\\開発 User\\AppData\\Local",
  ])(
    "discovers the Windows user installation under %s",
    async (localAppData) => {
      const f = await fixture("win32-x64");
      const root = `${localAppData}\\Programs\\ZCode`;
      f.files.realpath.mockImplementation(async (value) => {
        if (value !== root && !value.startsWith(`${root}\\`))
          throw new Error("missing");
        return value;
      });
      const runtime = await f.discoverRuntime({
        platform: f.platform,
        architecture: f.architecture,
        environment: { LOCALAPPDATA: localAppData },
      });
      expect(runtime.paths).toEqual({
        installRoot: root,
        executable: `${root}\\ZCode.exe`,
        cliEntry: `${root}\\resources\\glm\\zcode.cjs`,
        metadata: `${root}\\resources\\glm\\.node-bundle-meta.json`,
        appPackage: `${root}\\resources\\app.asar\\package.json`,
        hostArchive: `${root}\\resources\\app.asar`,
      });
      expect(runtime.compatibility).toBe("supported");
      expect(f.spawn).toHaveBeenCalledWith(
        `${root}\\ZCode.exe`,
        [`${root}\\resources\\glm\\zcode.cjs`, "version"],
        expect.objectContaining({
          cwd: root,
          env: { LOCALAPPDATA: localAppData, ELECTRON_RUN_AS_NODE: "1" },
        }),
      );
    },
  );

  test.each([undefined, "", "relative", "C:relative"])(
    "rejects invalid Windows LOCALAPPDATA %s only when using the default",
    async (localAppData) => {
      const f = await fixture("win32-x64");
      const options = {
        platform: f.platform,
        architecture: f.architecture,
        environment:
          localAppData === undefined ? {} : { LOCALAPPDATA: localAppData },
      };
      await expect(f.discoverRuntime(options)).rejects.toMatchObject({
        code: "INVALID_CONFIGURATION",
        message: expect.stringMatching(/LOCALAPPDATA.*PASEO_ZCODE_INSTALL/u),
      });
      expect(f.files.realpath).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      const root = "C:\\Program Files\\ZCode";
      expect(
        (await f.discoverRuntime({ ...options, installRoot: root })).paths
          .installRoot,
      ).toBe(root);
      expect(
        (
          await f.discoverRuntime({
            ...options,
            environment: { ...options.environment, PASEO_ZCODE_INSTALL: root },
          })
        ).paths.installRoot,
      ).toBe(root);
    },
  );

  test("does not search another Windows installation when the default is missing", async () => {
    const f = await fixture("win32-x64");
    f.files.realpath.mockRejectedValueOnce(new Error("missing"));
    await expect(
      f.discoverRuntime({
        platform: f.platform,
        architecture: f.architecture,
        environment: { LOCALAPPDATA: "C:\\Users\\code\\AppData\\Local" },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_DISCOVERY_FAILED" });
    expect(f.files.realpath.mock.calls).toEqual([
      ["C:\\Users\\code\\AppData\\Local\\Programs\\ZCode"],
    ]);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  test.each(["darwin-arm64", "linux-x64", "win32-x64"])(
    "uses explicit roots without fallback on %s",
    async (target) => {
      const f = await fixture(target);
      const root =
        f.platform === "win32"
          ? "D:\\Custom Apps\\ZCode"
          : "/custom apps/ZCode";
      const options = {
        platform: f.platform,
        architecture: f.architecture,
        environment: { PASEO_ZCODE_INSTALL: root },
      };
      expect((await f.discoverRuntime(options)).paths.installRoot).toBe(root);
      const explicit = f.path.join(root, "explicit");
      expect(
        (await f.discoverRuntime({ ...options, installRoot: explicit })).paths
          .installRoot,
      ).toBe(explicit);
      await expect(
        f.discoverRuntime({ ...options, installRoot: "relative" }),
      ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
      f.files.realpath.mockRejectedValueOnce(new Error("missing"));
      await expect(f.discoverRuntime(options)).rejects.toMatchObject({
        code: "RUNTIME_DISCOVERY_FAILED",
      });
    },
  );

  test("rejects unsupported targets and mismatched metadata before spawning", async () => {
    const f = await fixture("linux-x64");
    for (const [platform, architecture] of [
      ["freebsd", "x64"],
      ["win32", "arm64"],
      ["linux", "ia32"],
    ] as const) {
      await expect(
        f.discoverRuntime({ platform, architecture }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    }
    await expect(
      f.discoverRuntime({ platform: "linux", architecture: "arm64" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    expect(f.spawn).not.toHaveBeenCalled();
    for (const value of [
      { ...f.metadata, runtime: "node" },
      { ...f.metadata, entry: "other" },
      { ...f.metadata, source: "other" },
      { ...f.metadata, extra: true },
    ])
      expect(() => f.validateBundleMetadata(value, "linux-x64")).toThrow();
  });

  test("rejects missing files and paths escaping the install root", async () => {
    const f = await fixture("linux-x64");
    f.files.access.mockRejectedValueOnce(new Error("missing"));
    await expect(
      f.discoverRuntime({ platform: "linux", architecture: "x64" }),
    ).rejects.toMatchObject({ code: "RUNTIME_DISCOVERY_FAILED" });
    f.files.realpath
      .mockResolvedValueOnce("/opt/ZCode")
      .mockResolvedValueOnce("/elsewhere/zcode");
    await expect(
      f.discoverRuntime({ platform: "linux", architecture: "x64" }),
    ).rejects.toMatchObject({ code: "RUNTIME_DISCOVERY_FAILED" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  test("rejects missing versions and incompatible hosts", async () => {
    const f = await fixture("linux-x64");
    const options = { platform: f.platform, architecture: f.architecture };
    f.setVersion("");
    await expect(f.discoverRuntime(options)).rejects.toMatchObject({
      code: "RUNTIME_DISCOVERY_FAILED",
    });
    f.setVersion("3.11.3");
    expect((await f.discoverRuntime(options)).compatibility).toBe(
      "unsupported",
    );
    f.setVersion("3.11.2");
    f.inspection.hostIndexSha256 = "0".repeat(64);
    expect((await f.discoverRuntime(options)).compatibility).toBe(
      "unsupported",
    );
    f.inspection.hostIndexSha256 = artifact.hostIndexSha256;
    f.inspection.exports = [];
    expect((await f.discoverRuntime(options)).compatibility).toBe(
      "unsupported",
    );
  });

  test("propagates cancellation and rejects timed-out inspection processes", async () => {
    const f = await fixture("linux-x64");
    const options = { platform: f.platform, architecture: f.architecture };
    await expect(
      f.discoverRuntime({ ...options, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.spawn).not.toHaveBeenCalled();
    const controller = new AbortController();
    f.onSpawn(() => controller.abort());
    await expect(
      f.discoverRuntime({ ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    f.onSpawn(() => {});
    f.terminate();
    await expect(f.discoverRuntime(options)).rejects.toMatchObject({
      code: "NATIVE_EXITED",
    });
    expect(f.spawn.mock.calls[0]?.[2]).toMatchObject({
      timeout: 60000,
      killSignal: "SIGTERM",
    });
  });
});
