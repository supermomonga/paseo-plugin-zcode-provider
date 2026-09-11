import { diagnosticError } from "../server/diagnostics.js";
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
  expect(f.connection.capabilities).toContain("prompt.steer");
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
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "steer",
      delivery: "steer",
      input: { type: "message", content: [{ type: "text", text: "steer" }] },
    },
  });
  expect((await f.wait("session.prompt_result")).result).toMatchObject({
    type: "failed",
    error: { code: "SESSION_BUSY" },
  });
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
    expect(
      host.calls.filter((c) => c.method === "sendConversationCommandV4"),
    ).toHaveLength(1);
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
      host.calls.find((c) => c.method === "sendConversationCommandV4")?.params,
    ).toMatchObject({
      envelope: {
        payload: {
          attachments: [
            {
              ref: expect.stringMatching(/^artifact:/),
              fileName: "image.png",
              mime: "image/png",
              bytes: 4,
            },
          ],
        },
      },
    }),
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
    expect(
      host.calls.filter((c) => c.method === "sendConversationCommandV4"),
    ).toHaveLength(2),
  );
  expect(
    host.calls.filter((c) => c.method === "sendConversationCommandV4")[1]!
      .params,
  ).toMatchObject({ envelope: { payload: { text: "/review src" } } });
});

it("accepts additions and rejects duplicate message IDs without losing the active turn", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await f.prompt("second");
  expect(
    f.events.findLast((e) => e.type === "session.prompt_result"),
  ).toMatchObject({
    clientMessageId: "second",
    result: { type: "steer", turnId: expect.any(String) },
  });
  await expect(f.prompt()).rejects.toThrow(/Duplicate/);
  expect(
    host.calls.filter((c) => c.method === "sendConversationCommandV4"),
  ).toHaveLength(2);
  const input = host.queueItems[0]!;
  await host.emit({
    type: "session.event",
    event: {
      type: "turn.started",
      eventId: "start",
      sessionId: "session-1",
      seq: 1,
      timestamp: 1,
      deliveryKind: "desktop-continuous",
      turnId: "native-1",
      payload: {
        inputId: (
          host.calls.find((c) => c.method === "sendConversationCommandV4")!
            .params as { envelope: { commandId: string } }
        ).envelope.commandId,
      },
    },
  });
  await host.emit({
    type: "session.event",
    event: {
      type: "turn.steerDrained",
      eventId: "drain",
      sessionId: "session-1",
      seq: 2,
      timestamp: 2,
      deliveryKind: "desktop-continuous",
      turnId: "native-1",
      payload: {
        pendingInputIds: [input.queueItemId],
        targetTurnId: "native-1",
      },
    },
  });
  host.queueItems = [];
  await completeTurn(host, 3);
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

it("times out an interrupt if native cancellation is never confirmed", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  host.confirmCancellation = false;
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
    expect(
      host.calls.filter((c) => c.method === "sendConversationCommandV4"),
    ).toHaveLength(2),
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
  expect(host.calls.some((c) => c.method === "sendConversationCommandV4")).toBe(
    false,
  );
  expect((await f.wait("session.prompt_result")).result.type).toBe("failed");
  await rm(f.store.directory);
  await f.prompt("retry");
  expect(
    host.calls.filter((c) => c.method === "sendConversationCommandV4"),
  ).toHaveLength(1);
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
    expect(
      host.calls.some((c) => c.method === "sendConversationCommandV4"),
    ).toBe(false);
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
    host.calls.find((c) => c.method === "sendConversationCommandV4")?.params,
  ).toMatchObject({ envelope: { payload: { text: "Design a greeting" } } });
  expect((await f.wait("session.config")).config).toMatchObject({
    mode: "yolo",
    settings: [{ value: true }],
  });
});

it("publishes reportable diagnostics when the native process fails", async () => {
  const f = await fixture();
  const host = await f.open();
  host.fail(
    diagnosticError(new AdapterError("NATIVE_EXITED", "secret-stderr"), {
      stage: "transport",
      check: "native-exit",
      exitCode: 1,
    }),
  );
  const event = await f.wait("session.runtime_failed");
  expect(JSON.parse(event.error.diagnostic!)).toMatchObject({
    appVersion: "3.11.2",
    cliVersion: "0.16.5",
    platform: "darwin-arm64",
    stage: "transport",
    check: "native-exit",
    exitCode: 1,
  });
  expect(JSON.stringify(event)).not.toContain("secret-stderr");
});

it("publishes diagnostics for incompatible events after successful startup", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await host.emit({
    type: "session.event",
    event: {
      eventId: "event-1",
      sessionId: "session-1",
      seq: 1,
      timestamp: 1,
      deliveryKind: "desktop-continuous",
      type: "secret-unknown",
      payload: {},
    },
  });
  const event = await f.wait("session.runtime_failed");
  expect(JSON.parse(event.error.diagnostic!)).toMatchObject({
    stage: "notification",
    check: "native-event",
    operation: "event",
    appVersion: "3.11.2",
  });
  expect(JSON.stringify(event)).not.toContain("secret-unknown");
});

function commandCalls(host: FakeBridge) {
  return host.calls
    .filter((c) => c.method === "sendConversationCommandV4")
    .map(
      (c) =>
        (
          c.params as {
            envelope: {
              type: string;
              commandId: string;
              payload: Record<string, unknown>;
            };
          }
        ).envelope,
    );
}
function nativeEvents(host: FakeBridge) {
  let seq = 0;
  return (
    type: string,
    payload: Record<string, unknown>,
    turnId = "native-1",
  ) =>
    host.emit({
      type: "session.event",
      event: {
        type,
        payload,
        turnId,
        eventId: `native-${++seq}`,
        seq,
        timestamp: seq,
        sessionId: "session-1",
        deliveryKind: "desktop-continuous",
      },
    });
}
async function attachmentPrompt(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
) {
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: id,
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: id },
          { type: "image", mimeType: "image/png", data: "dGVzdA==" },
        ],
      },
    },
  });
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) => e.type === "session.prompt_result" && e.clientMessageId === id,
      ),
    ).toBe(true),
  );
}

it("keeps one public turn through multiple queued native turns and separates their text", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  await f.prompt();
  await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
  await attachmentPrompt(f, "image-1");
  await attachmentPrompt(f, "image-2");
  const queued = [...host.queueItems];
  await event("model.streaming", { kind: "text_delta", delta: "first" });
  await event("turn.completed", { resultType: "success" });
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started"]);
  for (const [index, input] of queued.entries()) {
    const turnId = `native-${index + 2}`;
    host.conversationPhase = "running";
    await event("turn.started", { inputId: input.sourceCommandId }, turnId);
    host.queueItems = host.queueItems.filter((i) => i !== input);
    await host.emitConversation();
    await event(
      "model.streaming",
      { kind: "text_delta", delta: `queued-${index}` },
      turnId,
    );
    await event("turn.completed", { resultType: "success" }, turnId);
  }
  const turns = f.events.filter((e) => e.type === "session.turn");
  expect(turns.map((e) => e.state)).toEqual(["started", "completed"]);
  const results = f.events.filter((e) => e.type === "session.prompt_result");
  expect(results.map((e) => e.result)).toEqual([
    { type: "turn", turnId: turns[0]!.turnId },
    { type: "steer", turnId: turns[0]!.turnId },
    { type: "steer", turnId: turns[0]!.turnId },
  ]);
  const text = f.events.filter(
    (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
      e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(text.map((e) => e.item)).toMatchObject([
    { text: "first" },
    { text: "queued-0" },
    { text: "queued-1" },
  ]);
  expect(new Set(text.map((e) => e.item.id)).size).toBe(3);
  expect(
    host.calls.filter((c) => c.method === "getTaskTokenUsage"),
  ).toHaveLength(1);
  expect(commandCalls(host).map((c) => c.payload.requestedDelivery)).toEqual([
    "guide",
    "queue",
    "queue",
  ]);
  expect(
    f.events.filter(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  ).toHaveLength(3);
});

it("handles start, drain and terminal events before the send acknowledgement", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  const original = host.request.bind(host);
  let sends = 0;
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      const result = await original(method, params, schema);
      if (
        method === "sendConversationCommandV4" &&
        (params as { envelope: { type: string } }).envelope.type === "sendText"
      ) {
        sends++;
        if (sends === 1) {
          await event("turn.started", {
            inputId: commandCalls(host)[0]!.commandId,
          });
          await event("model.streaming", {
            kind: "text_delta",
            delta: "before-ack",
          });
        } else {
          await event("turn.steerDrained", {
            targetTurnId: "native-1",
            pendingInputIds: host.queueItems.map((i) => i.queueItemId),
          });
          host.queueItems = [];
          await event("turn.completed", { resultType: "success" });
          expect(
            f.events
              .filter((e) => e.type === "session.turn")
              .map((e) => e.state),
          ).toEqual(["started"]);
        }
      }
      return result;
    },
  );
  await f.prompt();
  await f.prompt("second");
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "completed"]);
  const initialResult = f.events.findIndex(
    (e) => e.type === "session.prompt_result",
  );
  const streamed = f.events.findIndex(
    (e) => e.type === "timeline.item" && e.item.type === "assistant_message",
  );
  expect(initialResult).toBeLessThan(streamed);
});

it.each(["accepted", "drained", "promoting"])(
  "stops active and queued input during %s and holds native auto drain",
  async (phase) => {
    const f = await fixture();
    const host = await f.open();
    const event = nativeEvents(host);
    await f.prompt();
    await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
    await f.prompt("guide");
    await attachmentPrompt(f, "queued");
    if (phase !== "accepted") {
      await event("turn.steerDrained", {
        targetTurnId: "native-1",
        pendingInputIds: [host.queueItems[0]!.queueItemId],
      });
      host.queueItems.shift();
      await host.emitConversation();
    }
    if (phase === "promoting") {
      await event("turn.completed", { resultType: "success" });
      const queued = host.queueItems[0]!;
      host.conversationPhase = "running";
      await event(
        "turn.started",
        { inputId: queued.sourceCommandId },
        "native-2",
      );
      host.queueItems = [];
      await host.emitConversation();
    }
    await f.connection.send({
      type: "session.interrupt",
      requestId: "stop",
      sessionId: "public-1",
    });
    await vi.waitFor(() =>
      expect(
        f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
      ).toEqual(["started", "canceled"]),
    );
    expect(host.queueItems).toEqual([]);
    expect(host.autoDrain).toBe(false);
    const hold = host.calls.findIndex(
      (c) =>
        c.method === "sendConversationCommandV4" &&
        (c.params as { envelope: { type: string } }).envelope.type ===
          "setAutoDrain",
    );
    const cancel = host.calls.findIndex((c) => c.method === "cancelGeneration");
    expect(hold).toBeLessThan(cancel);
    await f.prompt("explicit-new-run");
    expect(host.autoDrain).toBe(true);
  },
);

it("cancels admission waiting in the provider and an upload already in progress", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "attachmentBeginV4") {
        entered.resolve();
        await release.promise;
      }
      return original(method, params, schema);
    },
  );
  const upload = attachmentPrompt(f, "upload");
  await entered.promise;
  const waiting = f.prompt("waiting");
  await f.connection.send({
    type: "session.interrupt",
    sessionId: "public-1",
    requestId: "stop",
  });
  release.resolve();
  await upload;
  await waiting;
  await vi.waitFor(() =>
    expect(
      f.events.some((e) => e.type === "session.turn" && e.state === "canceled"),
    ).toBe(true),
  );
  expect(commandCalls(host).filter((c) => c.type === "sendText")).toHaveLength(
    1,
  );
  expect(
    host.calls.filter((c) => c.method === "attachmentAbortV4"),
  ).toHaveLength(1);
  expect(
    f.events
      .filter(
        (e): e is Extract<ProviderEvent, { type: "session.prompt_result" }> =>
          e.type === "session.prompt_result" &&
          e.clientMessageId !== "message-1",
      )
      .map((e) => e.result.type),
  ).toEqual(["failed", "failed"]);
});

it("does not retry rejected input or lose the active turn", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "sendConversationCommandV4") {
        const envelope = (
          params as { envelope: { type: string; commandId: string } }
        ).envelope;
        if (envelope.type === "sendText") {
          host.calls.push({ method, params });
          return schema.parse({
            commandId: envelope.commandId,
            status: "rejected",
            revisionAtDecision: 2,
          });
        }
      }
      return original(method, params, schema);
    },
  );
  await f.prompt("rejected");
  expect((await f.wait("session.prompt_result")).result).toMatchObject({
    type: "failed",
    error: { code: "NATIVE_INPUT_REJECTED" },
  });
  await completeTurn(host);
  expect(commandCalls(host).filter((c) => c.type === "sendText")).toHaveLength(
    2,
  );
  expect(
    f.events.filter(
      (e) => e.type === "timeline.item" && e.item.type === "user_message",
    ),
  ).toHaveLength(1);
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "completed"]);
});

it("fails uncertain admission without acknowledging success or resending", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      const result = await original(method, params, schema);
      if (method === "sendConversationCommandV4")
        throw new AdapterError("NATIVE_TIMEOUT", "Lost acknowledgement");
      return result;
    },
  );
  await f.prompt("uncertain");
  await f.wait("session.runtime_failed");
  expect(commandCalls(host).filter((c) => c.type === "sendText")).toHaveLength(
    2,
  );
  expect((await f.wait("session.prompt_result")).result.type).toBe("failed");
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "failed"]);
});

it.each(["", "   ", "/plan", "/review src"])(
  "rejects empty or command input during a turn: %j",
  async (text) => {
    const f = await fixture();
    const host = await f.open();
    await f.prompt();
    await f.connection.send({
      type: "session.prompt",
      sessionId: "public-1",
      prompt: {
        clientMessageId: "invalid",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    await vi.waitFor(() =>
      expect(
        f.events.find(
          (e) =>
            e.type === "session.prompt_result" &&
            e.clientMessageId === "invalid",
        ),
      ).toMatchObject({ result: { type: "failed" } }),
    );
    expect(commandCalls(host)).toHaveLength(1);
  },
);

it("ignores already cancelled native terminal events arriving after state confirmation", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  await f.prompt();
  await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
  await f.connection.send({
    type: "session.interrupt",
    sessionId: "public-1",
    requestId: "stop",
  });
  await vi.waitFor(() =>
    expect(
      f.events.some((e) => e.type === "session.turn" && e.state === "canceled"),
    ).toBe(true),
  );
  await event("turn.completed", { resultType: "cancelled" });
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "canceled"]);
});

it("stops and deletes pending input when a native turn fails", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  await f.prompt();
  await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
  await attachmentPrompt(f, "queued");
  await event("turn.failed", { error: { message: "failed" } });
  await vi.waitFor(() =>
    expect(
      f.events.some((e) => e.type === "session.turn" && e.state === "failed"),
    ).toBe(true),
  );
  expect(host.autoDrain).toBe(false);
  expect(host.queueItems).toEqual([]);
});

it("holds completion for input accepted by the provider at a native turn boundary", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  await f.prompt();
  await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
  const pending = f.prompt("boundary");
  await event("turn.completed", { resultType: "success" });
  await pending;
  expect((await f.wait("session.prompt_result")).result.type).toBe("steer");
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started"]);
  const command = commandCalls(host)
    .filter((c) => c.type === "sendText")
    .at(-1)!;
  host.conversationPhase = "running";
  await event("turn.started", { inputId: command.commandId }, "native-2");
  host.queueItems = [];
  await host.emitConversation();
  await event("turn.completed", { resultType: "success" }, "native-2");
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "completed"]);
});

it("reports completion failure without a second prompt result", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "getTaskTokenUsage")
        throw new AdapterError("NATIVE_TIMEOUT", "No usage response");
      const response = await original(method, params, schema);
      if (method === "sendConversationCommandV4")
        await event("turn.completed", { resultType: "success" });
      return response;
    },
  );
  await f.prompt();
  await f.wait("session.runtime_failed");
  expect(
    f.events.filter((e) => e.type === "session.prompt_result"),
  ).toHaveLength(1);
  expect((await f.wait("session.prompt_result")).result.type).toBe("turn");
});

it("accepts native deferred queue anchors before a native turn exists", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      const result = await original(method, params, schema);
      if (method === "sendConversationCommandV4") {
        const command = commandCalls(host).at(-1)!;
        if (command.type === "sendText") {
          await event(
            "turn.steerQueued",
            {
              inputId: command.commandId,
              pendingInputId: "pending",
              targetTurnId: "deferred",
            },
            "deferred",
          );
          await event(
            "turn.started",
            { inputId: command.commandId },
            "native-actual",
          );
          await event(
            "turn.completed",
            { resultType: "success" },
            "native-actual",
          );
        }
      }
      return result;
    },
  );
  await f.prompt();
  await vi.waitFor(() =>
    expect(
      f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
    ).toEqual(["started", "completed"]),
  );
  expect(f.events.some((e) => e.type === "session.runtime_failed")).toBe(false);
});

it("keeps pending permissions unresolved when steering is accepted", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await requestPlan(host, "permission");
  await f.prompt("guide");
  expect((await f.wait("session.prompt_result")).result.type).toBe("steer");
  expect(host.calls.some((c) => c.method === "respondPermission")).toBe(false);
  expect(f.events.some((e) => e.type === "session.permission_resolved")).toBe(
    false,
  );
  await f.connection.send({
    type: "session.prompt",
    sessionId: "public-1",
    prompt: {
      clientMessageId: "clear-permission",
      delivery: "steer",
      clearPendingPermissions: true,
      input: { type: "message", content: [{ type: "text", text: "approve" }] },
    },
  });
  await vi.waitFor(() =>
    expect(
      f.events.find(
        (e) =>
          e.type === "session.prompt_result" &&
          e.clientMessageId === "clear-permission",
      ),
    ).toMatchObject({
      result: { type: "failed", error: { code: "INTERACTION_UNSUPPORTED" } },
    }),
  );
  expect(commandCalls(host).filter((c) => c.type === "sendText")).toHaveLength(
    2,
  );
});

it("retries queue revision conflicts only after an explicit stale acknowledgement", async () => {
  const f = await fixture();
  const host = await f.open();
  await f.prompt();
  await attachmentPrompt(f, "queued");
  const original = host.request.bind(host);
  let stale = false;
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (
        method === "sendConversationCommandV4" &&
        !stale &&
        (params as { envelope: { type: string } }).envelope.type ===
          "setAutoDrain"
      ) {
        stale = true;
        host.calls.push({ method, params });
        return schema.parse({
          status: "stale",
          commandId: (params as { envelope: { commandId: string } }).envelope
            .commandId,
          revisionAtDecision: 90,
        });
      }
      return original(method, params, schema);
    },
  );
  await f.connection.send({
    type: "session.interrupt",
    sessionId: "public-1",
    requestId: "stop",
  });
  await vi.waitFor(() =>
    expect(
      f.events.some((e) => e.type === "session.turn" && e.state === "canceled"),
    ).toBe(true),
  );
  const holds = host.calls
    .filter((c) => c.method === "sendConversationCommandV4")
    .map(
      (c) =>
        (
          c.params as {
            envelope: { type: string; baseRevision: number; commandId: string };
          }
        ).envelope,
    )
    .filter((c) => c.type === "setAutoDrain");
  expect(holds).toHaveLength(2);
  expect(holds[1]!.baseRevision).toBe(90);
  expect(holds[1]!.commandId).not.toBe(holds[0]!.commandId);
  expect(commandCalls(host).filter((c) => c.type === "sendText")).toHaveLength(
    2,
  );
});

it("accepts steering while final usage is being read without completing the old native turn", async () => {
  const f = await fixture();
  const host = await f.open();
  const event = nativeEvents(host);
  await f.prompt();
  await event("turn.started", { inputId: commandCalls(host)[0]!.commandId });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = host.request.bind(host);
  let held = false;
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "getTaskTokenUsage" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return original(method, params, schema);
    },
  );
  const ending = event("turn.completed", { resultType: "success" });
  await entered.promise;
  await f.prompt("during-usage");
  expect((await f.wait("session.prompt_result")).result.type).toBe("steer");
  release.resolve();
  await ending;
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started"]);
  await event(
    "turn.started",
    { inputId: commandCalls(host).at(-1)!.commandId },
    "native-2",
  );
  await event("turn.completed", { resultType: "success" }, "native-2");
  expect(
    f.events.filter((e) => e.type === "session.turn").map((e) => e.state),
  ).toEqual(["started", "completed"]);
});
