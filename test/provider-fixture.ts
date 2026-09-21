import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderEvent,
  ProviderInput,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { createZCodeProvider, CAPABILITIES } from "../server/provider.js";
import { SessionPersistenceStore } from "../server/persistence.js";
import { FakeBridge, snapshot } from "./fake-host.js";
export async function providerFixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "zcode-v4-test-")));
  const host = new FakeBridge(snapshot(cwd));
  const store = new SessionPersistenceStore(join(cwd, "state"));
  const connection = await createZCodeProvider(async () => host, store).connect(
    { versions: [1], capabilities: CAPABILITIES },
  );
  const events: ProviderEvent[] = [];
  connection.onEvent((e) => events.push(e));
  const wait = async (predicate: (e: ProviderEvent) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const event = events.find(predicate);
      if (event) return event;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `Missing Provider event; ${events.map((e) => e.type).join(", ")}`,
    );
  };
  const config: ProviderSessionConfig = {
    cwd,
    persist: true,
    env: {},
    mcpServers: {},
    settings: {},
    providerOptions: {},
  };
  const send = (input: ProviderInput) => connection.send(input);
  const open = async (
    overrides: Partial<ProviderSessionConfig> = {},
    persistence?: any,
  ) => {
    await send({
      type: "session.open",
      sessionId: "public",
      requestId: "open",
      config: { ...config, ...overrides },
      history: "replay",
      ...(persistence ? { persistence } : {}),
    });
    return wait(
      (e) => e.type === "session.ready" || e.type === "request.failed",
    );
  };
  const prompt = async (id = "m1", text = "hello") => {
    await send({
      type: "session.prompt",
      sessionId: "public",
      prompt: {
        clientMessageId: id,
        input: { type: "message", content: [{ type: "text", text }] },
        delivery: "auto",
      },
    });
    return wait(
      (e) => e.type === "session.prompt_result" && e.clientMessageId === id,
    );
  };
  return {
    cwd,
    host,
    store,
    connection,
    events,
    wait,
    send,
    config,
    open,
    prompt,
    async close() {
      await connection.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
