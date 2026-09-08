import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPersistenceStore } from "../server/persistence.js";
import { AdapterError } from "../server/errors.js";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderEvent,
  type ProviderInput,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import {
  createZCodeProvider,
  type ZCodeConnection,
} from "../server/provider.js";
import {
  FakeBridge,
  snapshot,
  completeTurn,
  requestPlan,
  modeEvent,
} from "./fake-host.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it("closes native generation when a permission response is invalid", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await requestPlan(host, "permission");
  const request = (await f.wait("session.permission")).request;
  await f.connection.send({
    type: "session.permission",
    sessionId: "public-1",
    permissionId: request.id,
    response: { behavior: "allow", selectedActionId: "unknown" },
  });
  await f.wait("session.runtime_failed");
  expect(
    host.calls.filter((c) => c.method === "respondPermission"),
  ).toMatchObject([{ params: { optionId: "dismiss" } }]);
  await vi.waitFor(() => expect(host.closed).toBe(true));
});

it("closes native generation when the stop RPC fails", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  vi.spyOn(host, "request").mockRejectedValueOnce(
    new AdapterError("NATIVE_PROTOCOL_ERROR", "stop rejected"),
  );
  await f.connection.send({
    type: "session.interrupt",
    requestId: "stop-failed",
    sessionId: "public-1",
  });
  expect(await f.wait("request.failed")).toMatchObject({
    requestId: "stop-failed",
    error: { code: "NATIVE_PROTOCOL_ERROR" },
  });
  await f.wait("session.runtime_failed");
  expect(host.closed).toBe(true);
});

async function fixture() {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-plugin-test-")),
  );
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const hosts: FakeBridge[] = [];
  const environments: Readonly<Record<string, string>>[] = [];
  const store = new SessionPersistenceStore(join(cwd, "provider-state"));
  const registration = createZCodeProvider(async (env) => {
    environments.push(env);
    const host = new FakeBridge(snapshot(cwd));
    hosts.push(host);
    return host;
  }, store);
  const connection = (await registration.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
  })) as ZCodeConnection;
  cleanup.push(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  async function wait<T extends ProviderEvent["type"]>(type: T) {
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === type)).toBe(true),
    );
    return events.findLast((event) => event.type === type) as Extract<
      ProviderEvent,
      { type: T }
    >;
  }
  const config: ProviderSessionConfig = {
    cwd,
    env: {},
    settings: {},
    mcpServers: {},
    persist: true,
  };
  async function open(
    changes: Partial<ProviderSessionConfig> = {},
    extra: Partial<Extract<ProviderInput, { type: "session.open" }>> = {},
  ) {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "public-1",
      config: { ...config, ...changes },
      history: "replay",
      ...extra,
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "session.ready" || event.type === "request.failed",
        ),
      ).toBe(true),
    );
    expect(events.filter((event) => event.type === "request.failed")).toEqual(
      [],
    );
    await wait("session.ready");
    return hosts[hosts.length - 1]!;
  }
  async function prompt(id = "message-1") {
    await connection.send({
      type: "session.prompt",
      sessionId: "public-1",
      prompt: {
        clientMessageId: id,
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Plan and implement" }],
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === id,
        ),
      ).toBe(true),
    );
  }
  return {
    cwd,
    store,
    config,
    connection,
    registration,
    hosts,
    environments,
    events,
    wait,
    open,
    prompt,
  };
}

it("negotiates only implemented capabilities and rejects unsupported inputs", async () => {
  const f = await fixture();
  expect(f.connection.capabilities).not.toContain("prompt.steer");
  await expect(
    f.registration.connect({ versions: [2], capabilities: [] }),
  ).rejects.toThrow(/version 1/);
  await expect(
    f.connection.send({
      type: "session.archive",
      requestId: "archive",
      persistence: { version: 1, data: {} },
    }),
  ).rejects.toThrow();
  await f.open();
  await expect(
    f.connection.send({
      type: "session.prompt",
      sessionId: "public-1",
      prompt: {
        clientMessageId: "steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "steer" }] },
      },
    }),
  ).rejects.toThrow();
});

it("discovers workspace models and native sessions and closes discovery hosts", async () => {
  const f = await fixture();
  await f.connection.send({
    type: "catalog",
    requestId: "catalog",
    cwd: f.cwd,
  });
  const catalog = await f.wait("catalog");
  expect(catalog.catalog).toMatchObject({
    defaultMode: "build",
    models: [
      { id: '["provider","model",null]', thinkingOptions: [{ id: "high" }] },
    ],
  });
  await vi.waitFor(() => expect(f.hosts[0]!.closed).toBe(true));
  await f.connection.send({
    type: "sessions",
    requestId: "sessions",
    cwd: f.cwd,
    query: "Sess",
    limit: 1,
  });
  expect((await f.wait("sessions")).sessions).toMatchObject([
    {
      title: "Session",
      persistence: {
        version: 2,
        data: { kind: "native", sessionId: "session-1", cwd: f.cwd },
      },
    },
  ]);
  await vi.waitFor(() => expect(f.hosts[1]!.closed).toBe(true));
});

it("opens with environment and MCP, sets model before modes, and returns persistence", async () => {
  const f = await fixture();
  const host = await f.open({
    env: { ZCODE_TEST: "one" },
    model: '["provider","model",null]',
    thinkingOption: "high",
    mode: "edit",
    settings: { plan_mode: true },
    mcpServers: { test: { type: "stdio", command: "/usr/bin/test-server" } },
  });
  expect(f.environments).toEqual([{ ZCODE_TEST: "one" }]);
  expect(
    host.calls.find((c) => c.method === "createSession")?.params,
  ).toMatchObject({
    persistence: "deferred",
    mcpServers: [{ name: "test", command: "/usr/bin/test-server" }],
  });
  expect(
    host.calls
      .filter((c) =>
        ["setModel", "setThoughtLevel", "setMode"].includes(c.method),
      )
      .map((c) => [c.method, (c.params as { mode?: string }).mode]),
  ).toEqual([
    ["setModel", undefined],
    ["setThoughtLevel", undefined],
    ["setMode", "edit"],
    ["setMode", "plan"],
  ]);
  expect((await f.wait("session.opened")).persistence).toEqual({
    version: 2,
    data: { kind: "logical", id: expect.any(String), cwd: f.cwd },
  });
  expect((await f.wait("session.commands")).commands).toEqual([
    {
      name: "plan",
      description: "Switch to Plan mode",
      argumentHint: "[task]",
    },
    { name: "review", description: "Review", argumentHint: "<path>" },
  ]);
});

it.each(["permission", "question"] as const)(
  "answers native %s plan exactly once and follows its mode change",
  async (source) => {
    const f = await fixture();
    const host = await f.open({
      mode: "edit",
      settings: { plan_mode: true },
    });
    await f.prompt();
    await requestPlan(host, source);
    const permission = (await f.wait("session.permission")).request;
    expect(permission).toMatchObject({
      kind: "plan",
      input: { plan: "# Plan" },
    });
    await f.connection.send({
      type: "session.permission",
      sessionId: "public-1",
      permissionId: permission.id,
      response: { behavior: "allow", selectedActionId: "approve" },
    });
    await f.wait("session.permission_resolved");
    await host.emit(modeEvent("edit", "plan", 1));
    expect((await f.wait("session.config")).config.mode).toBe("edit");
    const responseMethod =
      source === "permission" ? "respondPermission" : "respondStructuredInput";
    expect(host.calls.filter((c) => c.method === responseMethod)).toHaveLength(
      1,
    );
    expect(host.calls.filter((c) => c.method === "sendPrompt")).toHaveLength(1);
    expect(host.calls.filter((c) => c.method === "setMode")).toHaveLength(2);
    await completeTurn(host, 2);
    expect(
      f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "completed"]);
  },
);

it("streams replacement snapshots and reports token usage at turn completion", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
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
  const messages = f.events.filter(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(messages.map((e) => e.item)).toEqual([
    {
      type: "assistant_message",
      id: expect.any(String),
      text: "hel",
      messageId: "assistant-1",
    },
    {
      type: "assistant_message",
      id: expect.any(String),
      text: "hello",
      messageId: "assistant-1",
    },
  ]);
  expect(messages[0]!.item.id).toBe(messages[1]!.item.id);
  await completeTurn(host, 3);
  expect((await f.wait("session.usage")).usage).toMatchObject({
    inputTokens: 5,
    outputTokens: 7,
  });
});

it("passes uploaded files and native slash commands", async () => {
  const f = await fixture();
  const host = await f.open();
  const path = join(f.cwd, "image.png");
  await writeFile(path, "test");
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "image",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "Inspect" },
          {
            type: "uploaded_file",
            id: "file-1",
            path,
            fileName: "image.png",
            mimeType: "image/png",
            size: 4,
          },
        ],
      },
    },
  });
  await f.wait("session.prompt_result");
  await vi.waitFor(() =>
    expect(
      host.calls.find((c) => c.method === "sendPrompt")?.params,
    ).toMatchObject({ attachments: [{ localPath: path, kind: "image" }] }),
  );
  await completeTurn(host);
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "command",
      delivery: "auto",
      input: { type: "command", name: "review", arguments: "src" },
    },
  });
  await vi.waitFor(() =>
    expect(host.calls.filter((c) => c.method === "sendPrompt")).toHaveLength(2),
  );
  expect(
    host.calls.filter((c) => c.method === "sendPrompt")[1]!.params,
  ).toMatchObject({ content: "/review src" });
});

it("rejects simultaneous turns and duplicate message IDs without losing the active turn", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await f.prompt("second");
  expect(
    f.events.findLast((e) => e.type === "session.prompt_result"),
  ).toMatchObject({
    clientMessageId: "second",
    result: { type: "failed", error: { code: "SESSION_BUSY" } },
  });
  await expect(f.prompt()).rejects.toThrow(/Duplicate/);
  expect(host.calls.filter((c) => c.method === "sendPrompt")).toHaveLength(1);
  await completeTurn(host);
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "completed"]);
});

it("resumes only matching workspace persistence and replays native history", async () => {
  const f = await fixture();
  const first = await f.open();
  await f.prompt();
  await completeTurn(first);
  const persistence = (await f.wait("session.opened")).persistence!;
  await f.connection.send({
    type: "session.close",
    requestId: "close",
    sessionId: "public-1",
  });
  await f.wait("session.closed");
  expect(first.closed).toBe(true);
  f.events.length = 0;
  const host = await f.open({}, { persistence });
  expect(host.calls.some((c) => c.method === "resumeSession")).toBe(true);
  expect(host.calls.some((c) => c.method === "createSession")).toBe(false);
  expect(
    f.events.some(
      (e) => e.type === "timeline.item" && e.item.id.startsWith("history:"),
    ),
  ).toBe(true);
  await f.connection.send({
    type: "session.open",
    requestId: "bad-workspace",
    sessionId: "bad",
    config: f.config,
    history: "replay",
    persistence: {
      version: 2,
      data: { kind: "native", sessionId: "session-1", cwd: "/another" },
    },
  });
  expect(await f.wait("request.failed")).toMatchObject({
    requestId: "bad-workspace",
  });
  expect(f.hosts).toHaveLength(2);
});

it.each([
  { systemPrompt: "custom" },
  { persist: false },
  { providerOptions: { unknown: true } },
  { settings: { unsupported: true } },
])("rejects unsupported config %j before starting a host", async (changes) => {
  const f = await fixture();
  await f.connection.send({
    type: "session.open",
    requestId: "bad",
    sessionId: "bad",
    config: { ...f.config, ...changes },
    history: "replay",
  });
  expect(await f.wait("request.failed")).toMatchObject({
    error: { code: "INVALID_CONFIGURATION" },
  });
  expect(f.hosts).toHaveLength(0);
});

it("terminates the active turn and closes the host once on disconnection", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  host.fail();
  host.fail();
  await f.wait("session.runtime_failed");
  await vi.waitFor(() => expect(host.closed).toBe(true));
  expect(
    f.events.filter((e) => e.type === "session.runtime_failed"),
  ).toHaveLength(1);
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "failed"]);
});

it("interrupts a pending plan and waits for native cancellation", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await requestPlan(host, "question");
  await f.connection.send({
    type: "session.interrupt",
    requestId: "stop",
    sessionId: "public-1",
  });
  await vi.waitFor(() =>
    expect(host.calls.some((c) => c.method === "cancelGeneration")).toBe(true),
  );
  expect(
    host.calls.find((c) => c.method === "respondStructuredInput")?.params,
  ).toMatchObject({ response: { action: "cancel" } });
  await completeTurn(host);
  expect(await f.wait("request.completed")).toMatchObject({
    requestId: "stop",
  });
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "canceled"]);
});

it("closes a running connection without waiting forever for a native terminal event", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await f.connection.close();
  await f.connection.close();
  expect(host.closed).toBe(true);
  await expect(
    f.connection.send({ type: "catalog", requestId: "late" }),
  ).rejects.toThrow(/closed/);
});

it("publishes tool replacements, questions, and context usage without duplicating entries", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  for (const [index, payload] of [
    {
      kind: "started",
      toolCallId: "read",
      toolName: "Read",
      input: { file: "a.txt" },
    },
    { kind: "result", toolCallId: "read", result: "contents" },
  ].entries())
    await host.emit({
      type: "session.event",
      event: {
        type: "tool.updated",
        eventId: `tool-${index}`,
        sessionId: "session-1",
        seq: index + 1,
        timestamp: 1,
        deliveryKind: "desktop-continuous",
        payload,
      },
    });
  const tools = f.events.filter(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" && e.item.type === "tool_call",
  );
  expect(tools.map((e) => e.item)).toMatchObject([
    { id: "tool:read", status: "running" },
    {
      id: "tool:read",
      status: "completed",
      detail: { input: { file: "a.txt" }, output: "contents" },
    },
  ]);
  await host.emit({
    type: "userInput.request",
    request: {
      requestId: "choose",
      sessionId: "session-1",
      questions: [
        {
          question: "Which?",
          header: "Choice",
          options: [{ value: "fast", label: "Fast" }],
        },
      ],
    },
  });
  const request = (await f.wait("session.permission")).request;
  expect(request.kind).toBe("question");
  await f.connection.send({
    type: "session.permission",
    sessionId: "public-1",
    permissionId: request.id,
    response: {
      behavior: "allow",
      updatedInput: { answers: { Choice: "Fast" } },
    },
  });
  await f.wait("session.permission_resolved");
  expect(
    host.calls.find((c) => c.method === "respondStructuredInput")?.params,
  ).toMatchObject({
    requestId: "choose",
    response: { action: "accept", content: { answer: "fast" } },
  });
  host.current.runtime.contextUsage = { used: 30, size: 100 };
  await host.emit({
    type: "snapshot",
    snapshot: structuredClone(host.current),
  });
  expect((await f.wait("session.usage")).usage).toEqual({
    contextWindowUsedTokens: 30,
    contextWindowMaxTokens: 100,
  });
});

it("treats invalid native events as a terminal failure even outside a turn", async () => {
  const f = await fixture();
  const host = await f.open();
  await host.emit({
    type: "session.event",
    event: {
      type: "turn.failed",
      sessionId: "wrong-session",
      eventId: "wrong",
      seq: 1,
      timestamp: 1,
      deliveryKind: "desktop-continuous",
      payload: {},
    },
  });
  expect(await f.wait("session.runtime_failed")).toMatchObject({
    error: { code: "NATIVE_PROTOCOL_ERROR" },
  });
  await vi.waitFor(() => expect(host.closed).toBe(true));
});

it("times out an interrupt if the native terminal event never arrives", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  vi.useFakeTimers();
  await f.connection.send({
    type: "session.interrupt",
    requestId: "timeout",
    sessionId: "public-1",
  });
  await vi.advanceTimersByTimeAsync(30_001);
  expect(f.events.find((e) => e.type === "request.failed")).toMatchObject({
    requestId: "timeout",
    error: { code: "NATIVE_TIMEOUT" },
  });
  expect(
    f.events.find((e) => e.type === "session.runtime_failed"),
  ).toMatchObject({ error: { code: "NATIVE_TIMEOUT" } });
  expect(host.closed).toBe(true);
});

async function configure(
  f: Awaited<ReturnType<typeof fixture>>,
  changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
  requestId = "configure",
) {
  await f.connection.send({
    type: "session.configure",
    sessionId: "public-1",
    requestId,
    changes,
  });
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) =>
          (e.type === "request.completed" || e.type === "request.failed") &&
          e.requestId === requestId,
      ),
    ).toBe(true),
  );
}

it.each(["build", "edit", "yolo"])(
  "keeps %s independent of planning and publishes only final transitions",
  async (mode) => {
    const f = await fixture();
    const host = await f.open({ mode, settings: { plan_mode: true } });
    host.emitModeOnSet = true;
    const config = () =>
      f.events.filter((e) => e.type === "session.config").at(-1)!.config;
    expect(config()).toMatchObject({
      mode,
      modes: [{ id: "build" }, { id: "edit" }, { id: "yolo" }],
      settings: [{ id: "plan_mode", value: true, label: "Toggle plan mode" }],
    });
    f.events.length = 0;
    const next = mode === "edit" ? "yolo" : "edit";
    await configure(f, { mode: next });
    expect(
      f.events
        .filter((e) => e.type === "session.config")
        .every(
          (e) => e.config.mode === next && e.config.settings[0]?.value === true,
        ),
    ).toBe(true);
    expect(
      host.calls
        .filter((c) => c.method === "setMode")
        .slice(-2)
        .map((c) => (c.params as { mode: string }).mode),
    ).toEqual([next, "plan"]);
    await configure(f, { settings: { plan_mode: false } }, "off");
    expect(config()).toMatchObject({
      mode: next,
      settings: [{ value: false }],
    });
    await configure(f, { settings: { plan_mode: true } }, "on");
    await f.prompt();
    await requestPlan(host, "permission");
    const request = (await f.wait("session.permission")).request;
    await f.connection.send({
      type: "session.permission",
      sessionId: "public-1",
      permissionId: request.id,
      response: { behavior: "allow", selectedActionId: "approve" },
    });
    await f.wait("session.permission_resolved");
    await host.emit(modeEvent(next, "plan", 1));
    expect(config()).toMatchObject({
      mode: next,
      settings: [{ value: false }],
    });
    await completeTurn(host, 2);
  },
);

it("tracks command mode changes and retains planning on rejection", async () => {
  const f = await fixture();
  const host = await f.open({ mode: "yolo" });
  const event = modeEvent("plan", "yolo", 1);
  if (event.type === "session.event") event.event.payload.source = "command";
  await host.emit(event);
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: true }],
  });
  await f.prompt();
  await requestPlan(host, "permission");
  const request = (await f.wait("session.permission")).request;
  await f.connection.send({
    type: "session.permission",
    sessionId: "public-1",
    permissionId: request.id,
    response: { behavior: "deny", selectedActionId: "dismiss" },
  });
  await f.wait("session.permission_resolved");
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: true }],
  });
  await completeTurn(host, 2);
  const modeCalls = host.calls.filter((c) => c.method === "setMode").length;
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "revision",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "Revise the plan; do not implement it." },
        ],
      },
    },
  });
  await vi.waitFor(() =>
    expect(host.calls.filter((c) => c.method === "sendPrompt")).toHaveLength(2),
  );
  expect(host.calls.filter((c) => c.method === "setMode")).toHaveLength(
    modeCalls,
  );
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: true }],
  });
});

it("serializes successive editing and plan changes", async () => {
  const f = await fixture();
  await f.open({ mode: "build" });
  await Promise.all([
    configure(f, { settings: { plan_mode: true } }, "one"),
    configure(f, { mode: "yolo" }, "two"),
    configure(f, { settings: { plan_mode: false } }, "three"),
  ]);
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: false }],
  });
});

it("reopens unsent handles without writing state and preserves supplied draft settings", async () => {
  const f = await fixture();
  await f.open({ mode: "edit", settings: { plan_mode: true } });
  const persistence = (await f.wait("session.opened")).persistence!;
  const { readFile } = await import("node:fs/promises");
  await expect(readFile(f.store.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await f.connection.send({
    type: "session.close",
    sessionId: "public-1",
    requestId: "close",
  });
  await f.wait("session.closed");
  f.events.length = 0;
  const host = await f.open(
    { mode: "edit", settings: { plan_mode: true } },
    { persistence },
  );
  expect(host.calls.some((c) => c.method === "resumeSession")).toBe(false);
  expect((await f.wait("session.opened")).persistence).toEqual(persistence);
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "edit",
    settings: [{ value: true }],
  });
});

it("does not send when state cannot be saved and permits a corrected retry", async () => {
  const f = await fixture();
  const host = await f.open();
  await writeFile(f.store.directory, "not a directory");
  await f.prompt();
  expect(host.calls.some((c) => c.method === "sendPrompt")).toBe(false);
  expect((await f.wait("session.prompt_result")).result.type).toBe("failed");
  await rm(f.store.directory);
  await f.prompt("retry");
  expect(host.calls.filter((c) => c.method === "sendPrompt")).toHaveLength(1);
});

it("rejects legacy handles, removed options, and non-boolean plan settings", async () => {
  for (const changes of [
    { mode: "plan" },
    { providerOptions: { planReturnMode: "edit" } },
    { settings: { plan_mode: "true" } },
  ]) {
    const f = await fixture();
    await f.connection.send({
      type: "session.open",
      sessionId: "bad",
      requestId: "bad",
      config: { ...f.config, ...changes },
      history: "skip",
    });
    await f.wait("request.failed");
    expect(f.hosts).toHaveLength(0);
  }
  const f = await fixture();
  await f.connection.send({
    type: "session.open",
    sessionId: "bad",
    requestId: "bad",
    config: f.config,
    history: "skip",
    persistence: { version: 1, data: { sessionId: "session-1", cwd: f.cwd } },
  });
  await f.wait("request.failed");
  expect(f.hosts).toHaveLength(0);
});

it("fails the runtime after a partial native mode transition", async () => {
  const f = await fixture();
  const host = await f.open({ mode: "build", settings: { plan_mode: true } });
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "setMode" && (params as { mode: string }).mode === "plan")
        throw new AdapterError("NATIVE_PROTOCOL_ERROR", "set mode failed");
      return original(method, params, schema);
    },
  );
  f.events.length = 0;
  await configure(f, { mode: "edit" });
  await f.wait("session.runtime_failed");
  expect(f.events.some((e) => e.type === "session.config")).toBe(false);
});

it("imports native handles without creating another conversation", async () => {
  const f = await fixture();
  const host = await f.open(
    {},
    {
      persistence: {
        version: 2,
        data: { kind: "native", sessionId: "session-1", cwd: f.cwd },
      },
    },
  );
  expect(host.calls.some((c) => c.method === "resumeSession")).toBe(true);
  expect(host.calls.some((c) => c.method === "createSession")).toBe(false);
  expect((await f.wait("session.opened")).persistence).toEqual({
    version: 2,
    data: { kind: "native", sessionId: "session-1", cwd: f.cwd },
  });
});

it("does not replace a missing native conversation with a new session", async () => {
  const f = await fixture();
  // The returned session ID deliberately differs from the requested native ID.
  await f.connection.send({
    type: "session.open",
    sessionId: "bad",
    requestId: "missing",
    config: f.config,
    history: "skip",
    persistence: {
      version: 2,
      data: { kind: "native", sessionId: "missing", cwd: f.cwd },
    },
  });
  await f.wait("request.failed");
  expect(f.hosts[0]!.calls.some((c) => c.method === "createSession")).toBe(
    false,
  );
  expect(f.events.some((e) => e.type === "session.opened")).toBe(false);
});

it("rejects a corrupt logical mapping before starting the host", async () => {
  const f = await fixture();
  const { randomUUID } = await import("node:crypto");
  const { mkdir } = await import("node:fs/promises");
  const id = randomUUID();
  await mkdir(f.store.directory);
  await writeFile(join(f.store.directory, `${id}.json`), "broken");
  await f.connection.send({
    type: "session.open",
    sessionId: "bad",
    requestId: "corrupt",
    config: f.config,
    history: "skip",
    persistence: { version: 2, data: { kind: "logical", id, cwd: f.cwd } },
  });
  await f.wait("request.failed");
  expect(f.hosts).toHaveLength(0);
});

it.each(["command", "message"])(
  "executes bare /plan from %s without model input or a saved mapping",
  async (type) => {
    const f = await fixture();
    const host = await f.open({ mode: "edit" });
    await f.connection.send({
      type: "session.prompt",
      sessionId: "public-1",
      prompt: {
        clientMessageId: "plan-command",
        delivery: "auto",
        input:
          type === "command"
            ? { type: "command", name: "plan", arguments: "" }
            : { type: "message", content: [{ type: "text", text: "/plan" }] },
      },
    });
    await f.wait("session.prompt_result");
    expect((await f.wait("session.prompt_result")).result).toEqual({
      type: "completed",
    });
    expect((await f.wait("session.config")).config).toMatchObject({
      mode: "edit",
      settings: [{ value: true }],
    });
    expect(host.calls.some((c) => c.method === "sendPrompt")).toBe(false);
    const { stat } = await import("node:fs/promises");
    await expect(stat(f.store.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("enters planning before sending the /plan task alone", async () => {
  const f = await fixture();
  const host = await f.open({ mode: "yolo" });
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "plan-task",
      delivery: "auto",
      input: { type: "command", name: "plan", arguments: "Design a greeting" },
    },
  });
  await f.wait("session.prompt_result");
  expect(
    host.calls.find((c) => c.method === "sendPrompt")?.params,
  ).toMatchObject({ content: "Design a greeting" });
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: true }],
  });
});
