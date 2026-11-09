import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AccountService } from "./server/account.js";
import { createHost, createZCodeProvider } from "./server/provider.js";
import { ManagedRuntimeInstaller } from "./server/runtime/managed.js";
import { createRuntimeSetupHandlers } from "./server/runtime-setup.js";
import { createDiagnosticsHandler } from "./server/status.js";
import { followTimelineSettings } from "./server/timeline-settings.js";
import { createUsageSource } from "./server/usage.js";
import { zcodeAccountChange, zcodeAccountView } from "./shared/account.js";
import { zcodeDiagnostics } from "./shared/diagnostics.js";
import {
  zcodeRuntimeInstall,
  zcodeRuntimeRemove,
  zcodeRuntimeStatus,
} from "./shared/runtime-setup.js";
import { zcodeTimelineSettings } from "./shared/timeline.js";

export default function contribute(server: PluginServerContext): () => void {
  const timeline = followTimelineSettings(
    server.registerSettings(zcodeTimelineSettings),
  );
  server.registerProvider(
    createZCodeProvider(undefined, undefined, undefined, timeline.current),
  );
  server.handle(zcodeDiagnostics, createDiagnosticsHandler());
  const setup = createRuntimeSetupHandlers(new ManagedRuntimeInstaller());
  server.handle(zcodeRuntimeStatus, setup.status);
  server.handle(zcodeRuntimeInstall, setup.install);
  server.handle(zcodeRuntimeRemove, setup.remove);
  const abort = new AbortController();
  const account = new AccountService(() =>
    createHost({}, abort.signal, homedir()),
  );
  server.handle(zcodeAccountView, () => account.view());
  server.handle(zcodeAccountChange, (input) => account.change(input));
  const usage = createUsageSource(account);
  server.registerUsageSource(usage.source);
  return () => {
    usage.dispose();
    timeline.dispose();
    abort.abort();
    void account.close();
  };
}
