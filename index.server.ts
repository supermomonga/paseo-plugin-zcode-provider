import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZCodeProvider } from "./server/provider.js";
import { ManagedRuntimeInstaller } from "./server/runtime/managed.js";
import { createRuntimeSetupHandlers } from "./server/runtime-setup.js";
import { createDiagnosticsHandler } from "./server/status.js";
import { zcodeDiagnostics } from "./shared/diagnostics.js";
import {
  zcodeRuntimeInstall,
  zcodeRuntimeRemove,
  zcodeRuntimeStatus,
} from "./shared/runtime-setup.js";

export default function contribute(server: PluginServerContext): () => void {
  server.registerProvider(createZCodeProvider());
  server.handle(zcodeDiagnostics, createDiagnosticsHandler());
  const setup = createRuntimeSetupHandlers(new ManagedRuntimeInstaller());
  server.handle(zcodeRuntimeStatus, setup.status);
  server.handle(zcodeRuntimeInstall, setup.install);
  server.handle(zcodeRuntimeRemove, setup.remove);
  return () => {};
}
