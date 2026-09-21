import { cleanupOnSignal } from "./runtime-check-lifecycle.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Opt-in: sends real model requests using existing authentication. ZCode retains
// the test conversations; all workspace files and provider mappings are temporary.
const root = resolve(import.meta.dirname, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "zcode-model-plan-")),
);
let connection;
const cleanup = async () => {
  await connection?.close();
  await rm(directory, { recursive: true, force: true });
};
const removeSignalHandlers = cleanupOnSignal(cleanup);
try {
  await build({
    stdin: {
      contents:
        'export * from "./server/provider.ts"; export * from "./server/persistence.ts";',
      resolveDir: root,
    },
    outfile: join(directory, "provider.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { createZCodeProvider, CAPABILITIES, SessionPersistenceStore } =
    await import(pathToFileURL(join(directory, "provider.mjs")).href);
  const provider = createZCodeProvider(
    undefined,
    new SessionPersistenceStore(join(directory, "state")),
  );
  let events = [];
  const listeners = new Set();
  const connect = async () => {
    events = [];
    connection = await provider.connect({
      versions: [1],
      capabilities: CAPABILITIES,
    });
    connection.onEvent((event) => {
      events.push(event);
      for (const listener of listeners) listener();
    });
  };
  const wait = (predicate) =>
    new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error("Model/plan runtime check timed out"));
      }, 180_000);
      const check = () => {
        const failure = events.find(
          (e) =>
            e.type === "request.failed" ||
            e.type === "session.runtime_failed" ||
            (e.type === "session.prompt_result" && e.result.type === "failed"),
        );
        const result = events.find(predicate);
        if (failure || result) {
          clearTimeout(timer);
          listeners.delete(check);
          if (failure)
            reject(
              new Error(
                `${failure.type}: ${failure.error?.code ?? failure.result?.error?.code}`,
              ),
            );
          else resolveResult(result);
        }
      };
      listeners.add(check);
      check();
    });
  let sequence = 0;
  const configure = async (changes) => {
    const requestId = `configure-${++sequence}`;
    await connection.send({
      type: "session.configure",
      sessionId: "test",
      requestId,
      changes,
    });
    await wait(
      (e) => e.type === "request.completed" && e.requestId === requestId,
    );
  };
  const current = () =>
    events.findLast((e) => e.type === "session.config").config;
  const assertMode = (mode, plan) => {
    assert.equal(current().mode, mode);
    assert.equal(
      current().settings.find((s) => s.id === "plan_mode").value,
      plan,
    );
  };
  const config = {
    cwd: directory,
    env: {},
    settings: {},
    mcpServers: {},
    persist: true,
  };
  const open = async (changes, persistence) => {
    const requestId = `open-${++sequence}`;
    await connection.send({
      type: "session.open",
      sessionId: "test",
      requestId,
      config: { ...config, ...changes },
      history: "replay",
      ...(persistence ? { persistence } : {}),
    });
    await wait((e) => e.type === "session.ready" && e.requestId === requestId);
    return events.findLast((e) => e.type === "session.opened").persistence;
  };
  const close = async () => {
    events = [];
    await connection.send({
      type: "session.close",
      sessionId: "test",
      requestId: `close-${++sequence}`,
    });
    await wait((e) => e.type === "session.closed");
    events = [];
  };
  await connect();
  await connection.send({
    type: "catalog",
    requestId: "catalog",
    cwd: directory,
  });
  const { catalog } = await wait((e) => e.type === "catalog");
  const defaultModel = catalog.models.find(
    (m) => m.id === catalog.defaultModel,
  );
  const alternate = catalog.models.find((m) => m.id !== catalog.defaultModel);
  assert.ok(
    defaultModel && alternate,
    "The runtime check requires two configured models",
  );
  await open({ model: alternate.id });
  assert.equal(current().model, alternate.id);
  for (const model of [defaultModel, alternate, defaultModel]) {
    await configure({ model: model.id });
    assert.equal(current().model, model.id);
    assert.equal(current().models.length, catalog.models.length);
    for (const option of model.thinkingOptions) {
      await configure({ thinkingOption: option.id });
      assert.equal(current().thinkingOption, option.id);
    }
  }
  await configure({ thinkingOption: defaultModel.thinkingOptions[0].id });
  for (const mode of ["build", "edit", "yolo"]) {
    await configure({ mode, settings: { plan_mode: true } });
    assertMode(mode, true);
  }
  await configure({ settings: { plan_mode: false } });
  assertMode("yolo", false);
  await close();
  console.log(
    JSON.stringify({
      nativeModelChanges: "passed",
      nativeReasoningLevels: "passed",
      independentPlanSettings: "passed",
      models: catalog.models.length,
    }),
  );

  let saved;
  let savedSettings;
  for (const [mode, behavior] of [
    ["build", "allow"],
    ["edit", "allow"],
    ["yolo", "allow"],
    ["edit", "deny"],
  ]) {
    saved = await open({
      model: defaultModel.id,
      thinkingOption: defaultModel.thinkingOptions[0].id,
      mode,
      settings: { plan_mode: true },
    });
    assertMode(mode, true);
    const clientMessageId = `plan-${mode}-${behavior}`;
    await connection.send({
      type: "session.prompt",
      sessionId: "test",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: {
          type: "message",
          content: [
            {
              type: "text",
              text: "Integration test: propose a one-step plan to reply PLAN_OK. Do not read or change files, run commands, or use any tools except ExitPlanMode. Call ExitPlanMode to request approval. If approved, just answer PLAN_OK. If declined, stop without requesting approval again.",
            },
          ],
        },
      },
    });
    const { request } = await wait(
      (e) => e.type === "session.permission" && e.request.kind === "plan",
    );
    const action = request.actions.find((a) => a.behavior === behavior);
    assert.ok(action);
    await connection.send({
      type: "session.permission",
      sessionId: "test",
      permissionId: request.id,
      response: { behavior, selectedActionId: action.id },
    });
    await wait((e) => e.type === "session.permission_resolved");
    await wait((e) => e.type === "session.turn" && e.state === "completed");
    assertMode(mode, behavior === "deny");
    savedSettings = {
      mode: current().mode,
      settings: Object.fromEntries(
        current().settings.map((setting) => [setting.id, setting.value]),
      ),
    };
    console.log(
      JSON.stringify({
        nativePlanResponse: behavior,
        editingMode: mode,
        result: "passed",
      }),
    );
    await close();
  }
  await connection.close();
  await connect();
  // Paseo restores editing mode and featureValues separately from the native
  // persistence handle. V4 must restore the native planEnabled state.
  await open(savedSettings, saved);
  assertMode("edit", true);
  assert.equal(current().model, defaultModel.id);
  assert.equal(current().thinkingOption, defaultModel.thinkingOptions[0].id);
  assert.ok(
    events.some(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  );
  assert.equal(
    events.some((e) => e.type === "session.turn"),
    false,
  );
  await close();
  console.log(
    JSON.stringify({ restoredPlanAndModel: "passed", cleanClose: "passed" }),
  );
} finally {
  removeSignalHandlers();
  await cleanup();
}
