import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createZCodeProvider, CAPABILITIES } from "../server/provider.js";
import { SessionPersistenceStore } from "../server/persistence.js";
import { AdapterError } from "../server/errors.js";
import { encodeModel } from "../server/mapping.js";
import type { DynamicEvent } from "../server/protocol/v1/host-schemas.js";
import { FakeBridge, snapshot, stateUpdate } from "./fake-host.js";

const model = (modelId: string, variant?: string) => ({
  ref: { providerId: "provider", modelId, ...(variant ? { variant } : {}) },
  label: modelId,
});
const a = model("model");
const b = model("other", "fast");
const c = model("third");
const idA = encodeModel(a.ref);
const idB = encodeModel(b.ref);
const idC = encodeModel(c.ref);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "zcode-models-")));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const initial = snapshot(cwd);
  initial.settings.mode.current = "build";
  const host = new FakeBridge(initial);
  // Deliberately leave both session and workspace settings with only model A.
  host.workspaceState.modelCatalog.available = [a, b];
  const connection = await createZCodeProvider(
    async () => host,
    new SessionPersistenceStore(join(cwd, "state")),
  ).connect({ versions: [1], capabilities: CAPABILITIES });
  cleanup.push(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config = { cwd, env: {}, settings: {}, mcpServers: {}, persist: true };
  async function wait(requestId: string) {
    const terminal = () =>
      events.findLast(
        (event) =>
          "requestId" in event &&
          event.requestId === requestId &&
          [
            "session.ready",
            "request.completed",
            "request.failed",
            "catalog",
          ].includes(event.type),
      );
    await vi.waitFor(() => expect(terminal()).toBeDefined());
    return terminal()!;
  }
  async function request(input: ProviderInput & { requestId: string }) {
    await connection.send(input);
    return wait(input.requestId);
  }
  async function open(selected?: string, resume = false) {
    return request({
      type: "session.open",
      sessionId: "public",
      requestId: "open",
      history: "replay",
      config: {
        ...config,
        ...(selected === undefined ? {} : { model: selected }),
      },
      ...(resume
        ? {
            persistence: {
              version: 2,
              data: { kind: "native", sessionId: "session-1", cwd },
            },
          }
        : {}),
    });
  }
  let sequence = 0;
  async function configure(
    changes: Extract<ProviderInput, { type: "session.configure" }>["changes"],
  ) {
    return request({
      type: "session.configure",
      sessionId: "public",
      requestId: `configure-${++sequence}`,
      changes,
    });
  }
  const current = () =>
    events.filter((e) => e.type === "session.config").at(-1)!.config;
  const setCalls = () =>
    host.calls.filter((call) => call.method === "setModel");
  return {
    cwd,
    host,
    connection,
    events,
    config,
    wait,
    request,
    open,
    configure,
    current,
    setCalls,
  };
}

it("lists the authoritative workspace catalog instead of workspace settings", async () => {
  const f = await fixture();
  const event = await f.request({
    type: "catalog",
    requestId: "catalog",
    cwd: f.cwd,
  });
  expect(event.type).toBe("catalog");
  if (event.type !== "catalog") throw new Error("Expected catalog");
  expect(event.catalog.models.map((m) => m.id)).toEqual([idA, idB]);
  expect(event.catalog.defaultModel).toBe(idA);
});

it.each([false, true])(
  "opens a non-default model after a narrowed snapshot (resume=%s)",
  async (resume) => {
    const f = await fixture();
    expect((await f.open(idB, resume)).type).toBe("session.ready");
    expect(f.current().model).toBe(idB);
    expect(f.current().models.map((m) => m.id)).toEqual([idA, idB]);
    expect(f.setCalls()).toHaveLength(1);
    expect(
      f.host.calls.some(
        (call) => call.method === (resume ? "resumeSession" : "createSession"),
      ),
    ).toBe(true);
    expect(
      f.host.calls.some(
        (call) => call.method === (resume ? "createSession" : "resumeSession"),
      ),
    ).toBe(false);
  },
);

it.each(["snapshot", "conversation.frame"] as const)(
  "opens independently of subscription ordering: %s first",
  async (first) => {
    const f = await fixture();
    const queued: DynamicEvent[] = [];
    let deliver!: (event: DynamicEvent) => void | Promise<void>;
    const subscribe = f.host.subscribe.bind(f.host);
    vi.spyOn(f.host, "subscribe").mockImplementation(
      async (target, handler) => {
        deliver = handler;
        return subscribe(target, (event) => {
          queued.push(event);
        });
      },
    );
    await f.connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "public",
      config: { ...f.config, model: idB },
      history: "replay",
    });
    await vi.waitFor(() => expect(queued).toHaveLength(2));
    expect(f.setCalls()).toHaveLength(0);
    await deliver(queued.find((event) => event.type === first)!);
    if (first === "snapshot") expect(f.setCalls()).toHaveLength(0);
    await deliver(queued.find((event) => event.type !== first)!);
    expect((await f.wait("open")).type).toBe("session.ready");
    expect(f.current().model).toBe(idB);
    expect(f.current().models.map((m) => m.id)).toEqual([idA, idB]);
  },
);

it.each([undefined, idA])(
  "preserves default selection: %s",
  async (selected) => {
    const f = await fixture();
    expect((await f.open(selected)).type).toBe("session.ready");
    expect(f.current().model).toBe(idA);
    expect(f.current().models.map((m) => m.id)).toEqual([idA, idB]);
    expect(f.setCalls()).toHaveLength(selected ? 1 : 0);
  },
);

it("retains candidates across A/B/A changes, reads, subscriptions, mode and thinking", async () => {
  const f = await fixture();
  await f.open();
  for (const selected of [idB, idA]) {
    expect((await f.configure({ model: selected })).type).toBe(
      "request.completed",
    );
    await f.host.emit({ type: "snapshot", snapshot: f.host.sessionSnapshot() });
    await f.host.emit(stateUpdate({ model: f.host.current.settings.model }));
    expect(
      (await f.configure({ mode: "edit", thinkingOption: "high" })).type,
    ).toBe("request.completed");
    expect(f.current()).toMatchObject({
      model: selected,
      mode: "edit",
      thinkingOption: "high",
    });
    expect(f.current().models.map((m) => m.id)).toEqual([idA, idB]);
    expect(f.current().thinkingOptions.map((o) => o.id)).toEqual(["high"]);
  }
  expect(f.setCalls()).toHaveLength(2);
  expect(
    f.host.calls.filter((call) => call.method === "readSession"),
  ).toHaveLength(2);
});

it("replaces catalog additions, equal-sized replacements and removals, including the current model", async () => {
  const f = await fixture();
  await f.open();
  f.host.workspaceState.modelCatalog.available = [a, b, c];
  expect((await f.configure({ model: idC })).type).toBe("request.completed");
  expect(f.current().models.map((m) => m.id)).toEqual([idA, idB, idC]);
  f.host.workspaceState.modelCatalog.available = [a, c];
  expect(await f.configure({ model: idB })).toMatchObject({
    type: "request.failed",
    error: { code: "INVALID_CONFIGURATION" },
  });
  expect(f.current().models.map((m) => m.id)).toEqual([idA, idC]);
  // Replace C with B without changing the count, while C is still selected.
  f.host.workspaceState.modelCatalog.available = [a, b];
  expect(await f.configure({ model: idC })).toMatchObject({
    type: "request.failed",
    error: { code: "INVALID_CONFIGURATION" },
  });
  expect(f.current().model).toBe(idC);
  expect(f.current().models.map((m) => m.id)).toEqual([idA, idB]);
  expect(f.current().thinkingOptions.map((o) => o.id)).toEqual(["high"]);
  expect(f.setCalls()).toHaveLength(1);
  expect((await f.configure({ model: idB })).type).toBe("request.completed");
  expect(f.current().model).toBe(idB);
  expect(f.setCalls()).toHaveLength(2);
});

it.each([
  "duplicate",
  "malformed",
  "missing",
  "workspace",
  "providers",
  "transport",
])(
  "rejects an unusable catalog without using cached candidates: %s",
  async (failure) => {
    const f = await fixture();
    await f.open();
    const catalog = f.host.workspaceState.modelCatalog;
    if (failure === "duplicate") catalog.available = [a, a];
    if (failure === "malformed") Object.assign(catalog, { available: [{}] });
    if (failure === "missing")
      Object.assign(f.host.workspaceState, { modelCatalog: undefined });
    if (failure === "workspace")
      f.host.workspaceState.workspace.workspacePath = "/different";
    if (failure === "providers") catalog.providers = [];
    if (failure === "transport")
      vi.spyOn(f.host, "request").mockRejectedValueOnce(
        new AdapterError("NATIVE_TIMEOUT", "catalog timed out"),
      );
    const result = await f.configure({ model: idA });
    expect(result.type).toBe("request.failed");
    if (failure === "duplicate")
      expect(result).toMatchObject({
        error: { code: "NATIVE_PROTOCOL_ERROR" },
      });
    if (failure === "providers")
      expect(result).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    expect(f.setCalls()).toHaveLength(0);
  },
);

it.each(["not-json", '["provider","",null]', null])(
  "rejects invalid IDs without reading the catalog: %s",
  async (selected) => {
    const f = await fixture();
    await f.open();
    const before = f.host.calls.length;
    expect(await f.configure({ model: selected })).toMatchObject({
      type: "request.failed",
      error: { code: "INVALID_CONFIGURATION" },
    });
    expect(f.host.calls).toHaveLength(before);
  },
);

it.each(["reject", "mismatch"])(
  "reports native model failure without retry: %s",
  async (failure) => {
    const f = await fixture();
    await f.open();
    const request = f.host.request.bind(f.host);
    let settingsCalls = 0;
    vi.spyOn(f.host, "request").mockImplementation(
      async (method, params, schema) => {
        if (method === "setModel") {
          settingsCalls++;
          if (failure === "reject")
            throw new AdapterError(
              "NATIVE_PROTOCOL_ERROR",
              "model unavailable",
            );
          return schema.parse(f.host.sessionSnapshot());
        }
        return request(method, params, schema);
      },
    );
    expect(await f.configure({ model: idB })).toMatchObject({
      type: "request.failed",
      error: { code: "NATIVE_PROTOCOL_ERROR" },
    });
    expect(settingsCalls).toBe(1);
  },
);

it("does not configure a session that closed during a catalog refresh", async () => {
  const f = await fixture();
  await f.open();
  const read = Promise.withResolvers<void>();
  const request = f.host.request.bind(f.host);
  let reading = false;
  vi.spyOn(f.host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "readWorkspaceState") {
        reading = true;
        await read.promise;
      }
      return request(method, params, schema);
    },
  );
  const configuring = f.configure({ model: idA });
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    await f.connection.send({
      type: "session.close",
      sessionId: "public",
      requestId: "close",
    });
    await vi.waitFor(() => expect(f.host.closed).toBe(true));
  } finally {
    read.resolve();
  }
  expect((await configuring).type).toBe("request.failed");
  expect(f.setCalls()).toHaveLength(0);
});
