import type {
  ProviderStatus,
  ProviderStatusRequest,
} from "@getpaseo/plugin/server/provider";
import {
  assertRuntimeSupported,
  discoverRuntime,
} from "./discovery/discover.js";
import { AdapterError } from "./errors.js";
import { logger } from "./logger.js";

export interface RuntimeStatusOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly discover?: typeof discoverRuntime;
  /** How long a result is reused. Paseo asks on every catalog load and agent start. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

// Same shape as Paseo's built-in provider diagnostics; the daemon appends the
// model count and snapshot status as further indented lines.
const format = (entries: readonly [string, string][]) =>
  ["ZCode", ...entries.map(([label, value]) => `  ${label}: ${value}`)].join(
    "\n",
  );

async function check(
  environment: NodeJS.ProcessEnv,
  discover: typeof discoverRuntime,
): Promise<ProviderStatus> {
  try {
    const runtime = await discover({ environment });
    assertRuntimeSupported(runtime);
    const { appVersion, cliVersion, nodeVersion, platform } = runtime.identity;
    return {
      available: true,
      diagnostic: format([
        [
          "Runtime",
          `${runtime.source === "managed" ? "managed" : "PASEO_ZCODE_RUNTIME"}, Server ${appVersion}, Agent ${cliVersion}`,
        ],
        ["Node.js", nodeVersion],
        ["Platform", platform],
      ]),
    };
  } catch (error) {
    // Discovery errors carry fixed messages; anything else stays in the log.
    if (!(error instanceof AdapterError))
      logger.error("zcode.provider.status.failed", error);
    return {
      available: false,
      diagnostic: format([
        [
          "Error",
          error instanceof AdapterError
            ? error.message
            : "ZCode runtime could not be inspected",
        ],
      ]),
    };
  }
}

/**
 * Availability for Paseo's provider snapshot and diagnostics (Paseo 0.11+;
 * older daemons ignore it). It inspects the runtime without starting a Server,
 * so sign-in problems still surface when a session opens.
 */
export function createRuntimeStatus(options: RuntimeStatusOptions = {}) {
  const environment = options.environment ?? process.env;
  const discover = options.discover ?? discoverRuntime;
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: Promise<ProviderStatus> } | undefined;
  return (_request?: ProviderStatusRequest): Promise<ProviderStatus> => {
    if (cached && now() - cached.at < ttlMs) return cached.result;
    const entry = { at: now(), result: check(environment, discover) };
    cached = entry;
    return entry.result;
  };
}
