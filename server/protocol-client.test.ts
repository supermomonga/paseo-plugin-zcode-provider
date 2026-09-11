import { formatDiagnostic } from "./diagnostics.js";
import { AdapterError } from "./errors.js";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Logger } from "./logger.js";
import {
  MAX_PENDING_NATIVE_REQUESTS,
  MAX_QUEUED_NATIVE_NOTIFICATIONS,
  ZCodeProtocolClient,
  type NativeTransport,
} from "./protocol/client.js";

describe("ZCode private protocol client", () => {
  test("request deadline and close release callers even when stdin is backpressured", async () => {
    const harness = transportHarness();
    const stalled = {
      ...harness.transport,
      write: () => new Promise<void>(() => {}),
    };
    const client = new ZCodeProtocolClient(stalled, new CaptureLogger());
    await expect(
      client.request("blocked", {}, z.unknown(), 5),
    ).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    const pending = client.request("blocked-again", {}, z.unknown());
    const assertion = expect(pending).rejects.toMatchObject({
      code: "NATIVE_EXITED",
    });
    await client.close();
    await assertion;
  });
  test("correlates requests and validates results", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(
      harness.transport,
      new CaptureLogger(),
    );

    const response = client.request(
      "workspace/readState",
      { workspace: "test" },
      z.object({ value: z.literal("ok") }).strict(),
    );
    await sleep(0);
    expect(harness.writes).toEqual([
      '{"id":1,"method":"workspace/readState","params":{"workspace":"test"}}\n',
    ]);

    await harness.send({ id: 1, result: { value: "ok" } });
    await expect(response).resolves.toEqual({ value: "ok" });
    await client.close();
  });

  test("times out and ignores a late response", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(
      harness.transport,
      new CaptureLogger(),
    );
    const response = client.request("slow", {}, z.object({}).strict(), 5);

    await expect(response).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    await harness.send({ id: 1, result: {} });
    await client.close();
  });

  test("fails closed on an unsupported reverse request", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(
      harness.transport,
      new CaptureLogger(),
    );
    const pending = client.request("session/send", {}, z.object({}).strict());
    await harness.send({ id: 42, method: "interaction/unknown", params: {} });

    await expect(pending).rejects.toMatchObject({
      code: "NATIVE_PROTOCOL_ERROR",
    });
  });

  test("keeps reading while an ordered notification handler performs a nested request", async () => {
    const harness = transportHarness();
    const handled = Promise.withResolvers<void>();
    let client!: ZCodeProtocolClient;
    client = new ZCodeProtocolClient(
      harness.transport,
      new CaptureLogger(),
      undefined,
      async () => {
        await client.request(
          "session/read",
          {},
          z.object({ ok: z.literal(true) }).strict(),
        );
        handled.resolve();
      },
    );
    client.start();

    await harness.send({ method: "event", params: {} });
    await sleep(0);
    expect(harness.writes).toEqual([
      '{"id":1,"method":"session/read","params":{}}\n',
    ]);
    await harness.send({ id: 1, result: { ok: true } });
    await handled.promise;
    await client.close();
  });

  test("records native stdio write timing without logging request contents", async () => {
    const harness = transportHarness();
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const logger = new CaptureLogger();
    const transport: NativeTransport = {
      readable: harness.transport.readable,
      async write(frame) {
        writeStarted.resolve();
        await releaseWrite.promise;
        harness.writes.push(frame);
      },
      close: () => harness.transport.close(),
    };
    const client = new ZCodeProtocolClient(transport, logger);

    const response = client.request(
      "__call",
      { content: "PROMPT_MUST_NOT_BE_LOGGED" },
      z.object({ accepted: z.literal(true) }).strict(),
      1_000,
      { operation: "sendPrompt", sessionId: "session-1", inputId: "input-1" },
    );
    await writeStarted.promise;
    expect(logger.events("zcode.native_request.write.started")).toHaveLength(1);
    expect(logger.events("zcode.native_request.write.completed")).toHaveLength(
      0,
    );

    await sleep(10);
    releaseWrite.resolve();
    await sleep(0);
    const completed = logger.events("zcode.native_request.write.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({
      operation: "sendPrompt",
      sessionId: "session-1",
      inputId: "input-1",
      nativeRequestId: 1,
    });
    expect(Number(completed[0]?.data.durationMs)).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(logger.records)).not.toContain(
      "PROMPT_MUST_NOT_BE_LOGGED",
    );

    await harness.send({ id: 1, result: { accepted: true } });
    await expect(response).resolves.toEqual({ accepted: true });
    await client.close();
  });

  test("fails closed when the pending request limit is reached", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(
      harness.transport,
      new CaptureLogger(),
    );
    const requests = Array.from(
      { length: MAX_PENDING_NATIVE_REQUESTS },
      (_, index) =>
        client
          .request(`pending-${index}`, {}, z.object({}).strict())
          .catch(() => undefined),
    );

    await expect(
      client.request("one-too-many", {}, z.object({}).strict()),
    ).rejects.toMatchObject({
      code: "NATIVE_PROTOCOL_ERROR",
    });

    await client.close();
    await Promise.all(requests);
  });

  test("fails closed when the ordered notification backlog limit is reached", async () => {
    const harness = transportHarness();
    const releaseHandler = Promise.withResolvers<void>();
    const logger = new CaptureLogger();
    const client = new ZCodeProtocolClient(
      harness.transport,
      logger,
      undefined,
      async () => await releaseHandler.promise,
    );
    client.start();

    for (let index = 0; index <= MAX_QUEUED_NATIVE_NOTIFICATIONS; index += 1) {
      await harness.send({ method: "event", params: { index } });
    }
    await sleep(0);

    expect(logger.events("zcode.transport.failed")).toHaveLength(1);
    expect(logger.events("zcode.transport.failed")[0]?.data).toMatchObject({
      error: { code: "NATIVE_PROTOCOL_ERROR" },
    });
    releaseHandler.resolve();
  });
});

describe("runtime failure diagnostics", () => {
  const runtime = {
    appVersion: "4.0.0",
    cliVersion: "1.0.0",
    platform: "linux-x64",
  };
  test.each(["native-error", "invalid-result", "timeout", "exit"])(
    "preserves initialization context after %s",
    async (failure) => {
      const h = transportHarness();
      const failed = vi.fn();
      const client = new ZCodeProtocolClient(
        h.transport,
        new CaptureLogger(),
        undefined,
        undefined,
        failed,
        runtime,
      );
      const request = client.request(
        "__call",
        { secret: "secret-prompt" },
        z.object({ status: z.boolean() }).strict(),
        failure === "timeout" ? 5 : 1000,
        { operation: "initialize" },
      );
      const caught = request.catch((error) => error as AdapterError);
      if (failure === "native-error")
        await h.send({
          id: 1,
          error: { code: -32000, message: "secret-native-error" },
        });
      if (failure === "invalid-result")
        await h.send({ id: 1, result: { status: "secret-value" } });
      if (failure === "exit") await h.transport.close();
      const error = await caught;
      const diagnostic = JSON.parse(formatDiagnostic(error));
      expect(diagnostic).toMatchObject({
        ...runtime,
        operation: "initialize",
        check: {
          "native-error": "native-error",
          "invalid-result": "native-result",
          timeout: "request-timeout",
          exit: "native-exit",
        }[failure],
      });
      if (failure === "invalid-result")
        expect(diagnostic.validation).toEqual([
          { path: "status", code: "invalid_type" },
        ]);
      expect(formatDiagnostic(error)).not.toContain("secret");
      if (failure === "exit")
        expect(failed).toHaveBeenCalledWith(
          expect.objectContaining({ code: "NATIVE_EXITED" }),
        );
      await client.close();
    },
  );
  test("retains notification validation context in the failure callback", async () => {
    const h = transportHarness();
    const failure = Promise.withResolvers<AdapterError>();
    const client = new ZCodeProtocolClient(
      h.transport,
      new CaptureLogger(),
      undefined,
      (notification) => {
        z.object({ type: z.literal("known") }).parse(notification.params);
      },
      failure.resolve,
      runtime,
    );
    client.start();
    await h.send({ method: "event", params: { type: "secret-unknown-event" } });
    const error = await failure.promise;
    expect(JSON.parse(formatDiagnostic(error))).toMatchObject({
      ...runtime,
      stage: "notification",
      check: "native-event",
      operation: "event",
      validation: [{ path: "type", code: "invalid_value" }],
    });
    expect(formatDiagnostic(error)).not.toContain("secret");
    await client.close();
  });
});

type LogLevel = Parameters<Logger["log"]>[0];

class CaptureLogger implements Logger {
  readonly records: Array<{
    level: LogLevel;
    event: string;
    data: Record<string, unknown>;
  }> = [];

  log(
    level: LogLevel,
    event: string,
    data: Record<string, unknown> = {},
  ): void {
    this.records.push({ level, event, data });
  }

  error(
    event: string,
    error: unknown,
    data: Record<string, unknown> = {},
  ): void {
    this.log("error", event, { ...data, error });
  }

  events(event: string): typeof this.records {
    return this.records.filter((record) => record.event === event);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportHarness(): {
  transport: NativeTransport;
  writes: string[];
  send(value: unknown): Promise<void>;
} {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const inputWriter = input.writable.getWriter();
  const writes: string[] = [];
  const encoder = new TextEncoder();

  return {
    transport: {
      readable: input.readable,
      async write(frame) {
        writes.push(frame);
      },
      async close() {
        await inputWriter.close();
      },
    },
    writes,
    async send(value) {
      await inputWriter.write(encoder.encode(`${JSON.stringify(value)}\n`));
    },
  };
}
