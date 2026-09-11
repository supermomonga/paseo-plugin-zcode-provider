import type { RpcInput } from "@getpaseo/plugin";
import type {
  DiscoveredRuntime,
  RuntimeSmokeResult,
} from "./discovery/types.js";
import { discoverRuntime, runRuntimeSmoke } from "./discovery/discover.js";
import { AdapterError } from "./errors.js";
import { formatDiagnostic } from "./diagnostics.js";
import { defaultSessionDirectory } from "./persistence.js";
import { PROVIDER_VERSION } from "./build-info.js";
import {
  zcodeDiagnostics,
  type DiagnosticsResult,
} from "../shared/diagnostics.js";

export interface DiagnosticsDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly sessionsDirectory?: string;
  readonly providerVersion?: string;
  readonly discover?: typeof discoverRuntime;
  readonly smoke?: typeof runRuntimeSmoke;
}

function installRootSource(
  environment: NodeJS.ProcessEnv,
): "environment" | "default" {
  return environment.PASEO_ZCODE_INSTALL === undefined
    ? "default"
    : "environment";
}

function smokeResult(result: RuntimeSmokeResult) {
  return {
    passed: result.passed,
    ...(result.cliVersion === undefined
      ? {}
      : { cliVersion: result.cliVersion }),
    doctorPassed: result.doctorPassed,
    authentication: result.authentication,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

// Read-only report for the Settings screen. Detection runs on demand; the
// optional smoke check spawns the bundled CLI. Nothing here is persisted.
export function createDiagnosticsHandler(
  dependencies: DiagnosticsDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  const sessionsDirectory =
    dependencies.sessionsDirectory ?? defaultSessionDirectory(environment);
  const providerVersion = dependencies.providerVersion ?? PROVIDER_VERSION;
  const discover = dependencies.discover ?? discoverRuntime;
  const smoke = dependencies.smoke ?? runRuntimeSmoke;

  return async (
    input: RpcInput<typeof zcodeDiagnostics>,
  ): Promise<DiagnosticsResult> => {
    try {
      const runtime: DiscoveredRuntime = await discover({ environment });
      const checked = input.smoke
        ? await smoke(runtime, environment)
        : undefined;
      return {
        status: "ready",
        providerVersion,
        installRoot: runtime.paths.installRoot,
        installRootSource: installRootSource(environment),
        platform: runtime.identity.platform,
        ...(runtime.identity.appVersion === undefined
          ? {}
          : { appVersion: runtime.identity.appVersion }),
        ...(runtime.identity.cliVersion === undefined
          ? {}
          : { cliVersion: runtime.identity.cliVersion }),
        compatibility: runtime.compatibility,
        compatibilityReason: runtime.compatibilityReason,
        ...(runtime.resolvedHost === undefined
          ? {}
          : { artifactMatch: runtime.resolvedHost.artifactMatch }),
        writableInstallRoot: runtime.writableInstallRoot,
        sessionsDirectory,
        ...(checked === undefined ? {} : { smoke: smokeResult(checked) }),
      };
    } catch (error) {
      return {
        status: "failed",
        providerVersion,
        code: error instanceof AdapterError ? error.code : "UNKNOWN",
        message:
          error instanceof AdapterError
            ? error.message
            : "ZCode diagnostics failed",
        diagnostic: formatDiagnostic(error),
      };
    }
  };
}
