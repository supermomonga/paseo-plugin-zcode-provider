import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Opt-in: submits real model requests and persists test conversations in ZCode.
// All tool work and provider mapping files are restricted to a temporary workspace.
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "zcode-steering-"));
let connection;
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
  const config = {
    cwd: directory,
    env: {},
    mcpServers: {},
    persist: true,
    settings: {},
    mode: "yolo",
    thinkingOption: "low",
  };
  let events = [];
  let listeners = new Set();
  const connect = async () => {
    events = [];
    listeners = new Set();
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
        reject(new Error("Native steering check timed out"));
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
          if (failure) reject(new Error(JSON.stringify(failure)));
          else resolveResult(result);
        }
      };
      listeners.add(check);
      check();
    });
  const open = async (persistence) => {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "test",
      config,
      history: "replay",
      ...(persistence ? { persistence } : {}),
    });
    await wait((e) => e.type === "session.ready");
    return events.find((e) => e.type === "session.opened").persistence;
  };
  const prompt = async (clientMessageId, text, attachment) => {
    await connection.send({
      type: "session.prompt",
      sessionId: "test",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text },
            ...(attachment ? [attachment] : []),
          ],
        },
      },
    });
    return (
      await wait(
        (e) =>
          e.type === "session.prompt_result" &&
          e.clientMessageId === clientMessageId,
      )
    ).result;
  };
  const path = join(directory, "input.txt");
  await writeFile(path, "QUEUE_ATTACHMENT_OK");
  const attachment = {
    type: "uploaded_file",
    id: "input",
    path,
    fileName: "input.txt",
    mimeType: "text/plain",
    size: 19,
  };
  await connect();
  const persistence = await open();
  const runningTool = (e) =>
    e.type === "timeline.item" &&
    e.item.type === "tool_call" &&
    e.item.name === "Bash" &&
    e.item.status === "running";
  const first = await prompt(
    "initial",
    "Integration test. Run a shell command that sleeps for 5 seconds, then answer INITIAL. Do not edit files.",
  );
  await wait(runningTool);
  assert.deepEqual(
    await prompt(
      "guide",
      "Additional instruction: answer STEERING_OK instead of INITIAL.",
    ),
    { type: "steer", turnId: first.turnId },
  );
  assert.deepEqual(
    await prompt(
      "attachment",
      "Read the attached text and output its content.",
      attachment,
    ),
    { type: "steer", turnId: first.turnId },
  );
  await wait((e) => e.type === "session.turn" && e.state === "completed");
  assert.deepEqual(
    events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ["started", "completed"],
  );
  const answers = events
    .filter(
      (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
    )
    .map((e) => e.item.text)
    .join("\n");
  assert.match(answers, /STEERING_OK/);
  assert.match(answers, /QUEUE_ATTACHMENT_OK/);
  console.log(
    JSON.stringify({
      nativeTextSteering: "passed",
      nativeAttachmentQueue: "passed",
      singleCompletion: "passed",
    }),
  );
  events = [];
  await prompt(
    "stop-run",
    "Integration test. Run a shell command that sleeps for 30 seconds. Do not edit files.",
  );
  await wait(runningTool);
  await prompt(
    "cancel-queue",
    "This queued request must be cancelled before execution. Output CANCELLED_QUEUE_EXECUTED if it runs.",
    attachment,
  );
  await connection.send({
    type: "session.interrupt",
    sessionId: "test",
    requestId: "stop",
  });
  await wait((e) => e.type === "session.turn" && e.state === "canceled");
  assert.deepEqual(
    events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ["started", "canceled"],
  );
  await connection.send({
    type: "session.close",
    sessionId: "test",
    requestId: "close",
  });
  await wait((e) => e.type === "session.closed");
  await connection.close();
  connection = undefined;
  await connect();
  await open(persistence);
  const history = events.filter(
    (e) => e.type === "timeline.item" && e.item.type === "user_message",
  );
  const texts = history.map((e) => e.item.text);
  assert.equal(texts.length, 4, "one restored user entry per consumed input");
  assert.equal(
    texts.filter((text) => text.includes("Additional instruction:")).length,
    1,
  );
  assert.equal(
    texts.filter((text) => text.includes("Read the attached text")).length,
    1,
  );
  assert.equal(
    texts.filter((text) =>
      text.includes("This queued request must be cancelled"),
    ).length,
    0,
  );
  assert.equal(events.filter((e) => e.type === "session.turn").length, 0);
  const after = await prompt(
    "after-resume",
    "Answer RESUMED_OK. Do not use tools.",
  );
  await wait(
    (e) =>
      e.type === "session.turn" &&
      e.state === "completed" &&
      e.turnId === after.turnId,
  );
  const restoredAnswers = events
    .filter(
      (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
    )
    .map((e) => e.item.text)
    .join("\n");
  assert.match(restoredAnswers, /RESUMED_OK/);
  assert.doesNotMatch(restoredAnswers, /CANCELLED_QUEUE_EXECUTED/);
  await connection.send({
    type: "session.close",
    sessionId: "test",
    requestId: "final-close",
  });
  await wait((e) => e.type === "session.closed");
  console.log(
    JSON.stringify({
      nativeStop: "passed",
      nativeResume: "passed",
      noCancelledReplay: "passed",
      historyUserEntries: texts.length,
      cleanClose: "passed",
    }),
  );
} finally {
  await connection?.close();
  await rm(directory, { recursive: true, force: true });
}
