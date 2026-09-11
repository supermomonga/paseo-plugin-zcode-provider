import { z } from "zod";
import { valid } from "semver";
import { PROVIDER_VERSION as providerVersion } from "./build-info.js";
import { AdapterError, type ZCodeErrorCode } from "./errors.js";
import type { DiscoveredRuntime } from "./discovery/types.js";

const stages = [
  "discovery",
  "version",
  "host-inspection",
  "smoke",
  "host-start",
  "request",
  "response",
  "notification",
  "transport",
  "session",
] as const;
const checks = [
  "bundle-metadata",
  "minimum-version",
  "host-entry",
  "host-imports",
  "host-path",
  "rpc-module-load",
  "rpc-missing",
  "rpc-ambiguous",
  "host-inspection-result",
  "cli-smoke",
  "native-envelope",
  "native-result",
  "native-event",
  "native-error",
  "native-exit",
  "request-timeout",
  "request-write",
] as const;
const operations = new Set([
  "initialize",
  "readWorkspaceState",
  "createSession",
  "resumeSession",
  "listSessions",
  "readSession",
  "readSessionMessages",
  "readSessionEvents",
  "sendPrompt",
  "closeSession",
  "setModel",
  "setThoughtLevel",
  "setMode",
  "getTaskTokenUsage",
  "respondProviderRuntimeHeaders",
  "disposeWorkspace",
  "cancelGeneration",
  "respondStructuredInput",
  "respondPermission",
  "getEntitlementSnapshot",
  "getCodingPlanResetStatus",
  "__call",
  "__subscribe",
  "__unsubscribe",
  "event",
  "catalog",
  "session.create",
  "session.resume",
  "session.list",
  "session.prompt",
  "session.configure",
  "session.close",
  "session.cancel",
  "session.permission.respond",
  "session.open",
  "session.interrupt",
  "session.permission",
]);
// Paths from record/map keys can contain user data. Only fixed schema field names are reportable.
const schemaFields = new Set([
  "id",
  "type",
  "method",
  "params",
  "result",
  "error",
  "code",
  "message",
  "subscriptionId",
  "event",
  "sessionId",
  "turnId",
  "seq",
  "payload",
  "kind",
  "delta",
  "status",
  "models",
  "settings",
  "mode",
  "current",
  "thoughtLevel",
  "model",
  "provider",
  "providers",
  "options",
  "request",
  "workspacePath",
  "sessions",
  "items",
  "usage",
  "data",
  "name",
  "role",
  "content",
  "requestId",
  "toolCallId",
]);

export interface RuntimeDiagnostic {
  readonly appVersion?: string;
  readonly cliVersion?: string;
  readonly platform?: string;
  readonly stage?: (typeof stages)[number];
  readonly operation?: string;
  readonly check?: (typeof checks)[number];
  readonly artifactMatch?: boolean;
  readonly hostIndexSha256?: string;
  readonly hostRpcModuleSha256?: string;
  readonly nativeCode?: number;
  readonly exitCode?: number;
  readonly validation?: readonly { path: string; code: string }[];
}

export function runtimeDiagnostic(
  runtime: DiscoveredRuntime,
): RuntimeDiagnostic {
  return {
    appVersion: runtime.identity.appVersion,
    cliVersion: runtime.identity.cliVersion,
    platform: runtime.identity.platform,
    artifactMatch: runtime.resolvedHost?.artifactMatch,
    hostIndexSha256: runtime.resolvedHost?.hostIndexSha256,
    hostRpcModuleSha256: runtime.resolvedHost?.hostRpcModuleSha256,
  };
}

export function diagnosticError(
  error: unknown,
  context: RuntimeDiagnostic,
  defaultCode: ZCodeErrorCode = "NATIVE_PROTOCOL_ERROR",
): AdapterError {
  const diagnostic = {
    ...context,
    ...(error instanceof AdapterError ? error.diagnostic : {}),
  };
  const cause = error instanceof AdapterError ? error.cause : error;
  if (cause instanceof z.ZodError) {
    diagnostic.validation = cause.issues.slice(0, 10).map((issue) => ({
      path: issue.path
        .map((part) =>
          typeof part === "number"
            ? "[]"
            : schemaFields.has(String(part))
              ? String(part)
              : "*",
        )
        .join("."),
      code: issue.code,
    }));
  }
  return new AdapterError(
    error instanceof AdapterError ? error.code : defaultCode,
    error instanceof AdapterError ? error.message : "ZCode operation failed",
    error instanceof AdapterError ? error.details : {},
    { cause: error },
    diagnostic,
  );
}

export function formatDiagnostic(error: unknown): string {
  const context = error instanceof AdapterError ? error.diagnostic : undefined;
  const result: Record<string, unknown> = {
    providerVersion,
    code: error instanceof AdapterError ? error.code : "NATIVE_PROTOCOL_ERROR",
  };
  if (context) {
    for (const key of ["appVersion", "cliVersion"] as const) {
      const value = context[key];
      if (value && valid(value)) result[key] = valid(value);
    }
    if (
      context.platform &&
      /^(darwin|linux|win32)-(arm64|x64|ia32)$/u.test(context.platform)
    )
      result.platform = context.platform;
    if (context.stage && stages.includes(context.stage))
      result.stage = context.stage;
    if (context.check && checks.includes(context.check))
      result.check = context.check;
    if (context.operation && operations.has(context.operation))
      result.operation = context.operation;
    if (typeof context.artifactMatch === "boolean")
      result.artifactMatch = context.artifactMatch;
    for (const key of ["hostIndexSha256", "hostRpcModuleSha256"] as const) {
      if (/^[a-f0-9]{64}$/u.test(context[key] ?? ""))
        result[key] = context[key];
    }
    for (const key of ["nativeCode", "exitCode"] as const) {
      if (Number.isSafeInteger(context[key])) result[key] = context[key];
    }
    if (context.validation)
      result.validation = context.validation.slice(0, 10).map((issue) => ({
        path: issue.path
          .split(".")
          .slice(0, 20)
          .map((part) =>
            schemaFields.has(part) || part === "[]" || part === "" ? part : "*",
          )
          .join("."),
        code: [
          "invalid_type",
          "too_big",
          "too_small",
          "invalid_format",
          "not_multiple_of",
          "unrecognized_keys",
          "invalid_union",
          "invalid_key",
          "invalid_element",
          "invalid_value",
          "custom",
        ].includes(issue.code)
          ? issue.code
          : "custom",
      }));
  }
  return JSON.stringify(result, null, 2);
}
