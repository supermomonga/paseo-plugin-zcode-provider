import { expect, test } from "vitest";
import type { SessionErrorInfo } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import { formatDiagnostic } from "./diagnostics.js";
import { turnFailure } from "./turn-failure.js";

function lastError(
  attribution: SessionErrorInfo["attribution"],
  source: SessionErrorInfo["source"] = "provider",
): SessionErrorInfo {
  return {
    code: "secret-code",
    message: "secret-message",
    recoverable: true,
    at: 1,
    source,
    detail: "secret-detail",
    underlyingErrorMessage: "secret-underlying",
    attribution,
  };
}

test.each([
  ["rate_limited", "MODEL_RATE_LIMITED"],
  ["offpeak_queued", "MODEL_RATE_LIMITED"],
  ["auth_failed", "MODEL_AUTH_FAILED"],
  ["provider_not_configured", "MODEL_AUTH_FAILED"],
  ["context_exceeded", "MODEL_CONTEXT_EXCEEDED"],
  ["timeout", "MODEL_NETWORK_ERROR"],
  ["tls_error", "MODEL_NETWORK_ERROR"],
  ["server_error", "MODEL_PROVIDER_ERROR"],
  ["provider_overloaded", "MODEL_PROVIDER_ERROR"],
  ["invalid_request", "MODEL_REQUEST_FAILED"],
  ["unknown", "MODEL_REQUEST_FAILED"],
  ["secret-reason", "MODEL_REQUEST_FAILED"],
])("classifies the provider reason %s as %s", (reason, code) => {
  const failure = turnFailure(lastError({ source: "provider", reason }), {});
  expect(failure.code).toBe(code);
  expect(failure.message).not.toContain("secret");
  expect(formatDiagnostic(failure)).not.toContain("secret");
});

test("falls back to the source when the reason is missing", () => {
  expect(turnFailure(lastError(undefined, "network"), {}).code).toBe(
    "MODEL_NETWORK_ERROR",
  );
  expect(turnFailure(lastError(undefined, "provider"), {}).code).toBe(
    "MODEL_REQUEST_FAILED",
  );
  // The attribution's source wins over the coarse lastError source.
  expect(
    turnFailure(lastError({ source: "network" }, "runtime"), {}).code,
  ).toBe("MODEL_NETWORK_ERROR");
});

test("does not attribute runtime or tool failures to the model provider", () => {
  for (const failure of [
    turnFailure(lastError({ reason: "hook_blocked" }, "runtime"), {}),
    turnFailure(lastError({ reason: "timeout" }, "tool"), {}),
    turnFailure(null, {}),
  ]) {
    expect(failure.code).toBe("NATIVE_TURN_FAILED");
    expect(failure.message).toBe("ZCode turn failed.");
  }
});

test("adds only reportable status and provider codes to the message", () => {
  expect(
    turnFailure(
      lastError({
        source: "provider",
        reason: "rate_limited",
        statusCode: 429,
        providerErrorCode: "insufficient_quota",
      }),
      {},
    ).message,
  ).toMatch(/\(HTTP 429, provider code insufficient_quota\)\. Wait/u);
  const key = "0123456789abcdef0123456789abcdef.SecretKey123";
  const failure = turnFailure(
    lastError({
      source: "provider",
      reason: "auth_failed",
      statusCode: 401,
      providerErrorCode: key,
    }),
    {},
  );
  expect(failure.message).toMatch(
    /^The model provider is not signed in or rejected the credentials \(HTTP 401\)\./u,
  );
  expect(formatDiagnostic(failure)).not.toContain(key);
});

test("reports the turn stage and allowlisted attribution with the runtime context", () => {
  const failure = turnFailure(
    lastError({
      source: "provider",
      reason: "rate_limited",
      errorPhase: "stream",
      exceptionKind: "provider_business",
      providerId: "secret-provider",
      modelId: "secret-model",
      providerKind: "secret-kind",
      transport: "sse",
      statusCode: 429,
      providerErrorCode: "1310",
      retryable: false,
    }),
    { appVersion: "3.16.2", platform: "linux-x64", stage: "session" },
  );
  const diagnostic = formatDiagnostic(failure);
  expect(JSON.parse(diagnostic)).toMatchObject({
    code: "MODEL_RATE_LIMITED",
    appVersion: "3.16.2",
    platform: "linux-x64",
    stage: "turn",
    failure: {
      source: "provider",
      reason: "rate_limited",
      errorPhase: "stream",
      exceptionKind: "provider_business",
      statusCode: 429,
      providerErrorCode: "1310",
      retryable: false,
    },
  });
  expect(diagnostic).not.toContain("secret");
});
