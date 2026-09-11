import { version } from "../package.json";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { diagnosticError, formatDiagnostic } from "./diagnostics.js";
import { AdapterError } from "./errors.js";
import { logger } from "./logger.js";

afterEach(() => vi.restoreAllMocks());

test("keeps structured failure context through wrappers without exposing native payloads", () => {
  const original = new AdapterError(
    "NATIVE_PROTOCOL_ERROR",
    "secret-native-message",
    { token: "secret-token" },
    { cause: new Error("secret-cause") },
  );
  const response = diagnosticError(original, {
    stage: "response",
    operation: "initialize",
    check: "native-error",
    nativeCode: -32000,
  });
  const error = diagnosticError(response, {
    appVersion: "4.0.0",
    cliVersion: "1.0.0",
    platform: "linux-x64",
    stage: "request",
    operation: "catalog",
  });
  expect(JSON.parse(formatDiagnostic(error))).toMatchObject({
    providerVersion: version,
    appVersion: "4.0.0",
    cliVersion: "1.0.0",
    platform: "linux-x64",
    stage: "response",
    operation: "initialize",
    check: "native-error",
    nativeCode: -32000,
  });
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  logger.error("zcode.test.failed", error, { prompt: "secret-prompt" });
  expect(JSON.stringify(output.mock.calls)).not.toContain("secret");
});

test("reports validation locations without messages, values, or user-controlled record keys", () => {
  const parsed = z
    .object({ models: z.record(z.string(), z.object({ id: z.number() })) })
    .safeParse({ models: { "secret-api-key": { id: "secret-prompt" } } });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("Expected invalid fixture");
  const error = diagnosticError(parsed.error, {
    stage: "response",
    check: "native-result",
  });
  expect(JSON.parse(formatDiagnostic(error)).validation).toEqual([
    { path: "models.*.id", code: "invalid_type" },
  ]);
  expect(formatDiagnostic(error)).not.toContain("secret");
});

test("only serializes allowlisted diagnostic fields", () => {
  const error = new AdapterError("NATIVE_EXITED", "secret", {}, undefined, {
    appVersion: "secret",
    cliVersion: "secret",
    platform: "secret",
    operation: "secret",
    hostIndexSha256: "secret",
    validation: [{ path: "models.secret", code: "secret" }],
  });
  expect(formatDiagnostic(error)).not.toContain("secret");
});
