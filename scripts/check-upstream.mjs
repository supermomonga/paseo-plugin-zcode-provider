import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
    manifest: join(upstream, "packages/server/src/server/plugins/manifest.ts"),
    preparation: join(
      upstream,
      "packages/server/src/server/plugins/preparation.ts",
    ),
    adapter: join(
      upstream,
      "packages/server/src/server/agent/plugin-provider.ts",
    ),
    provider: join(root, "server/provider.ts"),
    persistence: join(root, "server/persistence.ts"),
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
  const { readPluginManifest } = await load("manifest");
  const { runPluginBuild } = await load("preparation");
  const gitPreparation = [];
  for (const nodeEnv of [undefined, "production"]) {
    gitPreparation.push(
      await checkGitPreparation({
        compilePlugin,
        readPluginManifest,
        runPluginBuild,
        nodeEnv,
      }),
    );
  }

  const { PluginAgentClientRegistry } = await load("adapter");
  const { createZCodeProvider } = await load("provider");
  const { SessionPersistenceStore } = await load("persistence");
  const { FakeBridge, snapshot, completeTurn } = await load("fake");
  const hosts = [],
    warnings = [];
  let savedState;
  const registry = new PluginAgentClientRegistry({
    warn(...args) {
      warnings.push(args);
    },
  });
  const registration = () =>
    createZCodeProvider(
      async () => {
        const host = new FakeBridge(snapshot(directory));
        if (savedState) {
          host.state = structuredClone(savedState);
          host.rowSequence = Math.max(
            0,
            ...host.state.rows.window.map((r) => r.rowId),
          );
        }
        hosts.push(host);
        return host;
      },
      new SessionPersistenceStore(join(directory, "provider-state")),
    );
  registry.replace([registration()]);
  try {
    const client = registry.clients().zcode;
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: directory,
    });
    assert.equal(catalog.models.length, 1);
    const session = await client.createSession({
      provider: "zcode",
      cwd: directory,
      modeId: "edit",
    });
    const host = hosts.at(-1),
      events = [];
    session.subscribe((e) => events.push(e));
    const turn = await session.startTurn("Hello", {
      clientMessageId: "public-message",
    });
    const row = {
      ...host.rowBase(),
      kind: "assistantText",
      text: "hel",
      state: "streaming",
    };
    await host.append(row);
    await host.deltas([
      { op: "row.upserted", row: { ...row, text: "hello", state: "complete" } },
    ]);
    const done = waitForCompletion(session, turn.turnId);
    await host.finish();
    await done;
    assert.equal(
      session
        .timelineHistory()
        .filter((e) => e.item.type === "assistant_message")
        .map((e) => e.item.text)
        .join(""),
      "hello",
    );
    assert.equal(events.filter((e) => e.type === "turn_completed").length, 1);
    await session.setFeature("plan_mode", true);
    assert.equal(host.state.config.planEnabled, true);
    const persistence = session.describePersistence();
    savedState = structuredClone(host.state);
    registry.replace([registration()]);
    await assert.rejects(
      session.startTurn("Stale", { clientMessageId: "stale" }),
      { name: "StaleProviderSessionError" },
    );
    const resumed = await registry
      .clients()
      .zcode.resumeSession(persistence, { cwd: directory, modeId: "edit" });
    const current = hosts.at(-1);
    assert.equal(current.state.config.planEnabled, true);
    assert.ok(
      resumed
        .timelineHistory()
        .some(
          (e) => e.item.type === "assistant_message" && e.item.text === "hello",
        ),
    );
    await resumed.setFeature("plan_mode", false);
    const run = await resumed.startTurn("Continue", {
      clientMessageId: "next",
    });
    assert.deepEqual(
      await resumed.steerActiveTurn("Guide", {
        expectedTurnId: run.turnId,
        clientMessageId: "guide",
      }),
      { status: "accepted" },
    );
    current.deferConsumption = true;
    assert.deepEqual(
      await resumed.steerActiveTurn(
        [
          { type: "text", text: "Image" },
          { type: "image", mimeType: "image/png", data: "dGVzdA==" },
        ],
        { expectedTurnId: run.turnId, clientMessageId: "image" },
      ),
      { status: "accepted" },
    );
    await current.finish();
    const queued = current.state.queue.items[0];
    assert.ok(queued);
    await current.deltas([
      {
        op: "state.updated",
        patch: { queue: { ...current.state.queue, items: [] } },
      },
    ]);
    await current.consume(queued.sourceCommandId, "Image");
    const queuedDone = waitForCompletion(resumed, run.turnId);
    await completeTurn(current);
    await queuedDone;
    current.deferConsumption = false;
    const stopRun = await resumed.startTurn("Stop", {
      clientMessageId: "stop",
    });
    await resumed.interrupt();
    assert.ok(
      current.calls.some(
        (c) =>
          c.params?.envelope?.type === "stop" &&
          c.params.envelope.payload.expectedForegroundExecutionId,
      ),
    );
    await resumed.close();
    assert.equal(current.closed, true);
    console.log(
      JSON.stringify(
        {
          commit: execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          gitPreparation,
          coreAdapter: "passed",
          V4Timeline: "passed",
          textSteering: "passed",
          attachmentQueue: "passed",
          singleCompletion: "passed",
          providerReplacement: "passed",
          persistenceResume: "passed",
          planSettingsResume: "passed",
          targetedStop: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    await registry.shutdown();
  }
  assert.deepEqual(warnings, []);
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function checkGitPreparation({
  compilePlugin,
  readPluginManifest,
  runPluginBuild,
  nodeEnv,
}) {
  console.log(`Checking Git preparation (NODE_ENV=${nodeEnv ?? "unset"})`);
  // Keep the candidate outside the harness directory and its node_modules symlink.
  const candidate = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-git-preparation-")),
  );
  try {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean);
    // Copy working-tree contents so local, uncommitted fixes are tested too.
    for (const file of files) {
      const destination = join(candidate, file);
      await mkdir(dirname(destination), { recursive: true });
      try {
        await copyFile(join(root, file), destination);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const nodeRequire = createRequire(join(candidate, "package.json"));
    await assert.rejects(access(join(candidate, "node_modules")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(candidate, "server/build-info.ts")), {
      code: "ENOENT",
    });
    assert.throws(() => nodeRequire.resolve("zod"), {
      code: "MODULE_NOT_FOUND",
    });

    const manifest = await readPluginManifest(candidate);
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      await runPluginBuild(candidate, manifest.build, {
        info(fields, message) {
          console.log(message, fields.output ?? fields.command);
        },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    await access(join(candidate, "server/build-info.ts"));
    assert.ok(
      relative(candidate, nodeRequire.resolve("zod")).startsWith(
        `node_modules${sep}`,
      ),
      "Resolve the schema validator from the prepared candidate's own dependencies",
    );
    const { serverBundle, clientBundle } = await compilePlugin({
      server: join(candidate, "index.server.ts"),
      client: join(candidate, "index.client.tsx"),
    });
    assert.ok(clientBundle, "The client entry must compile");
    assert.ok(
      serverBundle.includes('require("@getpaseo/plugin/server/provider")'),
    );
    const contribution = runInThisContext(serverBundle)((name) =>
      name === "@getpaseo/plugin/server/provider" ? sdk : nodeRequire(name),
    );
    let registered;
    const dispose = contribution.default({
      registerProvider(provider) {
        registered = provider;
      },
      handle() {},
    });
    assert.equal(registered.id, "zcode");
    assert.equal(typeof dispose, "function");
    await dispose();

    const clientContribution = runInThisContext(clientBundle)((name) => {
      if (name === "react")
        return {
          useCallback: (callback) => callback,
          useEffect() {},
          useState: () => [null, () => {}],
        };
      if (name === "react/jsx-runtime")
        return { jsx: () => null, jsxs: () => null };
      if (name === "react-native")
        return { Text: () => null, View: () => null };
      if (name === "@getpaseo/plugin/client")
        return { useRpc: () => async () => ({}) };
      if (name === "@getpaseo/plugin/client/ui")
        return {
          SettingsAction: () => null,
          SettingsCard: () => null,
          SettingsRow: () => null,
          SettingsSection: () => null,
        };
      return nodeRequire(name);
    });
    let screen;
    const disposeClient = clientContribution.default({
      addSettingsScreen(screen_) {
        screen = screen_;
      },
    });
    assert.equal(screen.id, "diagnostics");
    assert.equal(typeof screen.Component, "function");
    assert.equal(typeof disposeClient, "function");
    await disposeClient();
    return {
      nodeEnv: nodeEnv ?? "unset",
      compiledBytes: Buffer.byteLength(serverBundle),
      clientCompiledBytes: Buffer.byteLength(clientBundle),
      registration: "passed",
      clientRegistration: "passed",
    };
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

function waitForCompletion(session, turnId) {
  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_completed" && event.turnId === turnId) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Adapter did not complete the public turn"));
    }, 5000);
  });
}
