import assert from "node:assert/strict";
import { z } from "zod";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gte } from "semver";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { e2eProviderConfig } from "./check-e2e.mjs";
import { cleanupOnSignal } from "./runtime-check-lifecycle.mjs";

// Real official Server/Agent, deterministic local model. No account or billable API.

// Official plugin caches (plugin name: skill) for the ADR 19 checks.
const FIXTURE_PLUGINS = {
  "computer-use": "computer-use",
  "browser-use": "control-browser",
  // 3.15.1+ also bundles it; its skill has the same name.
  visualize: "visualize",
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
// What the completion verifier answers next in the goal scenarios.
let goalVerdicts = [];
const responses = new Set();
const modelRequests = [];
// A stdio MCP server with one tool, as Paseo would pass to a session.
const MCP_FIXTURE = `import { createInterface } from "node:readline";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize")
    send({ id, result: {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "paseofixture", version: "1.0.0" },
    } });
  else if (method === "tools/list")
    send({ id, result: { tools: [{
      name: "probe",
      description: "Paseo fixture tool",
      inputSchema: { type: "object", properties: {} },
    }] } });
  else if (method === "ping") send({ id, result: {} });
  else send({ id, error: { code: -32601, message: "Method not found" } });
}
`;
// GLM's weekly or monthly quota response (business code 1310).
const QUOTA_MESSAGE =
  "您已达到每周/每月使用上限，您的限额将在 2026-11-07 16:34:13 重置。";
const modelServer = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    modelRequests.push({
      tools: (input.tools ?? []).map((t) => t.function.name),
      messages: JSON.stringify(input.messages ?? []),
      appVersion: req.headers["x-zcode-app-version"],
    });
    if (scenario === "quota") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "1310", message: QUOTA_MESSAGE } }),
      );
      return;
    }
    if (scenario.startsWith("goal") && input.stream !== true) {
      // ZCode titles a goal and verifies its completion without streaming.
      const last = JSON.stringify(input.messages?.at(-1)?.content ?? "");
      const content = last.includes("Verify whether the active session goal")
        ? JSON.stringify({
            passed: goalVerdicts.shift() ?? true,
            reason: "fixture verdict",
            nextAction: "Finish the fixture goal",
          })
        : "Fixture goal";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion",
          created: 0,
          model: "GLM-5.3-Flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    responses.add(res);
    res.on("close", () => responses.delete(res));
    // interrupt must abort this outstanding model stream.
    if (["hold", "goalHold", "compactHold"].includes(scenario)) return;
    const toolName =
      scenario === "question"
        ? "AskUserQuestion"
        : scenario === "permission"
          ? "Write"
          : "Bash";
    const tool = input.tools?.find((t) => t.function.name === toolName);
    // Each turn toward a goal only replies; the verifier decides the rest.
    // A compaction asks for a summary and rejects tool calls.
    const useTool =
      modelCalls++ === 0 && !["goal", "compact"].includes(scenario);
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
          : scenario === "guarded"
            ? {
                // A recursive rm matches ZCode's guarded safety rules.
                command: "rm -r guarded-fixture",
                description: "Remove the guarded fixture directory",
              }
            : scenario === "background"
              ? {
                  command: "sleep 3",
                  description: "Outlive the foreground turn",
                  run_in_background: true,
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
    if (scenario === "filtered") {
      // GLM ends a reply that its output safety review blocked with "sensitive".
      res.write(`data: ${JSON.stringify(chunk({}, "sensitive"))}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
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
    "workspace/guarded-fixture",
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
        'export * from "./server/provider.ts"; export * from "./server/persistence.ts"; export * from "./server/discovery/discover.ts"; export {ZCodeHostBridge} from "./server/host/bridge.ts"; export {logger} from "./server/logger.ts"; export {GoalDirectory} from "./server/goal.ts";',
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
    GoalDirectory,
  } = await import(pathToFileURL(join(directory, "provider.mjs")));
  // The goals the Goal pill reads, by Paseo agent (ADR 27).
  const goals = new GoalDirectory();
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
    undefined,
    undefined,
    goals,
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
        // Paseo names the agent in the launch environment of every session.
        env: { PASEO_AGENT_ID: "fixture-agent" },
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
  // Paseo's idle runtime cleanup asks this before closing a session.
  const canStopRuntime = async () => {
    const requestId = `can-stop-${++seq}`;
    await send({ type: "session.can_stop_runtime", requestId });
    return (
      await wait(
        (e) =>
          e.type === "session.can_stop_runtime" && e.requestId === requestId,
      )
    ).canStop;
  };
  await connect();
  await connection.send({
    type: "catalog",
    requestId: "catalog",
    cwd: join(directory, "workspace"),
  });
  const { catalog } = await wait((e) => e.type === "catalog");
  assert.ok(catalog.models.length);
  // Guarded ("Autonomous mode") exists from ZCode 3.15.1.
  const guarded = gte(identity.appVersion, "3.15.1");
  const contentFilter = gte(identity.appVersion, "3.17.1");
  assert.equal(
    catalog.modes.some((m) => m.id === "guarded"),
    guarded,
    "Guarded mode must be offered exactly when the Server supports it",
  );
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
  assert.equal(
    turnRequest.appVersion,
    identity.appVersion,
    "Model requests must report the ZCode app version, as Desktop's do",
  );
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
  if (guarded) {
    // Ordinary commands run without approval; a risky one asks once per
    // execution and offers no lasting approval.
    await configure({ mode: "guarded" });
    await prompt("bash");
    assert.equal((await terminal()).state, "completed");
    assert.equal(
      events.some((e) => e.type === "session.permission"),
      false,
    );
    await prompt("guarded");
    const risky = (
      await wait(
        (e) => e.type === "session.permission" && e.request.kind === "tool",
      )
    ).request;
    assert.equal(risky.name, "Bash");
    assert.deepEqual(risky.actions.map((a) => a.behavior).sort(), [
      "allow",
      "deny",
    ]);
    await send({
      type: "session.permission",
      permissionId: risky.id,
      response: {
        behavior: "deny",
        selectedActionId: risky.actions.find((a) => a.behavior === "deny").id,
      },
    });
    assert.equal((await terminal()).state, "completed");
    await readdir(join(directory, "workspace", "guarded-fixture"));
  }
  await prompt("hold");
  await wait((e) => e.type === "session.turn" && e.state === "started");
  await send({ type: "session.interrupt", requestId: "stop" });
  assert.equal((await terminal()).state, "canceled");
  await configure({ mode: "yolo" });
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  // A provider failure reaches Paseo classified, without the provider's text (ADR 23).
  await prompt("quota");
  const quota = await terminal();
  assert.equal(quota.state, "failed");
  assert.equal(quota.error.code, "MODEL_RATE_LIMITED");
  assert.match(quota.error.message, /\(HTTP 429, provider code 1310\)/u);
  assert.equal(
    JSON.parse(quota.error.diagnostic).failure.reason,
    "rate_limited",
  );
  assert.ok(!JSON.stringify(quota).includes(QUOTA_MESSAGE));
  if (contentFilter) {
    // Since 3.17.1 ZCode fails a blocked reply at once instead of retrying it.
    await prompt("filtered");
    const filtered = await terminal();
    assert.equal(filtered.state, "failed");
    assert.equal(filtered.error.code, "MODEL_CONTENT_FILTERED");
    assert.equal(
      JSON.parse(filtered.error.diagnostic).failure.reason,
      "content_filter",
    );
    assert.equal(modelCalls, 1, "ZCode must not retry a blocked reply");
  }
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  assert.equal(await canStopRuntime(), true);
  // A background Bash outlives the foreground turn and keeps the runtime until
  // ZCode delivers its result in a turn of its own.
  await prompt("background");
  const foreground = await terminal();
  assert.equal(foreground.state, "completed");
  assert.equal(await canStopRuntime(), false);
  const continuation = await wait(
    (e) =>
      e.type === "session.turn" &&
      e.state === "completed" &&
      e.turnId !== foreground.turnId,
  );
  assert.ok(continuation);
  assert.equal(await canStopRuntime(), true);
  // /goal is the Server's goal command, not text (ADR 27). ZCode works toward
  // the goal in turns it starts itself until the verifier passes it.
  assert.deepEqual(goals.views(), []);
  goalVerdicts = [false, true];
  await prompt("goal", "/goal Create the file goal.txt");
  assert.equal(
    events.find((e) => e.type === "session.prompt_result").result.type,
    "turn",
  );
  assert.equal((await terminal()).state, "completed");
  assert.equal(
    events.filter((e) => e.type === "session.turn" && e.state === "started")
      .length,
    1,
    "An unsatisfied goal continues within the turn that set it",
  );
  assert.ok(
    events.some(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "user_message" &&
        e.item.text === "/goal Create the file goal.txt",
    ),
  );
  const [verified] = goals.views();
  assert.equal(verified.agentId, "fixture-agent");
  assert.equal(verified.status, "verified");
  assert.equal(verified.running, false);
  assert.deepEqual(
    verified.iterations.map((row) => [row.iteration, row.title]),
    [
      [1, "Fixture goal"],
      [2, "Finish the fixture goal"],
    ],
  );
  assert.equal(await canStopRuntime(), true);
  // Stopping the turn pauses the goal; /goal resume continues it.
  goalVerdicts = [true];
  await prompt("goalHold", "/goal replace Append DONE to goal.txt");
  await wait((e) => e.type === "session.turn" && e.state === "started");
  // The turn starts on ZCode's acknowledgement; the replaced goal follows on
  // the event stream and stays in progress while the model request is held.
  const goalStates = () =>
    goals.views().map((goal) => [goal.status, goal.running]);
  for (let i = 0; i < 1500 && goalStates()[0]?.[1] !== true; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(goalStates(), [["active", true]]);
  assert.equal(await canStopRuntime(), false);
  await send({ type: "session.interrupt", requestId: "stop-goal" });
  assert.equal((await terminal()).state, "canceled");
  assert.deepEqual(
    goals.views().map((goal) => [goal.status, goal.running]),
    [["paused", false]],
  );
  assert.equal(await canStopRuntime(), true);
  await prompt("goal", "/goal resume");
  assert.equal(
    events.find((e) => e.type === "session.prompt_result").result.type,
    "turn",
  );
  assert.equal((await terminal()).state, "completed");
  assert.equal(goals.views()[0].status, "verified");
  // /compact adds no user input row: the header of its turn carries the
  // command ID, and its works name no foreground execution (ADR 28).
  const notifications = () =>
    events
      .filter(
        (e) => e.type === "timeline.item" && e.item.type === "notification",
      )
      .map((e) => e.item.message);
  await prompt("compact", "/compact keep the fixture notes");
  assert.equal(
    events.find((e) => e.type === "session.prompt_result").result.type,
    "turn",
  );
  assert.equal((await terminal()).state, "completed");
  assert.deepEqual(notifications(), ["Context compaction: success"]);
  assert.ok(
    modelRequests
      .at(-1)
      .messages.includes("Additional Instructions:\\nkeep the fixture notes"),
    "The instructions of /compact must reach the summary request",
  );
  assert.equal(await canStopRuntime(), true);
  // Stop cancels a compaction in progress and leaves the session usable.
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  await prompt("compactHold", "/compact");
  for (let i = 0; i < 1500 && responses.size === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(responses.size, "The summary request must be outstanding");
  // The Server projects the compaction shortly after it asks the model.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await canStopRuntime(), false);
  await send({ type: "session.interrupt", requestId: "stop-compact" });
  assert.equal((await terminal()).state, "canceled");
  await wait(
    (e) => e.type === "request.completed" && e.requestId === "stop-compact",
  );
  await wait(
    (e) =>
      e.type === "timeline.item" &&
      e.item.message === "Context compaction: cancelled",
  );
  assert.equal(notifications().length, 1);
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
  // Paseo can resume an agent interrupted by a host restart: it reopens the
  // saved session with its settings and sends a prompt.
  await connection.close();
  await connect();
  await open(saved, { mode: "yolo", settings: { plan_mode: false } });
  await prompt("bash", "Resume working.");
  assert.equal((await terminal()).state, "completed");
  // Paseo's MCP servers reach the model even when the project declares one of
  // the same name, which ZCode 3.17 keeps until the project is trusted.
  await send({ type: "session.close", requestId: "close-mcp" });
  await wait((e) => e.type === "session.closed");
  await connection.close();
  await connect();
  const mcpWorkspace = join(directory, "mcp-workspace");
  await mkdir(join(mcpWorkspace, ".agents"), { recursive: true });
  await writeFile(
    join(mcpWorkspace, ".agents/mcp.json"),
    JSON.stringify({
      mcpServers: { paseofixture: { command: process.execPath, args: [] } },
    }),
  );
  await writeFile(join(directory, "mcp-fixture.mjs"), MCP_FIXTURE);
  await open(undefined, {
    cwd: mcpWorkspace,
    mode: "yolo",
    mcpServers: {
      paseofixture: {
        type: "stdio",
        command: process.execPath,
        args: [join(directory, "mcp-fixture.mjs")],
      },
    },
  });
  await prompt("bash");
  assert.equal((await terminal()).state, "completed");
  // Title generation for the new session also reaches the model, without tools.
  const mcpTurn = modelRequests.findLast((r) => r.tools.includes("Bash"));
  assert.ok(
    mcpTurn.tools.includes("mcp__paseofixture__probe"),
    `Paseo's MCP server must reach the model: ${mcpTurn.tools}`,
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
          "app version in model requests",
          "single ACK/completion",
          "cold resume with Paseo mode and Plan settings",
          "history replay",
          "question",
          "permission",
          ...(guarded ? ["guarded risky-command approval"] : []),
          "targeted stop",
          "restart after stop",
          "provider quota failure",
          ...(contentFilter ? ["content-filtered reply"] : []),
          "restart after failure",
          "idle runtime kept for background Bash",
          "goal set, continued and verified",
          "goal paused by stop and resumed",
          "compaction with instructions completed",
          "compaction stopped",
          "slash command completion",
          "session listing v3",
          "EOF cleanup",
          "Agent cleanup after Server SIGKILL",
          "resume after Server SIGKILL",
          "Paseo's MCP server beside a project declaration",
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
