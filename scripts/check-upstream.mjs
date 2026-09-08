import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import * as sdk from "@getpaseo/plugin/server/provider";

const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: npm run test:upstream -- /absolute/path/to/upstream-checkout",
  );
const upstream = resolve(source);
const root = resolve(import.meta.dirname, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "zcode-upstream-")),
);
try {
  const upstreamPackage = JSON.parse(
    await readFile(join(upstream, "packages/plugin/package.json"), "utf8"),
  );
  const installedPackage = JSON.parse(
    await readFile(
      join(root, "node_modules/@getpaseo/plugin/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    upstreamPackage.version,
    installedPackage.version,
    "Use the upstream release matching the installed SDK",
  );
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  const options = {
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [join(root, "node_modules")],
  };
  const sources = {
    compiler: join(upstream, "packages/server/src/server/plugins/compiler.ts"),
    adapter: join(
      upstream,
      "packages/server/src/server/agent/plugin-provider.ts",
    ),
    provider: join(root, "server/provider.ts"),
    fake: join(root, "test/fake-host.ts"),
  };
  for (const [name, entry] of Object.entries(sources))
    await build({
      ...options,
      entryPoints: [entry],
      outfile: join(directory, `${name}.mjs`),
      external: ["esbuild", "@getpaseo/plugin/server/provider"],
    });
  const load = (name) =>
    import(pathToFileURL(join(directory, `${name}.mjs`)).href);
  const { compilePlugin } = await load("compiler");
  const { serverBundle, clientBundle } = await compilePlugin({
    server: join(root, "index.server.ts"),
    client: null,
  });
  assert.equal(clientBundle, null);
  assert.ok(
    serverBundle.includes('require("@getpaseo/plugin/server/provider")'),
  );
  const nodeRequire = createRequire(join(root, "package.json"));
  const contribution = runInThisContext(serverBundle)((name) =>
    name === "@getpaseo/plugin/server/provider" ? sdk : nodeRequire(name),
  );
  let registered;
  const dispose = contribution.default({
    registerProvider(provider) {
      registered = provider;
    },
  });
  assert.equal(registered.id, "zcode");
  assert.equal(typeof dispose, "function");
  await dispose();

  const { PluginAgentClientRegistry } = await load("adapter");
  const { createZCodeProvider } = await load("provider");
  const { FakeBridge, snapshot, completeTurn } = await load("fake");
  const hosts = [];
  const registry = new PluginAgentClientRegistry({ warn() {} });
  registry.replace([
    createZCodeProvider(async () => {
      const initial = snapshot(directory);
      initial.runtime.contextUsage = { used: 20, size: 100 };
      const host = new FakeBridge(initial);
      hosts.push(host);
      return host;
    }),
  ]);
  try {
    const client = registry.clients().zcode;
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: directory,
    });
    assert.equal(catalog.models[0].provider, "zcode");
    const session = await client.createSession({
      provider: "zcode",
      cwd: directory,
      modeId: "edit",
    });
    const events = [];
    session.subscribe((event) => events.push(event));
    const initialUsageReplayed = events.some(
      (event) => event.type === "usage_updated",
    );
    const host = hosts.at(-1);
    host.current.runtime.contextUsage = { used: 30, size: 100 };
    await host.emit({
      type: "snapshot",
      snapshot: structuredClone(host.current),
    });
    assert.equal(
      events.findLast((event) => event.type === "usage_updated").usage
        .contextWindowUsedTokens,
      30,
    );
    const turn = await session.startTurn("Hello", {
      clientMessageId: "public-message",
    });
    for (const [index, delta] of ["hel", "lo"].entries())
      await host.emit({
        type: "session.event",
        event: {
          type: "model.streaming",
          eventId: `stream-${index}`,
          sessionId: "session-1",
          seq: index + 1,
          timestamp: 1,
          deliveryKind: "desktop-continuous",
          payload: {
            kind: "text_delta",
            delta,
            assistantMessageId: "assistant-1",
          },
        },
      });
    await completeTurn(host, 3);
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed.turnId, turn.turnId);
    assert.equal(
      events
        .filter(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message",
        )
        .map((event) => event.item.text)
        .join(""),
      "hello",
    );
    assert.equal(
      session
        .timelineHistory()
        .filter(({ item }) => item.type === "assistant_message")
        .map(({ item }) => item.text)
        .join(""),
      "hello",
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "timeline" && event.item.type === "user_message",
      ).length,
      1,
    );
    assert.ok(session.describePersistence());
    await session.close();
    assert.equal(host.closed, true);
    console.log(JSON.stringify({ initialUsageReplayed, liveUsage: "passed" }));
  } finally {
    await registry.shutdown();
  }
  console.log(
    JSON.stringify(
      {
        commit: execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        compiledBytes: Buffer.byteLength(serverBundle),
        registration: "passed",
        coreAdapter: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
