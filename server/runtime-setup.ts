import { join } from "node:path";
import type { RuntimeSetupStatus } from "../shared/runtime-setup.js";
import { AdapterError } from "./errors.js";
import {
  isInstalled,
  managedRuntimeRoot,
  ManagedRuntimeInstaller,
  type ManagedComponent,
} from "./runtime/managed.js";

const LICENSES = {
  node: "Node.js license (MIT) with bundled third-party notices",
  zcode:
    "Unofficial build of ZCode (Apache-2.0); third-party terms in THIRD-PARTY-NOTICES.md",
} as const;

// Quoted for the shell a user is most likely to paste into on that OS.
export function loginCommand(
  executable: string,
  installRoot: string,
  windows = process.platform === "win32",
): string {
  const script = join(installRoot, "bin", "zcode.mjs");
  return windows
    ? `& ${powershellQuote(executable)} ${powershellQuote(script)} login`
    : `${posixQuote(executable)} ${posixQuote(script)} login`;
}
const posixQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function createRuntimeSetupHandlers(
  installer: ManagedRuntimeInstaller,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const component = async (
    entry: ManagedComponent,
  ): Promise<RuntimeSetupStatus["components"][number]> => ({
    id: entry.id,
    name: entry.id === "node" ? "Node.js" : "ZCode runtime",
    version: entry.version,
    url: entry.archive.url,
    sha256: entry.archive.sha256,
    sizeBytes: entry.archive.size,
    license: LICENSES[entry.id],
    installed: await isInstalled(entry),
  });

  return {
    async status(): Promise<RuntimeSetupStatus> {
      const layout = installer.layout();
      const override = Boolean(
        environment.PASEO_ZCODE_RUNTIME || environment.PASEO_ZCODE_NODE,
      );
      const base = {
        platform: `${process.platform}-${process.arch}`,
        override,
        job: installer.state(),
      };
      if (layout === undefined)
        return {
          ...base,
          supported: false,
          directory: managedRuntimeRoot(environment),
          components: [],
        };
      const components = [
        await component(layout.node),
        await component(layout.zcode),
      ];
      return {
        ...base,
        supported: true,
        directory: layout.root,
        components,
        ...(components.every((entry) => entry.installed)
          ? {
              loginCommand: loginCommand(
                layout.node.executable,
                layout.zcode.directory,
                layout.platform.startsWith("win-"),
              ),
            }
          : {}),
      };
    },
    install: async () => ({ started: installer.start() }),
    async remove() {
      try {
        await installer.remove();
        return { status: "removed" as const };
      } catch (error) {
        return {
          status: "failed" as const,
          message:
            error instanceof AdapterError
              ? error.message
              : "The managed runtime could not be removed",
        };
      }
    },
  };
}
