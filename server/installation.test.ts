import {
  ProviderInspectionSchema,
  ProviderUpdateCheckSchema,
  ProviderUpdateResultSchema,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managedFixture,
  removeTemporaryDirectories,
  temporary,
} from "../test/managed-runtime-fixture.js";
import type { DiscoveredRuntime } from "./discovery/types.js";
import { AdapterError } from "./errors.js";
import { createInstallation } from "./installation.js";
import { ManagedRuntimeInstaller } from "./runtime/managed.js";
import {
  MANAGED_NODE_VERSION,
  MANAGED_ZCODE_RELEASE,
  MANAGED_ZCODE_VERSION,
} from "./runtime/pins.js";

type Installation = NonNullable<ProviderRegistration["installation"]>;

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTemporaryDirectories();
});

const PINNED = `${MANAGED_ZCODE_RELEASE} (Node.js ${MANAGED_NODE_VERSION})`;
const signal = () => new AbortController().signal;

async function inspect(installation: Installation) {
  return ProviderInspectionSchema.parse(
    await installation.inspect!({ signal: signal() }),
  );
}

async function check(installation: Installation, installedVersion?: string) {
  return ProviderUpdateCheckSchema.parse(
    await installation.checkForUpdates!({
      signal: signal(),
      ...(installedVersion === undefined ? {} : { installedVersion }),
    }),
  );
}

async function update(installation: Installation, abort = signal()) {
  const output: string[] = [];
  const result = ProviderUpdateResultSchema.parse(
    await installation.update!({
      signal: abort,
      report: (event) => output.push(event.text),
    }),
  );
  return { result, output: output.join("") };
}

async function earlierInstall(root: string) {
  for (const [entry, version] of [
    ["node-v24.14.0-linux-x64", "24.14.0"],
    ["zcode-3.17.2-111111111111", "3.17.2"],
  ] as const) {
    await mkdir(join(root, entry), { recursive: true });
    await writeFile(
      join(root, entry, ".paseo-managed.json"),
      JSON.stringify({ version, archiveSha256: "0".repeat(64) }),
    );
  }
}

describe("managed runtime installation", () => {
  it("links the setup instructions and is not installed before setup", async () => {
    const f = await managedFixture();
    const installation = createInstallation(f.installer, { environment: {} });
    expect(installation.installUrl).toBe(
      "https://github.com/supermomonga/paseo-plugin-zcode-provider#setup",
    );
    expect(await inspect(installation)).toEqual({ status: "not_installed" });
  });

  it("reports the pinned runtime as current and leaves it alone on Update", async () => {
    const f = await managedFixture();
    const installation = createInstallation(f.installer, { environment: {} });
    f.installer.start();
    await f.installer.settled();
    f.fetch.mockClear();
    expect(await inspect(installation)).toEqual({
      status: "installed",
      version: PINNED,
    });
    expect(await check(installation, PINNED)).toEqual({ status: "current" });
    expect(await update(installation)).toEqual({
      result: {
        status: "succeeded",
        message: `ZCode runtime ${PINNED} is already installed.`,
      },
      output: "",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("offers the pinned runtime over an earlier install and installs it", async () => {
    const f = await managedFixture();
    await earlierInstall(f.layout.root);
    const installation = createInstallation(f.installer, { environment: {} });
    // An earlier install records its ZCode version, not its release.
    const earlier = "3.17.2 (Node.js 24.14.0)";
    expect(await inspect(installation)).toEqual({
      status: "installed",
      version: earlier,
    });
    expect(await check(installation, earlier)).toEqual({
      status: "available",
      versions: [PINNED],
      message: "This plugin version runs this ZCode runtime.",
    });
    expect(await update(installation)).toEqual({
      result: {
        status: "succeeded",
        message: `Installed ZCode runtime ${PINNED}.`,
      },
      output: [
        `Downloading Node.js ${MANAGED_NODE_VERSION}`,
        `Extracting Node.js ${MANAGED_NODE_VERSION}`,
        `Verifying Node.js ${MANAGED_NODE_VERSION}`,
        `Downloading ZCode runtime ${MANAGED_ZCODE_RELEASE}`,
        `Extracting ZCode runtime ${MANAGED_ZCODE_RELEASE}`,
        `Verifying ZCode runtime ${MANAGED_ZCODE_RELEASE}`,
        "",
      ].join("\n"),
    });
    expect(await inspect(installation)).toEqual({
      status: "installed",
      version: PINNED,
    });
    expect(await check(installation, PINNED)).toEqual({ status: "current" });
  });

  it("tells a rebuild of the same ZCode version from the pinned release", async () => {
    const f = await managedFixture();
    const earlier = join(
      f.layout.root,
      `zcode-${MANAGED_ZCODE_VERSION}-000000000000`,
    );
    await mkdir(earlier, { recursive: true });
    await writeFile(
      join(earlier, ".paseo-managed.json"),
      JSON.stringify({
        version: MANAGED_ZCODE_VERSION,
        archiveSha256: "0".repeat(64),
      }),
    );
    const installation = createInstallation(f.installer, { environment: {} });
    expect(await inspect(installation)).toEqual({
      status: "installed",
      version: `${MANAGED_ZCODE_VERSION} (Node.js not installed)`,
    });
    expect(await check(installation)).toMatchObject({
      status: "available",
      versions: [PINNED],
    });
  });

  it("joins a setup that the Runtime tab started", async () => {
    const f = await managedFixture();
    const installation = createInstallation(f.installer, { environment: {} });
    expect(f.installer.start()).toBe(true);
    const { result } = await update(installation);
    expect(result).toEqual({
      status: "succeeded",
      message: `Installed ZCode runtime ${PINNED}.`,
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failed setup with its message", async () => {
    const f = await managedFixture();
    f.bodies.set(f.layout.zcode.archive.url, Buffer.from("tampered"));
    const installation = createInstallation(f.installer, { environment: {} });
    const { result } = await update(installation);
    expect(result).toEqual({
      status: "failed",
      message: `ZCode runtime ${MANAGED_ZCODE_VERSION} does not match its pinned SHA-256`,
    });
  });

  it("stops waiting when Paseo aborts the update", async () => {
    const f = await managedFixture();
    const installation = createInstallation(f.installer, { environment: {} });
    const controller = new AbortController();
    controller.abort(new Error("The daemon is stopping"));
    await expect(update(installation, controller.signal)).rejects.toThrow(
      "The daemon is stopping",
    );
    await f.installer.settled();
  });

  it("has nothing to install on a platform without managed archives", async () => {
    const installer = new ManagedRuntimeInstaller(
      { XDG_DATA_HOME: await temporary("zcode-unsupported-") },
      null,
    );
    const installation = createInstallation(installer, { environment: {} });
    expect(await inspect(installation)).toEqual({ status: "not_installed" });
    expect((await update(installation)).result).toEqual({
      status: "failed",
      message: "Managed ZCode setup is not available on this platform",
    });
  });
});

describe("runtime override installation", () => {
  const environment = {
    PASEO_ZCODE_RUNTIME: "/opt/zcode",
    PASEO_ZCODE_NODE: "/opt/node/bin/node",
  };

  it("reports the override's versions and never updates it", async () => {
    const f = await managedFixture();
    const discover = vi.fn(
      async () =>
        ({
          source: "environment",
          identity: { appVersion: "3.18.2", cliVersion: "0.24.1" },
        }) as DiscoveredRuntime,
    );
    const installation = createInstallation(f.installer, {
      environment,
      discover,
    });
    expect(await inspect(installation)).toEqual({
      status: "installed",
      version: "Server 3.18.2, Agent 0.24.1 (PASEO_ZCODE_RUNTIME)",
    });
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ environment }),
    );
    const message =
      "PASEO_ZCODE_RUNTIME and PASEO_ZCODE_NODE select this runtime. The plugin updates only the runtime it installs.";
    expect(await check(installation)).toEqual({ status: "unknown", message });
    expect((await update(installation)).result).toEqual({
      status: "failed",
      message,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("shows discovery errors without native details", async () => {
    const f = await managedFixture();
    const installation = createInstallation(f.installer, {
      environment,
      discover: async () => {
        throw new AdapterError(
          "RUNTIME_DISCOVERY_FAILED",
          "PASEO_ZCODE_NODE must be an absolute path; set both variables or neither",
        );
      },
    });
    await expect(inspect(installation)).rejects.toThrow(
      "PASEO_ZCODE_NODE must be an absolute path; set both variables or neither",
    );
    const hidden = createInstallation(f.installer, {
      environment,
      discover: async () => {
        throw new Error("EACCES /Users/me/secret");
      },
    });
    await expect(inspect(hidden)).rejects.toThrow(
      "ZCode runtime could not be inspected",
    );
  });
});
