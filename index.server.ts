import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZCodeProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext): () => void {
  server.registerProvider(createZCodeProvider());
  return () => {};
}
