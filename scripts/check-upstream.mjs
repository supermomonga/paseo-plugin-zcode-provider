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
  const hosts = [];
  const warnings = [];
  const registry = new PluginAgentClientRegistry({
    warn(...args) {
      warnings.push(args);
    },
  });
  function createRegistration(initial) {
    return createZCodeProvider(
      async () => {
        const host = new FakeBridge(structuredClone(initial));
        hosts.push(host);
        return host;
      },
      new SessionPersistenceStore(join(directory, "provider-state")),
    );
  }
  const initial = snapshot(directory);
  initial.runtime.contextUsage = { used: 20, size: 100 };
  const registration = createRegistration(initial);
  const closed = Promise.withResolvers();
  let connectionCloseCount = 0;
  const connect = registration.connect;
  registration.connect = async (request) => {
    const connection = await connect(request);
    const close = connection.close.bind(connection);
    connection.close = async () => {
      connectionCloseCount += 1;
      await close();
      closed.resolve();
    };
    return connection;
  };
  registry.replace([registration]);
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
    const firstCompleted = waitForCompletion(session, turn.turnId);
    await completeTurn(host, 3);
    await firstCompleted;
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
    const persistence = session.describePersistence();
    assert.ok(persistence);

    // Simulate the native transcript retained after the completed turn.
    const saved = structuredClone(host.current);
    saved.messages = [
      {
        info: { messageId: "native-user-1", role: "user" },
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        info: { messageId: "assistant-1", role: "assistant" },
        parts: [{ type: "text", text: "hello" }],
      },
    ];
    registry.replace([createRegistration(saved)]);
    await closed.promise;
    assert.equal(connectionCloseCount, 1);
    assert.equal(host.closed, true);
    await assert.rejects(
      session.startTurn("Stale session", { clientMessageId: "stale-message" }),
      { name: "StaleProviderSessionError" },
    );
    await session.close();
    assert.equal(connectionCloseCount, 1);
    assert.equal(
      host.calls.filter(({ method }) => method === "sendConversationCommandV4")
        .length,
      1,
    );

    const replacement = registry.clients().zcode;
    assert.notEqual(replacement, client);
    const resumed = await replacement.resumeSession(persistence, {
      cwd: directory,
      modeId: "edit",
    });
    const resumedHost = hosts.at(-1);
    assert.notEqual(resumedHost, host);
    assert.deepEqual(
      resumedHost.calls
        .filter(({ method }) => method === "resumeSession")
        .map(({ params }) => params),
      [{ workspacePath: directory, sessionId: "session-1", mcpServers: [] }],
    );
    assert.equal(
      resumedHost.calls.some(({ method }) => method === "createSession"),
      false,
    );
    assert.deepEqual(resumed.describePersistence(), persistence);
    assert.deepEqual(
      resumed
        .timelineHistory()
        .filter(
          ({ item }) =>
            item.type === "user_message" || item.type === "assistant_message",
        )
        .map(({ item }) => ({ type: item.type, text: item.text })),
      [
        { type: "user_message", text: "Hello" },
        { type: "assistant_message", text: "hello" },
      ],
    );
    const resumedEvents = [];
    resumed.subscribe((event) => resumedEvents.push(event));
    const resumedInitialUsageReplayed = resumedEvents.some(
      (event) => event.type === "usage_updated",
    );
    const resumedTurn = await resumed.startTurn("After reload", {
      clientMessageId: "after-reload",
    });
    const resumedCompleted = waitForCompletion(resumed, resumedTurn.turnId);
    await completeTurn(resumedHost);
    await resumedCompleted;
    assert.equal(
      resumedEvents.find((event) => event.type === "turn_completed").turnId,
      resumedTurn.turnId,
    );
    assert.deepEqual(
      resumedEvents
        .filter(
          (event) =>
            event.type === "timeline" && event.item.type === "user_message",
        )
        .map((event) => event.item.text),
      ["After reload"],
    );
    assert.equal(
      resumedHost.calls.filter(
        ({ method }) => method === "sendConversationCommandV4",
      ).length,
      1,
    );
    // Exercise Paseo's actual steering decision, including an attachment queued
    // by ZCode. An unavailable result would trigger replacement in AgentManager.
    const run = await resumed.startTurn("Steering integration", {
      clientMessageId: "steering-start",
    });
    let seq = 1;
    const nativeEvent = (type, payload, turnId = "native-steering") =>
      resumedHost.emit({
        type: "session.event",
        event: {
          type,
          payload,
          turnId,
          eventId: `steering-${++seq}`,
          seq,
          sessionId: "session-1",
          timestamp: seq,
          deliveryKind: "desktop-continuous",
        },
      });
    const inputs = () =>
      resumedHost.calls
        .filter((c) => c.method === "sendConversationCommandV4")
        .map((c) => c.params.envelope)
        .filter((e) => e.type === "sendText");
    await nativeEvent("turn.started", { inputId: inputs().at(-1).commandId });
    assert.deepEqual(
      await resumed.steerActiveTurn("Additional text", {
        expectedTurnId: run.turnId,
        clientMessageId: "steering-text",
      }),
      { status: "accepted" },
    );
    assert.deepEqual(
      await resumed.steerActiveTurn(
        [
          { type: "text", text: "Queued attachment" },
          { type: "image", mimeType: "image/png", data: "dGVzdA==" },
        ],
        { expectedTurnId: run.turnId, clientMessageId: "steering-image" },
      ),
      { status: "accepted" },
    );
    assert.equal(inputs().length, 4);
    const [guide, queued] = resumedHost.queueItems;
    await nativeEvent("turn.steerDrained", {
      targetTurnId: "native-steering",
      pendingInputIds: [guide.queueItemId],
    });
    resumedHost.queueItems.shift();
    await nativeEvent("turn.completed", { resultType: "success" });
    assert.equal(
      resumedEvents.filter(
        (e) => e.type === "turn_completed" && e.turnId === run.turnId,
      ).length,
      0,
    );
    resumedHost.conversationPhase = "running";
    await nativeEvent(
      "turn.started",
      { inputId: queued.sourceCommandId },
      "native-queued",
    );
    resumedHost.queueItems = [];
    await resumedHost.emitConversation();
    const queuedCompleted = waitForCompletion(resumed, run.turnId);
    await nativeEvent(
      "turn.completed",
      { resultType: "success" },
      "native-queued",
    );
    await queuedCompleted;
    assert.equal(
      resumedEvents.filter(
        (e) => e.type === "turn_completed" && e.turnId === run.turnId,
      ).length,
      1,
    );
    assert.equal(
      inputs().length,
      4,
      "accepted steering must not be resent or replace the run",
    );
    await resumed.close();
    assert.equal(resumedHost.closed, true);
    console.log(
      JSON.stringify({
        initialUsageReplayed,
        resumedInitialUsageReplayed,
        liveUsage: "passed",
      }),
    );
  } finally {
    await registry.shutdown();
  }
  assert.deepEqual(warnings, []);
  console.log(
    JSON.stringify(
      {
        commit: execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        gitPreparation,
        coreAdapter: "passed",
        textSteering: "passed",
        attachmentQueue: "passed",
        singleCompletion: "passed",
        providerReplacement: "passed",
        persistenceResume: "passed",
        historyReplay: "passed",
        resumedTurn: "passed",
      },
      null,
      2,
    ),
  );
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
      await copyFile(join(root, file), destination);
    }
    const nodeRequire = createRequire(join(candidate, "package.json"));
    await assert.rejects(access(join(candidate, "node_modules")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(candidate, "server/build-info.ts")), {
      code: "ENOENT",
    });
    assert.throws(() => nodeRequire.resolve("es-module-lexer"), {
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
      relative(candidate, nodeRequire.resolve("es-module-lexer")).startsWith(
        `node_modules${sep}`,
      ),
      "Resolve the lexer from the prepared candidate's own dependencies",
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
