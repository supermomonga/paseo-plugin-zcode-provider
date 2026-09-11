import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZCodeProvider } from "./server/provider.js";
import { createDiagnosticsHandler } from "./server/status.js";
import { zcodeDiagnostics } from "./shared/diagnostics.js";

export default function contribute(server: PluginServerContext): () => void {
  server.registerProvider(createZCodeProvider());
  server.handle(zcodeDiagnostics, createDiagnosticsHandler());
  return () => {};
}
