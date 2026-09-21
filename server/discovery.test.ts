import { expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRuntime, runtimeEnvironment } from "./discovery/discover.js";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it.each([
  {},
  { PASEO_ZCODE_RUNTIME: "relative", PASEO_ZCODE_NODE: "/node" },
  { PASEO_ZCODE_RUNTIME: "/runtime", PASEO_ZCODE_NODE: "relative" },
])("requires both explicit absolute paths", async (environment) => {
  await expect(discoverRuntime({ environment })).rejects.toMatchObject({
    code: "RUNTIME_DISCOVERY_FAILED",
  });
});
it("rejects missing files without discovering Desktop", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-discovery-"));
  dirs.push(root);
  await expect(
    discoverRuntime({
      environment: {
        PASEO_ZCODE_RUNTIME: root,
        PASEO_ZCODE_NODE: process.execPath,
      },
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_DISCOVERY_FAILED" });
});
it("removes inherited Electron execution mode", () => {
  expect(
    runtimeEnvironment({ ELECTRON_RUN_AS_NODE: "1", TEST_VALUE: "yes" }),
  ).toEqual({ TEST_VALUE: "yes" });
});

async function executableFixture(identity: {
  node: string;
  electron?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-layout-"));
  dirs.push(root);
  for (const part of ["agent/provider", "server/remote"])
    await mkdir(join(root, part), { recursive: true });
  await writeFile(join(root, "agent/zcode.cjs"), "agent");
  await writeFile(join(root, "server/remote/zcode-server.cjs"), "server");
  await writeFile(join(root, "agent/provider/zcode-builtin.json"), "{}");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "zcode-runtime", version: "3.14.0" }),
  );
  const executable = join(root, "node-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}\nif(process.argv[2]==="-e")console.log(${JSON.stringify(JSON.stringify({ ...identity, platform: process.platform, arch: process.arch }))});else console.log(process.argv[2].includes("server/remote")?"3.14.0":"0.16.9");\n`,
    { mode: 0o755 },
  );
  return {
    root,
    environment: { PASEO_ZCODE_RUNTIME: root, PASEO_ZCODE_NODE: executable },
  };
}
it.each([{ node: "22.23.0" }, { node: "24.14.0", electron: "40.0.0" }])(
  "rejects a wrong Node runtime before Server startup: %j",
  async (identity) => {
    const f = await executableFixture(identity);
    await expect(
      discoverRuntime({ environment: f.environment }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ZCODE" });
  },
);
it("validates the integrated layout and hashes its Server and Agent independently", async () => {
  const f = await executableFixture({ node: "24.14.0" });
  const found = await discoverRuntime({ environment: f.environment });
  expect(found.identity.nodeVersion).toBe("24.14.0");
  expect(found.identity.serverSha256).not.toBe(found.identity.cliSha256);
  expect(found.paths.executable).toBe(
    await realpath(f.environment.PASEO_ZCODE_NODE),
  );
});
