import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DiagnosticsScreen } from "./client/diagnostics";
import { SetupScreen } from "./client/setup";

export default function contribute(client: PluginClientContext): () => void {
  const removeSetup = client.addSettingsScreen({
    id: "setup",
    title: "Setup",
    icon: "Download",
    Component: SetupScreen,
  });
  const removeDiagnostics = client.addSettingsScreen({
    id: "diagnostics",
    title: "Diagnostics",
    icon: "Activity",
    Component: DiagnosticsScreen,
  });
  return () => {
    removeSetup();
    removeDiagnostics();
  };
}
