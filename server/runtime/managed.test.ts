import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManagedRuntimeInstaller,
  installedVersions,
  isInstalled,
  managedRuntimeRoot,
  resolveManagedRuntime,
} from "./managed.js";
import {
  MANAGED_NODE_ARCHIVES,
  MANAGED_ZCODE_ARCHIVE,
  managedPlatform,
} from "./pins.js";
import {
  managedFixture as fixture,
  removeTemporaryDirectories,
  temporary,
} from "../../test/managed-runtime-fixture.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTemporaryDirectories();
});

async function finish(installer: ManagedRuntimeInstaller) {
  expect(installer.start()).toBe(true);
  await installer.settled();
  return installer.state();
}

describe("pins", () => {
  it("pins every managed Node.js archive by SHA-256 and size", () => {
    for (const archive of Object.values(MANAGED_NODE_ARCHIVES)) {
      expect(archive.url).toMatch(/^https:\/\/nodejs\.org\/dist\//u);
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(archive.size).toBeGreaterThan(0);
    }
  });

  it("pins the published ZCode runtime archive", () => {
    expect(MANAGED_ZCODE_ARCHIVE.url).toMatch(
      /^https:\/\/github\.com\/supermomonga\/paseo-plugin-zcode-provider\/releases\/download\/zcode-runtime-v/u,
    );
    expect(MANAGED_ZCODE_ARCHIVE.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(MANAGED_ZCODE_ARCHIVE.size).toBeGreaterThan(0);
  });

  it("maps only the five managed platforms", () => {
    expect(managedPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(managedPlatform("win32", "x64")).toBe("win-x64");
    expect(managedPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(managedPlatform("darwin", "x64")).toBeUndefined();
    expect(managedPlatform("freebsd", "x64")).toBeUndefined();
  });
});

describe("managed runtime location", () => {
  const suffix = join("paseo-plugin-zcode-provider", "runtimes");

  it("uses %LOCALAPPDATA% on Windows and ~/.local/share elsewhere", () => {
    const local = join(tmpdir(), "AppData", "Local");
    expect(managedRuntimeRoot({ LOCALAPPDATA: local }, "win32")).toBe(
      join(local, suffix),
    );
    expect(managedRuntimeRoot({}, "win32")).toBe(
      join(homedir(), "AppData", "Local", suffix),
    );
    for (const platform of ["darwin", "linux"] as const)
      expect(managedRuntimeRoot({ LOCALAPPDATA: local }, platform)).toBe(
        join(homedir(), ".local", "share", suffix),
      );
  });

  it("honors only an absolute XDG_DATA_HOME, on every OS", () => {
    const data = join(tmpdir(), "xdg-data");
    for (const platform of ["win32", "darwin", "linux"] as const)
      expect(managedRuntimeRoot({ XDG_DATA_HOME: data }, platform)).toBe(
        join(data, suffix),
      );
    expect(managedRuntimeRoot({ XDG_DATA_HOME: "relative" }, "linux")).toBe(
      join(homedir(), ".local", "share", suffix),
    );
    expect(managedRuntimeRoot({ XDG_DATA_HOME: "" }, "darwin")).toBe(
      join(homedir(), ".local", "share", suffix),
    );
  });
});

describe("ManagedRuntimeInstaller", () => {
  it("installs verified archives atomically and skips them afterwards", async () => {
    const f = await fixture();
    expect(await finish(f.installer)).toEqual({ state: "succeeded" });
    expect(await isInstalled(f.layout.node)).toBe(true);
    expect(await isInstalled(f.layout.zcode)).toBe(true);
    expect(
      (await stat(join(f.layout.zcode.directory, "agent/zcode.cjs"))).isFile(),
    ).toBe(true);
    expect(f.nodeVersion).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]bin[\\/]node$/u),
    );
    expect(await readdir(f.layout.root)).not.toContain(".lock");
    expect(f.fetch).toHaveBeenCalledTimes(2);

    expect(await finish(f.installer)).toEqual({ state: "succeeded" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an archive whose SHA-256 differs and leaves no install", async () => {
    const f = await fixture();
    f.bodies.set(
      f.layout.zcode.archive.url,
      Buffer.alloc(f.layout.zcode.archive.size),
    );
    expect(await finish(f.installer)).toMatchObject({
      state: "failed",
      code: "RUNTIME_SETUP_FAILED",
      message: expect.stringContaining("SHA-256"),
    });
    expect(await isInstalled(f.layout.zcode)).toBe(false);
    expect(await readdir(join(f.layout.root, ".staging"))).toEqual([]);
  });

  it("stops downloads larger than the pinned size", async () => {
    const f = await fixture();
    f.bodies.set(
      f.layout.node.archive.url,
      Buffer.alloc(f.layout.node.archive.size + 1),
    );
    expect(await finish(f.installer)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("larger than the pinned size"),
    });
  });

  it("reports HTTP failures without installing anything", async () => {
    const f = await fixture();
    f.bodies.delete(f.layout.node.archive.url);
    expect(await finish(f.installer)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("HTTP 404"),
    });
    expect(await resolveManagedRuntime({ XDG_DATA_HOME: f.data })).toBe(
      undefined,
    );
  });

  it("rejects a Node.js archive that reports another version", async () => {
    const f = await fixture();
    f.nodeVersion.mockResolvedValue("v22.0.0");
    expect(await finish(f.installer)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("version check"),
    });
    expect(await isInstalled(f.layout.node)).toBe(false);
  });

  it("runs one job at a time and refuses removal meanwhile", async () => {
    const f = await fixture();
    expect(f.installer.start()).toBe(true);
    expect(f.installer.start()).toBe(false);
    expect(f.installer.state()).toMatchObject({ state: "running" });
    await expect(f.installer.remove()).rejects.toMatchObject({
      code: "RUNTIME_SETUP_FAILED",
    });
    await f.installer.settled();
  });

  it("reclaims a lock left by a dead process but not by a live one", async () => {
    const f = await fixture();
    const lock = join(f.layout.root, ".lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), String(process.pid));
    expect(await finish(f.installer)).toMatchObject({
      state: "failed",
      message: "Another ZCode runtime setup is running",
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(await finish(f.installer)).toEqual({ state: "succeeded" });
  });

  it("reports each setup step and the removal to subscribers", async () => {
    const f = await fixture();
    const states: string[] = [];
    f.installer.subscribe((state) =>
      states.push(
        state.state === "running"
          ? `${state.component}:${state.phase}`
          : state.state,
      ),
    );
    await finish(f.installer);
    await f.installer.remove();
    expect([...new Set(states)]).toEqual([
      "node:download",
      "node:extract",
      "node:verify",
      "zcode:download",
      "zcode:extract",
      "zcode:verify",
      "succeeded",
      "idle",
    ]);
  });

  it("reads the installed versions, earlier ones until the pinned pair is set up", async () => {
    const f = await fixture();
    expect(await installedVersions(f.layout)).toEqual({ pinned: false });
    for (const [entry, version] of [
      ["node-v24.14.0-linux-x64", "24.14.0"],
      ["zcode-3.17.2-111111111111", "3.17.2"],
      ["zcode-3.18.1-222222222222", "3.18.1"],
      // An interrupted install has no marker.
      ["zcode-9.9.9-333333333333", undefined],
    ] as const) {
      await mkdir(join(f.layout.root, entry), { recursive: true });
      if (version)
        await writeFile(
          join(f.layout.root, entry, ".paseo-managed.json"),
          JSON.stringify({ version, archiveSha256: "0".repeat(64) }),
        );
    }
    expect(await installedVersions(f.layout)).toEqual({
      node: { version: "24.14.0", pinned: false },
      zcode: { version: "3.18.1", pinned: false },
      pinned: false,
    });
    await finish(f.installer);
    expect(await installedVersions(f.layout)).toEqual({
      node: { version: f.layout.node.version, pinned: true },
      zcode: { version: f.layout.zcode.version, pinned: true },
      pinned: true,
    });
  });

  it("removes stale versions after setup and everything on removal", async () => {
    const f = await fixture();
    const stale = join(f.layout.root, "zcode-0.0.1-000000000000");
    await mkdir(stale, { recursive: true });
    expect(await finish(f.installer)).toEqual({ state: "succeeded" });
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await f.installer.remove();
    await expect(stat(f.layout.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.installer.state()).toEqual({ state: "idle" });
  });

  it("fails clearly on platforms without managed archives", async () => {
    const installer = new ManagedRuntimeInstaller(
      { XDG_DATA_HOME: await temporary("zcode-unsupported-") },
      null,
    );
    expect(await finish(installer)).toMatchObject({
      state: "failed",
      code: "UNSUPPORTED_PLATFORM",
    });
  });
});
