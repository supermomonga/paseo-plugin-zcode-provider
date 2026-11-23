import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AccountService } from "./server/account.js";
import { GoalDirectory, serveGoals } from "./server/goal.js";
import { createInstallation } from "./server/installation.js";
import { createHost, createZCodeProvider } from "./server/provider.js";
import { createRuntimeStatus } from "./server/provider-status.js";
import { ManagedRuntimeInstaller } from "./server/runtime/managed.js";
import { createRuntimeSetupHandlers } from "./server/runtime-setup.js";
import { createDiagnosticsHandler } from "./server/status.js";
import { followTimelineSettings } from "./server/timeline-settings.js";
import { createUsageSource } from "./server/usage.js";
import { zcodeAccountChange, zcodeAccountView } from "./shared/account.js";
import { zcodeDiagnostics } from "./shared/diagnostics.js";
import { zcodeGoals } from "./shared/goal.js";
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
  const goals = new GoalDirectory();
  // The Runtime tab and Paseo's provider page share one setup job.
  const installer = new ManagedRuntimeInstaller();
  server.registerProvider(
    createZCodeProvider(
      undefined,
      undefined,
      createRuntimeStatus({ installer }),
      timeline.current,
      goals,
      createInstallation(installer),
    ),
  );
  server.handle(zcodeGoals, serveGoals(goals));
  server.handle(zcodeDiagnostics, createDiagnosticsHandler());
  const setup = createRuntimeSetupHandlers(installer);
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
