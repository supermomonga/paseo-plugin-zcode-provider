export type ZCodeErrorCode =
  | "PERSISTENCE_INVALID"
  | "PERSISTENCE_WRITE_FAILED"
  | "PERSISTENCE_VERSION_UNSUPPORTED"
  | "INVALID_CONFIGURATION"
  | "INVALID_WORKSPACE"
  | "UNSUPPORTED_PLATFORM"
  | "UNSUPPORTED_ZCODE"
  | "RUNTIME_DISCOVERY_FAILED"
  | "RUNTIME_SMOKE_FAILED"
  | "RUNTIME_SETUP_REQUIRED"
  | "RUNTIME_SETUP_FAILED"
  | "NATIVE_PROTOCOL_ERROR"
  | "NATIVE_INPUT_REJECTED"
  | "NATIVE_TIMEOUT"
  | "NATIVE_EXITED"
  | "NATIVE_TURN_FAILED"
  | "MODEL_RATE_LIMITED"
  | "MODEL_AUTH_FAILED"
  | "MODEL_CONTEXT_EXCEEDED"
  | "MODEL_NETWORK_ERROR"
  | "MODEL_PROVIDER_ERROR"
  | "MODEL_REQUEST_FAILED"
  | "AUTH_REQUIRED"
  | "UNSUPPORTED_CONTENT"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "INTERACTION_UNSUPPORTED";

export class AdapterError extends Error {
  override readonly name = "ZCodeProviderError";

  constructor(
    readonly code: ZCodeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
    readonly diagnostic?: RuntimeDiagnostic,
  ) {
    super(message, options);
  }
}
import type { RuntimeDiagnostic } from "./diagnostics.js";
