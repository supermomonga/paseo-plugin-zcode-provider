import type { ProviderRegistration } from "@getpaseo/plugin/provider";
import { createZCodeProvider } from "./server/provider.js";

// Only the public registration member is needed by this server-only plugin.
export default function contribute(server: {
  registerProvider(provider: ProviderRegistration): void;
}): () => void {
  server.registerProvider(createZCodeProvider());
  return () => {};
}
