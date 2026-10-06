import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeSetupHandlers } from "./runtime-setup.js";
import { ManagedRuntimeInstaller, managedLayout } from "./runtime/managed.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function dataHome() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-setup-status-"));
  directories.push(directory);
  return directory;
}

describe("runtime setup status", () => {
  it("lists pinned downloads before setup", async () => {
    const environment = { XDG_DATA_HOME: await dataHome() };
    const handlers = createRuntimeSetupHandlers(
      new ManagedRuntimeInstaller(environment, "linux-x64"),
      environment,
    );
    const status = await handlers.status();
    expect(status).toMatchObject({
      supported: true,
      override: false,
      job: { state: "idle" },
    });
    expect(status.components.map((component) => component.id)).toEqual([
      "node",
      "zcode",
    ]);
    expect(status.components.every((component) => !component.installed)).toBe(
      true,
    );
  });

  it("reports installed components and the environment override", async () => {
    const environment = { XDG_DATA_HOME: await dataHome() };
    const layout = managedLayout(environment, "linux-x64")!;
    for (const component of [layout.node, layout.zcode]) {
      await mkdir(component.directory, { recursive: true });
      await writeFile(
        join(component.directory, ".paseo-managed.json"),
        JSON.stringify({
          version: component.version,
          archiveSha256: component.archive.sha256,
        }),
      );
    }
    const status = await createRuntimeSetupHandlers(
      new ManagedRuntimeInstaller(environment, "linux-x64"),
      { ...environment, PASEO_ZCODE_NODE: "/custom/node" },
    ).status();
    expect(status.override).toBe(true);
    expect(status.components.every((component) => component.installed)).toBe(
      true,
    );
  });

  it("reports unsupported platforms without components", async () => {
    const environment = { XDG_DATA_HOME: await dataHome() };
    const status = await createRuntimeSetupHandlers(
      new ManagedRuntimeInstaller(environment, null),
      environment,
    ).status();
    expect(status).toMatchObject({ supported: false, components: [] });
  });

  it("returns a removal failure instead of throwing", async () => {
    const environment = { XDG_DATA_HOME: await dataHome() };
    // The job must stay offline; it only needs to be running during removal.
    const installer = new ManagedRuntimeInstaller(environment, "linux-x64", {
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const handlers = createRuntimeSetupHandlers(installer, environment);
    expect(await handlers.remove()).toEqual({ status: "removed" });
    installer.start();
    expect(await handlers.remove()).toMatchObject({ status: "failed" });
    await installer.settled();
  });
});
