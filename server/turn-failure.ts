import type { SessionErrorInfo } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import { AdapterError, type ZCodeErrorCode } from "./errors.js";
import {
  modelFailureReasons,
  reportableProviderErrorCode,
  reportableStatusCode,
  type ModelFailureReason,
  type RuntimeDiagnostic,
} from "./diagnostics.js";

type TurnFailureCode = Extract<
  ZCodeErrorCode,
  "NATIVE_TURN_FAILED" | `MODEL_${string}`
>;

// Reasons without an entry fall back to the attribution source.
const reasonCodes: Partial<Record<ModelFailureReason, TurnFailureCode>> = {
  rate_limited: "MODEL_RATE_LIMITED",
  offpeak_queued: "MODEL_RATE_LIMITED",
  auth_failed: "MODEL_AUTH_FAILED",
  auth_refresh: "MODEL_AUTH_FAILED",
  provider_not_configured: "MODEL_AUTH_FAILED",
  context_exceeded: "MODEL_CONTEXT_EXCEEDED",
  network_error: "MODEL_NETWORK_ERROR",
  timeout: "MODEL_NETWORK_ERROR",
  stream_idle_timeout: "MODEL_NETWORK_ERROR",
  stale_connection: "MODEL_NETWORK_ERROR",
  proxy_error: "MODEL_NETWORK_ERROR",
  tls_error: "MODEL_NETWORK_ERROR",
  server_error: "MODEL_PROVIDER_ERROR",
  provider_overloaded: "MODEL_PROVIDER_ERROR",
};

const messages: Record<
  TurnFailureCode,
  readonly [summary: string, advice?: string]
> = {
  NATIVE_TURN_FAILED: ["ZCode turn failed"],
  MODEL_RATE_LIMITED: [
    "The model provider's usage or rate limit was reached",
    "Wait for it to reset or switch models. For a ZCode Coding Plan, Paseo 0.11 and later show the reset times on the Usage screen.",
  ],
  MODEL_AUTH_FAILED: [
    "The model provider is not signed in or rejected the credentials",
    "Check the account and model providers in the Account tab of the zcode-provider Settings.",
  ],
  MODEL_CONTEXT_EXCEEDED: [
    "The conversation exceeds the model's context window",
    "Start a new session or switch to a model with a larger context window.",
  ],
  MODEL_NETWORK_ERROR: [
    "ZCode could not reach the model provider",
    "Check the network connection and try again.",
  ],
  MODEL_PROVIDER_ERROR: [
    "The model provider returned a server error or is overloaded",
    "Try again later.",
  ],
  MODEL_REQUEST_FAILED: ["The model provider rejected the request"],
};

/**
 * Classifies a failed turn by the attribution of V4 `control.lastError`
 * (ADR 23). ZCode's message and detail are never used: they can carry
 * provider text, request content or credentials (ADR 7).
 */
export function turnFailure(
  lastError: SessionErrorInfo | null,
  context: RuntimeDiagnostic,
): AdapterError {
  const attribution = lastError?.attribution;
  const source = attribution?.source ?? lastError?.source;
  const reason = modelFailureReasons.find((r) => r === attribution?.reason);
  const code: TurnFailureCode =
    source === "provider" || source === "network"
      ? ((reason && reasonCodes[reason]) ??
        (source === "network" ? "MODEL_NETWORK_ERROR" : "MODEL_REQUEST_FAILED"))
      : "NATIVE_TURN_FAILED";
  const statusCode = reportableStatusCode(attribution?.statusCode);
  const providerErrorCode = reportableProviderErrorCode(
    attribution?.providerErrorCode,
  );
  const facts = [
    ...(statusCode ? [`HTTP ${statusCode}`] : []),
    ...(providerErrorCode ? [`provider code ${providerErrorCode}`] : []),
  ];
  const [summary, advice] = messages[code];
  return new AdapterError(
    code,
    `${summary}${facts.length ? ` (${facts.join(", ")})` : ""}.${advice ? ` ${advice}` : ""}`,
    {},
    undefined,
    {
      ...context,
      stage: "turn",
      ...(lastError
        ? {
            failure: {
              source,
              reason: attribution?.reason,
              errorPhase: attribution?.errorPhase,
              exceptionKind: attribution?.exceptionKind,
              statusCode: attribution?.statusCode,
              providerErrorCode: attribution?.providerErrorCode,
              retryable: attribution?.retryable,
            },
          }
        : {}),
    },
  );
}
