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
  writeFile,
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
    // Bundled CommonJS dependencies (such as `which`) require Node builtins.
    banner: {
      js: 'import { createRequire as createBannerRequire } from "node:module"; const require = createBannerRequire(import.meta.url);',
    },
  };
  // Paseo runs these in a compiler worker; load the work itself, as the worker does.
  const sources = {
    compiler: join(
      upstream,
      "packages/server/src/server/plugins/compiler-build.ts",
    ),
    manifest: join(upstream, "packages/server/src/server/plugins/manifest.ts"),
    preparation: join(
      upstream,
      "packages/server/src/server/plugins/preparation-build.ts",
    ),
    icon: join(upstream, "packages/server/src/server/plugins/provider-icon.ts"),
    adapter: join(
      upstream,
      "packages/server/src/server/agent/plugin-provider.ts",
    ),
    provider: join(root, "server/provider.ts"),
    persistence: join(root, "server/persistence.ts"),
    goal: join(root, "server/goal.ts"),
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
  const { compileDirectoryPlugin } = await load("compiler");
  const { readPluginManifest } = await load("manifest");
  const { runPluginBuild } = await load("preparation");
  const { readPluginProviderIcon } = await load("icon");
  const plugin = {
    compileDirectoryPlugin,
    daemonVersion: upstreamPackage.version,
    readPluginManifest,
    readPluginProviderIcon,
    runPluginBuild,
  };
  const gitPreparation = [];
  for (const nodeEnv of [undefined, "production"]) {
    gitPreparation.push(await checkGitPreparation({ ...plugin, nodeEnv }));
  }
  const npmInstallation = await checkNpmInstallation(plugin);

  const { PluginAgentClientRegistry } = await load("adapter");
  const { createZCodeProvider } = await load("provider");
  const { SessionPersistenceStore } = await load("persistence");
  const { GoalDirectory } = await load("goal");
  const { FakeBridge, snapshot, completeTurn } = await load("fake");
  const goals = new GoalDirectory();
  const hosts = [],
    warnings = [];
  let savedState;
  const registry = new PluginAgentClientRegistry({
    warn(...args) {
      warnings.push(args);
    },
  });
  const available = {
    available: true,
    diagnostic: "ZCode\n  Runtime: test",
  };
  const registration = (status = async () => available) =>
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
      status,
      undefined,
      goals,
    );
  registry.replace([registration()]);
  try {
    const client = registry.clients().zcode;
    // Paseo asks the registration's status() instead of connecting.
    assert.equal(await client.isAvailable(), true);
    assert.deepEqual(await client.getDiagnostic(), {
      diagnostic: available.diagnostic,
    });
    const unavailableRegistry = new PluginAgentClientRegistry({
      warn(...args) {
        warnings.push(args);
      },
    });
    unavailableRegistry.replace([
      registration(async () => ({
        available: false,
        diagnostic: "ZCode\n  Error: ZCode runtime is not set up.",
      })),
    ]);
    try {
      assert.equal(
        await unavailableRegistry.clients().zcode.isAvailable(),
        false,
      );
    } finally {
      await unavailableRegistry.shutdown();
    }
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
    // Paseo asks before releasing an idle runtime; ZCode background work keeps it.
    assert.equal(typeof session.canStopRuntime, "function");
    assert.equal(await session.canStopRuntime(), true);
    const backgroundWork = {
      workId: "work-1",
      kind: "bash",
      title: "npm run dev",
      status: "running",
      startedAt: 1,
      anchorRowId: null,
    };
    await host.deltas([
      { op: "state.updated", patch: { backgroundWorks: [backgroundWork] } },
    ]);
    assert.equal(await session.canStopRuntime(), false);
    await host.deltas([
      { op: "state.updated", patch: { backgroundWorks: [] } },
    ]);
    await session.setFeature("plan_mode", true);
    assert.equal(host.state.config.planEnabled, true);
    const persistence = session.describePersistence();
    savedState = structuredClone(host.state);
    registry.replace([registration()]);
    await assert.rejects(
      session.startTurn("Stale", { clientMessageId: "stale" }),
      { name: "StaleProviderSessionError" },
    );
    // Paseo names the agent in the launch environment of every session.
    const resumed = await registry
      .clients()
      .zcode.resumeSession(
        persistence,
        { cwd: directory, modeId: "edit" },
        { env: { PASEO_AGENT_ID: "agent-1" } },
      );
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
    // The Web UI always asks to clear pending permissions when steering.
    assert.deepEqual(
      await resumed.steerActiveTurn("Guide", {
        expectedTurnId: run.turnId,
        clientMessageId: "guide",
        clearPendingPermissions: true,
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
    // A classified model failure reaches Paseo's turn_failed without ZCode's text (ADR 23).
    const failRun = await resumed.startTurn("Fail", {
      clientMessageId: "fail",
    });
    const failedEvent = waitForCompletion(
      resumed,
      failRun.turnId,
      "turn_failed",
    );
    await current.finish("failed", {
      code: "1310",
      message: "native-provider-text",
      recoverable: true,
      at: 3,
      source: "provider",
      attribution: {
        source: "provider",
        reason: "rate_limited",
        statusCode: 429,
        providerErrorCode: "1310",
      },
    });
    const failed = await failedEvent;
    assert.equal(failed.code, "MODEL_RATE_LIMITED");
    assert.match(failed.error, /\(HTTP 429, provider code 1310\)/u);
    assert.equal(JSON.parse(failed.diagnostic).failure.reason, "rate_limited");
    assert.ok(!JSON.stringify(failed).includes("native-provider-text"));
    // /compact adds no user input row; the turn completes with its header and
    // stops although its works name no foreground execution (ADR 28).
    const compactRun = await resumed.startTurn("/compact", {
      clientMessageId: "compact",
    });
    const compactDone = waitForCompletion(resumed, compactRun.turnId);
    await current.finishCompact("success");
    await compactDone;
    const stoppedCompact = await resumed.startTurn("/compact", {
      clientMessageId: "compact-stop",
    });
    const compactCanceled = waitForCompletion(
      resumed,
      stoppedCompact.turnId,
      "turn_canceled",
    );
    await resumed.interrupt();
    await compactCanceled;
    assert.deepEqual(
      current.calls.findLast((c) => c.params?.envelope?.type === "stop").params
        .envelope.payload,
      {},
    );
    // Paseo sends a listed command as a command; /goal reaches the Server as
    // its goal command, and the launch environment names the agent (ADR 27).
    assert.deepEqual(goals.views(), []);
    const goalRun = await resumed.startTurn("/goal Ship it", {
      clientMessageId: "goal",
    });
    const sent = (type) =>
      current.calls
        .filter((c) => c.params?.envelope?.type === type)
        .map((c) => c.params.envelope.payload.text);
    assert.deepEqual(sent("sendGoalCommand"), ["Ship it"]);
    assert.ok(!sent("sendText").some((text) => text.startsWith("/goal")));
    assert.deepEqual(
      goals.views().map((goal) => [goal.agentId, goal.status]),
      [["agent-1", "active"]],
    );
    const goalDone = waitForCompletion(resumed, goalRun.turnId);
    await current.verifyGoal("pass");
    await goalDone;
    assert.equal(goals.views()[0].status, "verified");
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
          npmInstallation,
          coreAdapter: "passed",
          V4Timeline: "passed",
          textSteering: "passed",
          attachmentQueue: "passed",
          singleCompletion: "passed",
          idleRuntimeVeto: "passed",
          turnFailure: "passed",
          providerReplacement: "passed",
          persistenceResume: "passed",
          planSettingsResume: "passed",
          targetedStop: "passed",
          providerStatus: "passed",
          goalCommand: "passed",
          compaction: "passed",
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
  compileDirectoryPlugin,
  daemonVersion,
  readPluginManifest,
  readPluginProviderIcon,
  runPluginBuild,
  nodeEnv,
}) {
  console.log(`Checking Git preparation (NODE_ENV=${nodeEnv ?? "unset"})`);
  // Keep the candidate outside the harness directory and its node_modules symlink.
  const candidate = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-git-preparation-")),
  );
  try {
    await copyWorkingTree(candidate);
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
    const environment = { ...process.env };
    if (nodeEnv === undefined) delete environment.NODE_ENV;
    else environment.NODE_ENV = nodeEnv;
    await runPluginBuild(
      candidate,
      manifest.build,
      { info: logPreparation },
      environment,
    );

    await access(join(candidate, "server/build-info.ts"));
    assert.ok(
      relative(candidate, nodeRequire.resolve("zod")).startsWith(
        `node_modules${sep}`,
      ),
      "Resolve the schema validator from the prepared candidate's own dependencies",
    );
    return {
      nodeEnv: nodeEnv ?? "unset",
      ...(await checkContributions({
        compileDirectoryPlugin,
        daemonVersion,
        readPluginProviderIcon,
        candidate,
        requireModule: nodeRequire,
      })),
    };
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function checkNpmInstallation({
  compileDirectoryPlugin,
  daemonVersion,
  readPluginManifest,
  readPluginProviderIcon,
  runPluginBuild,
}) {
  console.log("Checking npm installation");
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-npm-installation-")),
  );
  try {
    // Pack a copy so the pack scripts never touch the working tree.
    const checkout = join(workspace, "checkout");
    await copyWorkingTree(checkout);
    const [{ name, filename, files }] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", workspace], {
        cwd: checkout,
        encoding: "utf8",
      }),
    );
    assert.ok(
      !files.some(({ path }) => path.endsWith(".test.ts")),
      "Keep tests out of the package",
    );
    const installation = join(workspace, "installation");
    await mkdir(installation);
    await writeFile(
      join(installation, "package.json"),
      JSON.stringify({
        name: "paseo-plugin-installation",
        version: "1.0.0",
        private: true,
        dependencies: { [name]: `file:${join(workspace, filename)}` },
      }),
    );
    // The options of Paseo's npm acquisition (managed-source/npm.ts).
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--package-lock=true",
        "--lockfile-version=3",
        "--include=prod",
        "--omit=dev",
        "--global=false",
        "--workspaces=false",
      ],
      { cwd: installation, stdio: "inherit" },
    );
    const candidate = join(installation, "node_modules", name);
    const manifest = await readPluginManifest(candidate);
    await runPluginBuild(
      candidate,
      manifest.build,
      { info: logPreparation },
      { ...process.env },
    );
    return {
      package: filename,
      // Development dependencies are not installed: Paseo supplies the SDK and zod.
      ...(await checkContributions({
        compileDirectoryPlugin,
        daemonVersion,
        readPluginProviderIcon,
        candidate,
        requireModule: createRequire(join(root, "package.json")),
      })),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// Copy working-tree contents so local, uncommitted fixes are tested too.
async function copyWorkingTree(destination) {
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
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(join(root, file), target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function logPreparation(fields, message) {
  console.log(message, fields.output ?? fields.command);
}

// Compiles both entries with Paseo's compiler and registers them like Paseo.
async function checkContributions({
  compileDirectoryPlugin,
  daemonVersion,
  readPluginProviderIcon,
  candidate,
  requireModule,
}) {
  // The daemon checks requirements.paseo against its own version first.
  await assert.rejects(compileDirectoryPlugin(candidate, "0.14.0"), {
    message: /requires Paseo >=0\.15\.0/u,
  });
  const { serverBundle, clientBundle } = await compileDirectoryPlugin(
    candidate,
    daemonVersion,
  );
  assert.ok(clientBundle, "The client entry must compile");
  assert.ok(
    !clientBundle.includes('"@getpaseo/plugin/client/react-native"'),
    "Import Paseo UI from the current entry",
  );
  assert.ok(
    serverBundle.includes('require("@getpaseo/plugin/server/provider")'),
  );
  const contribution = runInThisContext(serverBundle)((name) =>
    name === "@getpaseo/plugin/server/provider" ? sdk : requireModule(name),
  );
  // Paseo returns a settings handle; the plugin follows the timeline settings
  // with it.
  const settings = [];
  const registerSettings = (definition) => {
    settings.push(definition.id);
    return {
      read: async () => ({
        status: "ready",
        revision: "1",
        values: definition.schema.parse({}),
      }),
      subscribe: () => () => {},
    };
  };
  let registered;
  const sources = [],
    handlers = [];
  const dispose = contribution.default({
    registerProvider(provider) {
      registered = provider;
    },
    registerUsageSource(source) {
      sources.push(source);
    },
    registerSettings,
    handle(contract) {
      handlers.push(contract.name);
    },
  });
  assert.deepEqual(settings, ["timeline"]);
  assert.ok(handlers.includes("zcode.goals"));
  assert.equal(registered.id, "zcode");
  assert.equal(typeof registered.status, "function");
  await readPluginProviderIcon(candidate, registered.icon);
  // Paseo checks these fields and the icon when registering a source.
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source.id, "zcode");
  assert.match(source.id, /^[a-z][a-z0-9._-]*$/);
  assert.equal(typeof source.discover, "function");
  assert.equal(typeof source.fetch, "function");
  assert.equal(typeof source.input.parseAsync, "function");
  await readPluginProviderIcon(candidate, source.icon);
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
      return {
        Platform: { select: () => undefined },
        Pressable: () => null,
        Text: () => null,
        View: () => null,
      };
    if (name === "@getpaseo/plugin/client")
      return {
        openExternalUrl: async () => {},
        useRpc: () => async () => ({}),
        useSettings: () => ({ status: "loading" }),
      };
    if (name === "@getpaseo/plugin/client/ui")
      return {
        copyText: async () => {},
        SettingsAction: () => null,
        SettingsCard: () => null,
        SettingsInput: () => null,
        SettingsRow: () => null,
        SettingsSection: () => null,
        SettingsSelect: () => null,
        SettingsSwitch: () => null,
        Icon: () => null,
      };
    return requireModule(name);
  });
  // Like Paseo's client runtime, each registration returns its own cleanup.
  const screens = new Map();
  // The Goal pill follows the agent directory and the plugin's RPC (ADR 27).
  const pills = new Map();
  let agents, observation;
  const disposeClient = clientContribution.default({
    addSettingsScreen(screen) {
      screens.set(screen.id, screen);
      return () => screens.delete(screen.id);
    },
    addComposerPill(pill) {
      const key = `${pill.workspaceId}/${pill.agentId}/${pill.id}`;
      pills.set(key, pill.button);
      return { update() {}, remove: () => pills.delete(key) };
    },
    rpc: async (contract) => {
      assert.equal(contract.name, "zcode.goals");
      return {
        goals: [
          {
            agentId: "agent-1",
            status: "paused",
            elapsedSeconds: 3780,
            running: false,
            iterations: [],
          },
        ],
      };
    },
    paseo: {
      agents: {
        list: async (options) => {
          assert.deepEqual(options.subscribe, {});
          observation = options.signal;
          return {
            subscription: { subscribe: (observer) => (agents = observer) },
          };
        },
      },
    },
  });
  assert.deepEqual([...screens.keys()], ["settings", "diagnostics"]);
  for (const screen of screens.values())
    assert.equal(typeof screen.Component, "function");
  await new Promise((resolve) => setImmediate(resolve));
  agents.snapshot({
    entries: [
      { agent: { id: "agent-1", provider: "zcode", workspaceId: "w-1" } },
      { agent: { id: "agent-2", provider: "claude", workspaceId: "w-1" } },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...pills.keys()], ["w-1/agent-1/goal"]);
  const [pill] = pills.values();
  assert.equal(pill.label, "Goal 1h 3m");
  assert.equal(pill.behavior.kind, "popover");
  assert.equal(typeof pill.behavior.Content, "function");
  assert.equal(typeof disposeClient, "function");
  await disposeClient();
  assert.equal(screens.size, 0);
  assert.equal(pills.size, 0);
  assert.equal(observation.aborted, true);
  return {
    compiledBytes: Buffer.byteLength(serverBundle),
    clientCompiledBytes: Buffer.byteLength(clientBundle),
    paseoRequirement: "passed",
    registration: "passed",
    settingsRegistration: "passed",
    usageSourceRegistration: "passed",
    clientRegistration: "passed",
    goalPill: "passed",
  };
}

function waitForCompletion(session, turnId, type = "turn_completed") {
  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === type && event.turnId === turnId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Adapter did not complete the public turn"));
    }, 5000);
  });
}
