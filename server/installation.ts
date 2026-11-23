import type {
  ProviderInspection,
  ProviderRegistration,
  ProviderUpdateCheck,
  ProviderUpdateResult,
} from "@getpaseo/plugin/server/provider";
import { discoverRuntime } from "./discovery/discover.js";
import { AdapterError } from "./errors.js";
import { logger } from "./logger.js";
import {
  installedVersions,
  type InstalledVersions,
  type ManagedRuntimeInstaller,
  type SetupState,
} from "./runtime/managed.js";
import { MANAGED_NODE_VERSION, MANAGED_ZCODE_RELEASE } from "./runtime/pins.js";

type ProviderInstallation = NonNullable<ProviderRegistration["installation"]>;

const SETUP_URL =
  "https://github.com/supermomonga/paseo-plugin-zcode-provider#setup";
const OVERRIDE_MESSAGE =
  "PASEO_ZCODE_RUNTIME and PASEO_ZCODE_NODE select this runtime. The plugin updates only the runtime it installs.";

/**
 * How Paseo shows a managed runtime: the pinned release, or the ZCode version
 * an earlier install recorded (its release is not recorded), with Node.js.
 */
const runtimeLabel = (installed: InstalledVersions): string =>
  `${installed.zcode?.pinned ? MANAGED_ZCODE_RELEASE : installed.zcode?.version} (Node.js ${installed.node?.version ?? "not installed"})`;

const PINNED_LABEL = `${MANAGED_ZCODE_RELEASE} (Node.js ${MANAGED_NODE_VERSION})`;

const COMPONENT_LABELS = {
  node: `Node.js ${MANAGED_NODE_VERSION}`,
  zcode: `ZCode runtime ${MANAGED_ZCODE_RELEASE}`,
} as const;
const PHASES = {
  download: "Downloading",
  extract: "Extracting",
  verify: "Verifying",
} as const;

export interface InstallationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly discover?: typeof discoverRuntime;
}

/**
 * The managed runtime on Paseo's provider page (ADR 35): its installed
 * version, whether this plugin version pins another, and an Update that runs
 * the same pinned setup as the Runtime tab. Nothing here takes a URL, path or
 * version from a client.
 */
export function createInstallation(
  installer: ManagedRuntimeInstaller,
  options: InstallationOptions = {},
): ProviderInstallation {
  const environment = options.environment ?? process.env;
  const discover = options.discover ?? discoverRuntime;
  const overridden = () =>
    Boolean(environment.PASEO_ZCODE_RUNTIME || environment.PASEO_ZCODE_NODE);

  return {
    installUrl: SETUP_URL,
    updateUrl: SETUP_URL,

    async inspect({ signal }): Promise<ProviderInspection> {
      if (overridden()) {
        try {
          const runtime = await discover({ environment, signal });
          const { appVersion, cliVersion } = runtime.identity;
          return {
            status: "installed",
            version: `Server ${appVersion}, Agent ${cliVersion} (PASEO_ZCODE_RUNTIME)`,
          };
        } catch (error) {
          // Paseo shows a thrown message as the failed check; discovery
          // errors carry fixed messages and nothing else leaves the log.
          if (error instanceof AdapterError) throw new Error(error.message);
          logger.error("zcode.installation.inspect.failed", error);
          throw new Error("ZCode runtime could not be inspected");
        }
      }
      const layout = installer.layout();
      if (layout === undefined) return { status: "not_installed" };
      const installed = await installedVersions(layout);
      if (installed.zcode === undefined) return { status: "not_installed" };
      return { status: "installed", version: runtimeLabel(installed) };
    },

    async checkForUpdates(): Promise<ProviderUpdateCheck> {
      if (overridden()) return { status: "unknown", message: OVERRIDE_MESSAGE };
      const layout = installer.layout();
      if (layout === undefined)
        return {
          status: "unknown",
          message: "Managed ZCode setup is not available on this platform",
        };
      if ((await installedVersions(layout)).pinned)
        return { status: "current" };
      return {
        status: "available",
        versions: [PINNED_LABEL],
        message: "This plugin version runs this ZCode runtime.",
      };
    },

    async update({ report, signal }): Promise<ProviderUpdateResult> {
      if (overridden()) return { status: "failed", message: OVERRIDE_MESSAGE };
      const layout = installer.layout();
      if (layout === undefined)
        return {
          status: "failed",
          message: "Managed ZCode setup is not available on this platform",
        };
      if ((await installedVersions(layout)).pinned)
        return {
          status: "succeeded",
          message: `ZCode runtime ${PINNED_LABEL} is already installed.`,
        };
      // One line per step, not per downloaded chunk.
      let step: string | undefined;
      const unsubscribe = installer.subscribe((state: SetupState) => {
        if (state.state !== "running") return;
        const next = `${PHASES[state.phase]} ${COMPONENT_LABELS[state.component]}`;
        if (next === step) return;
        step = next;
        report({ type: "message", text: `${next}\n` });
      });
      // Paseo aborts when the daemon stops; setup then ends with the plugin.
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      aborted.catch(() => {});
      try {
        // A setup that the Runtime tab started is joined, not repeated.
        installer.start();
        await Promise.race([installer.settled(), aborted]);
      } finally {
        unsubscribe();
      }
      const state = installer.state();
      if (state.state === "failed")
        return { status: "failed", message: state.message };
      if (!(await installedVersions(layout)).pinned)
        return {
          status: "failed",
          message: "ZCode runtime setup did not finish. Try again.",
        };
      return {
        status: "succeeded",
        message: `Installed ZCode runtime ${PINNED_LABEL}.`,
      };
    },
  };
}
