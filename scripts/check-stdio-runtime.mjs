import assert from "node:assert/strict";
import { z } from "zod";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { e2eProviderConfig } from "./check-e2e.mjs";
import { cleanupOnSignal } from "./runtime-check-lifecycle.mjs";

// Real official Server/Agent, deterministic local model. No account or billable API.

// Official plugin caches (plugin name: skill) for the ADR 19 checks.
const FIXTURE_PLUGINS = {
  "computer-use": "computer-use",
  "browser-use": "control-browser",
  "paseo-fixture": "paseo-fixture-check",
};
const { values } = parseArgs({
  options: { "check-native-restore": { type: "boolean", default: false } },
});
const root = resolve(import.meta.dirname, "..");
const runtime = process.env.PASEO_ZCODE_RUNTIME,
  node = process.env.PASEO_ZCODE_NODE,
  data = process.env.XDG_DATA_HOME;
// Either the explicit override pair or a managed runtime under XDG_DATA_HOME.
const override = Boolean(runtime || node);
assert.ok(
  override ? runtime && node : data,
  "Set PASEO_ZCODE_RUNTIME and PASEO_ZCODE_NODE, or XDG_DATA_HOME with a managed runtime",
);
const windows = process.platform === "win32";
// POSIX keeps /tmp so ZCode's Unix socket paths stay below the platform length limit.
const directory = await realpath(
  await mkdtemp(join(windows ? tmpdir() : "/tmp", "zcode-contract-")),
);
let connection,
  scenario = "bash",
  modelCalls = 0;
const responses = new Set();
const modelRequests = [];
const modelServer = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    modelRequests.push({
      tools: (input.tools ?? []).map((t) => t.function.name),
      messages: JSON.stringify(input.messages ?? []),
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    responses.add(res);
    res.on("close", () => responses.delete(res));
    if (scenario === "hold") return; // interrupt must abort this outstanding model stream.
    const toolName =
      scenario === "question"
        ? "AskUserQuestion"
        : scenario === "permission"
          ? "Write"
          : "Bash";
    const tool = input.tools?.find((t) => t.function.name === toolName);
    const useTool = modelCalls++ === 0;
    if (useTool)
      assert.ok(tool, `${toolName} must be exposed by the real Agent`);
    const args =
      scenario === "question"
        ? {
            questions: [
              {
                header: "Choice",
                question: "Select a value",
                options: [
                  { label: "One", description: "First" },
                  { label: "Two", description: "Second" },
                ],
                multiSelect: false,
              },
            ],
          }
        : scenario === "permission"
          ? {
              file_path: join(directory, "workspace", "approved.txt"),
              content: "APPROVED",
            }
          : {
              command: "printf ZCODE_STDIO_BASH_OK",
              description: "Verify native shell execution",
            };
    const delta = useTool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_${scenario}`,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { content: "STDIO_SMOKE_DONE" };
    const chunk = (delta, finish_reason) => ({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "GLM-5.3-Flash",
      choices: [{ index: 0, delta, finish_reason }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.write(
      `data: ${JSON.stringify(chunk({}, useTool ? "tool_calls" : "stop"))}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.destroy(error);
  }
});
const cleanup = async () => {
  await connection?.close();
  for (const res of responses) res.destroy();
  await new Promise((r) => modelServer.close(r));
  await rm(directory, { recursive: true, force: true });
};
const removeSignalHandlers = cleanupOnSignal(cleanup);
try {
  for (const part of [
    "workspace",
    ".zcode/v2",
    "tmp",
    ...(windows ? ["AppData/Roaming", "AppData/Local"] : []),
  ])
    await mkdir(join(directory, part), { recursive: true });
  await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
  const config = e2eProviderConfig("local-fixture-not-a-secret");
  config.config.providerConfigRules.providerRules[0].config.api.baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  await writeFile(
    join(directory, ".zcode/v2/provider_config.json"),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  // Official plugin caches as ZCode Desktop installs them into the shared
  // storage, plus a control that must stay visible (ADR 19).
  for (const [plugin, skill] of Object.entries(FIXTURE_PLUGINS)) {
    const pluginRoot = join(
      directory,
      ".zcode/cli/plugins/cache/zcode-plugins-official",
      plugin,
      "0.0.0-fixture",
    );
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", skill), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin/plugin.json"),
      JSON.stringify({
        name: plugin,
        version: "0.0.0-fixture",
        description: "Contract fixture.",
      }),
    );
    await writeFile(
      join(pluginRoot, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Contract fixture skill.\n---\n\nFixture.\n`,
    );
  }
  await writeFile(
    join(directory, ".zcode/cli/config.json"),
    JSON.stringify({
      plugins: {
        enabledPlugins: Object.fromEntries(
          Object.keys(FIXTURE_PLUGINS).map((p) => [
            `${p}@zcode-plugins-official`,
            true,
          ]),
        ),
      },
    }),
  );
  // This script owns its process environment; no real user configuration is read.
  // Windows processes also need their system locations; profile paths are isolated below.
  const inherited = windows
    ? ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec"]
    : ["PATH", "SHELL", "LANG"];
  const env = Object.fromEntries(
    inherited.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, {
    ...(windows
      ? {
          USERPROFILE: directory,
          APPDATA: join(directory, "AppData", "Roaming"),
          LOCALAPPDATA: join(directory, "AppData", "Local"),
          TEMP: join(directory, "tmp"),
          TMP: join(directory, "tmp"),
        }
      : {}),
    HOME: directory,
    ZCODE_DATA_BASE_DIR: directory,
    ZCODE_STORAGE_DIR: join(directory, ".zcode"),
    ZCODE_SESSION_DB_PATH: join(directory, "sessions.db"),
    TMPDIR: join(directory, "tmp"),
    ...(override
      ? { PASEO_ZCODE_RUNTIME: runtime, PASEO_ZCODE_NODE: node }
      : { XDG_DATA_HOME: data }),
  });
  await build({
    stdin: {
      contents:
        'export * from "./server/provider.ts"; export * from "./server/persistence.ts"; export * from "./server/discovery/discover.ts"; export {ZCodeHostBridge} from "./server/host/bridge.ts"; export {logger} from "./server/logger.ts";',
      resolveDir: root,
    },
    outfile: join(directory, "provider.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const {
    createZCodeProvider,
    CAPABILITIES,
    SessionPersistenceStore,
    discoverRuntime,
    ZCodeHostBridge,
    logger,
  } = await import(pathToFileURL(join(directory, "provider.mjs")));
  const discovered = await discoverRuntime();
  const { identity, source } = discovered;
  // Runtimes built with patches/zcode list them in BUILD-INFO.json (ADR 19).
  const patched = await readFile(
    join(discovered.paths.installRoot, "BUILD-INFO.json"),
    "utf8",
  ).then(
    (text) =>
      JSON.parse(text).source?.patches?.some(
        (p) => p.file === "patches/0001-hide-suppressed-official-plugins.patch",
      ) === true,
    () => false,
  );
  const bridges = [];
  const provider = createZCodeProvider(
    async (environment, signal, workspace) => {
      const env = { ...process.env, ...environment };
      const runtime = await discoverRuntime({ environment: env, signal });
      const bridge = ZCodeHostBridge.start(runtime, logger, env, workspace);
      bridges.push(bridge);
      return bridge;
    },
    new SessionPersistenceStore(join(directory, "mapping")),
  );
  let events = [];
  const connect = async () => {
    events = [];
    connection = await provider.connect({
      versions: [1],
      capabilities: CAPABILITIES,
    });
    connection.onEvent((e) => events.push(e));
  };
  const wait = async (predicate) => {
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      const failure = events.find(
        (e) =>
          e.type === "request.failed" ||
          e.type === "session.runtime_failed" ||
          (e.type === "session.prompt_result" && e.result.type === "failed"),
      );
      if (failure) throw new Error(JSON.stringify(failure));
      const result = events.find(predicate);
      if (result) return result;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `Timed out: ${JSON.stringify(events.map((e) => ({ type: e.type, state: e.state, kind: e.request?.kind })))}`,
    );
  };
  let seq = 0;
  const send = (input) => connection.send({ ...input, sessionId: "test" });
  const open = async (persistence, restoredConfig = {}) => {
    const requestId = `open-${++seq}`;
    await send({
      type: "session.open",
      requestId,
      history: "replay",
      config: {
        cwd: join(directory, "workspace"),
        persist: true,
        env: {},
        mcpServers: {},
        settings: {},
        providerOptions: {},
        ...restoredConfig,
      },
      ...(persistence ? { persistence } : {}),
    });
    await wait((e) => e.type === "session.ready" && e.requestId === requestId);
    return events.findLast((e) => e.type === "session.opened").persistence;
  };
  const configure = async (changes) => {
    const requestId = `config-${++seq}`;
    await send({ type: "session.configure", requestId, changes });
    await wait(
      (e) => e.type === "request.completed" && e.requestId === requestId,
    );
  };
  const prompt = async (name, text = `Execute the ${name} fixture.`) => {
    scenario = name;
    modelCalls = 0;
    events = [];
    await send({
      type: "session.prompt",
      prompt: {
        clientMessageId: `message-${++seq}`,
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text }],
        },
      },
    });
    await wait((e) => e.type === "session.prompt_result");
  };
  const terminal = () =>
    wait(
      (e) =>
        e.type === "session.turn" &&
        ["completed", "canceled", "failed"].includes(e.state),
    );
  await connect();
  await connection.send({
    type: "catalog",
    requestId: "catalog",
    cwd: join(directory, "workspace"),
  });
  assert.ok((await wait((e) => e.type === "catalog")).catalog.models.length);
  let saved = await open();
  assert.equal(saved.version, 3);
  await configure({ mode: "yolo" });
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  assert.ok(
    events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "tool_call" &&
        e.item.status === "completed" &&
        e.item.detail.output?.includes("ZCODE_STDIO_BASH_OK"),
    ),
  );
  assert.equal(
    events.filter((e) => e.type === "session.prompt_result").length,
    1,
  );
  assert.equal(
    events.filter((e) => e.type === "session.turn" && e.state === "completed")
      .length,
    1,
  );
  // Unsupported official capabilities (ADR 19). The control fixture proves
  // that the fixture caches are discovered at all.
  const turnRequest = modelRequests.find((r) => r.tools.includes("Bash"));
  assert.ok(turnRequest, "The Bash turn must reach the model");
  assert.ok(
    !turnRequest.tools.includes("mcp__node_repl__js"),
    "The shared Browser and Computer Use tool must be hidden from every turn",
  );
  // Enabled plugins that discovery skipped are still listed as "missing".
  const listedPlugins =
    // The session's Server; the catalog's Server has already closed.
    (
      await bridges.at(-1).request(
        "listPlugins",
        { workspacePath: join(directory, "workspace") },
        z.object({
          plugins: z.array(
            z.object({ id: z.string(), source: z.string() }).passthrough(),
          ),
        }),
      )
    ).plugins
      .filter((p) => p.source !== "missing")
      .map((p) => p.id);
  assert.ok(
    listedPlugins.includes("paseo-fixture@zcode-plugins-official"),
    String(listedPlugins),
  );
  assert.ok(turnRequest.messages.includes("paseo-fixture:paseo-fixture-check"));
  for (const [plugin, skill] of Object.entries(FIXTURE_PLUGINS)) {
    if (plugin === "paseo-fixture") continue;
    assert.equal(
      listedPlugins.includes(`${plugin}@zcode-plugins-official`),
      !patched,
      `${plugin} must be ${patched ? "hidden by the patch" : "visible without the patch"}`,
    );
    assert.equal(
      turnRequest.messages.includes(`${plugin}:${skill}`),
      !patched,
      `${plugin}:${skill} skill visibility`,
    );
  }
  await configure({ settings: { plan_mode: true } });
  await configure({ mode: "edit" });
  const beforeResume = events.findLast(
    (e) => e.type === "session.config",
  ).config;
  assert.equal(beforeResume.mode, "edit");
  assert.equal(
    beforeResume.settings.find((s) => s.id === "plan_mode").value,
    true,
  );
  await send({ type: "session.close", requestId: "close-native" });
  await wait((e) => e.type === "session.closed");
  await connection.close();
  await connect();
  if (values["check-native-restore"]) {
    // Separate upstream check: settings omitted here intentionally. The normal
    // Provider contract requires Paseo's saved mode and Plan settings instead.
    await open(saved);
    const resumed = events.findLast((e) => e.type === "session.config").config;
    assert.deepEqual(
      {
        mode: resumed.mode,
        plan: resumed.settings.find((s) => s.id === "plan_mode").value,
      },
      { mode: "edit", plan: true },
      "ZCode cold resume without explicit settings must restore its saved execution state",
    );
    await connection.close();
    await connect();
  }
  // Paseo keeps modeId and featureValues separately from the native handle.
  // Reapply the actual values captured before shutdown, not native resume's
  // potentially stale values. No prompt is submitted to trigger the change.
  await open(saved, {
    mode: beforeResume.mode,
    settings: Object.fromEntries(
      beforeResume.settings.map((setting) => [setting.id, setting.value]),
    ),
  });
  const restoredConfigs = events.filter((e) => e.type === "session.config");
  assert.ok(restoredConfigs.length);
  for (const { config } of restoredConfigs) {
    assert.equal(config.mode, "edit");
    assert.equal(config.settings.find((s) => s.id === "plan_mode").value, true);
  }
  assert.ok(
    events.indexOf(restoredConfigs[0]) <
      events.findIndex((e) => e.type === "session.ready"),
  );
  assert.equal(
    events.some((e) => e.type === "session.turn"),
    false,
  );
  assert.ok(
    events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text === "STDIO_SMOKE_DONE",
    ),
  );
  await configure({ mode: "yolo", settings: { plan_mode: false } });
  await prompt("question");
  const question = (
    await wait(
      (e) => e.type === "session.permission" && e.request.kind === "question",
    )
  ).request;
  const field = question.input.questions[0];
  await send({
    type: "session.permission",
    permissionId: question.id,
    response: {
      behavior: "allow",
      updatedInput: { answers: { [field.header]: "One" } },
    },
  });
  assert.equal((await terminal()).state, "completed");
  await configure({ mode: "build" });
  await prompt("permission");
  const permission = (
    await wait(
      (e) => e.type === "session.permission" && e.request.kind === "tool",
    )
  ).request;
  const action = permission.actions.find((a) => a.behavior === "allow");
  assert.ok(action);
  await send({
    type: "session.permission",
    permissionId: permission.id,
    response: { behavior: "allow", selectedActionId: action.id },
  });
  assert.equal((await terminal()).state, "completed");
  await prompt("hold");
  await wait((e) => e.type === "session.turn" && e.state === "started");
  await send({ type: "session.interrupt", requestId: "stop" });
  assert.equal((await terminal()).state, "canceled");
  await configure({ mode: "yolo" });
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  await prompt("command", "/plan");
  assert.equal(
    events.find((e) => e.type === "session.prompt_result").result.type,
    "completed",
  );
  assert.equal(events.filter((e) => e.type === "session.turn").length, 0);
  assert.equal(
    events
      .findLast((e) => e.type === "session.config")
      .config.settings.find((s) => s.id === "plan_mode").value,
    true,
  );
  await connection.send({
    type: "sessions",
    requestId: "list",
    cwd: join(directory, "workspace"),
  });
  const listed = (await wait((e) => e.type === "sessions")).sessions;
  assert.ok(listed.length);
  assert.ok(listed.every((s) => s.persistence.version === 3));
  await configure({ mode: "yolo", settings: { plan_mode: false } });
  await prompt("hold");
  const activeBridge = bridges.findLast((b) => !b.closing);
  const owned = await activeBridge.request(
    "collectLocalRuntimeChildProcesses",
    undefined,
    z.array(z.object({ pid: z.number().int().positive() })),
  );
  assert.ok(owned.length);
  // Deliberately kill this test's Server; Agent stdin EOF must drive its own cleanup.
  activeBridge.child.kill("SIGKILL");
  const exited = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
  };
  const deadline = Date.now() + 15000;
  while (owned.some((p) => !exited(p.pid)) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    owned.every((p) => exited(p.pid)),
    "Owned Agent must exit after its Server is killed",
  );
  console.log(
    JSON.stringify(
      {
        identity,
        source,
        restoration: "Paseo's saved mode and Plan settings",
        ...(values["check-native-restore"]
          ? { nativePlanRestore: "passed" }
          : {}),
        checks: [
          "catalog",
          "draft",
          "Bash",
          "single ACK/completion",
          "cold resume with Paseo mode and Plan settings",
          "history replay",
          "question",
          "permission",
          "targeted stop",
          "restart after stop",
          "slash command completion",
          "session listing v3",
          "EOF cleanup",
          "Agent cleanup after Server SIGKILL",
          patched
            ? "unsupported plugins and tool hidden (patched runtime)"
            : "unsupported tool hidden, plugins visible (unpatched runtime)",
        ],
        model: "local deterministic fixture",
        sharedUserData: "not accessed",
      },
      null,
      2,
    ),
  );
} finally {
  removeSignalHandlers();
  await cleanup();
}
