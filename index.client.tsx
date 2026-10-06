import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DiagnosticsScreen } from "./client/diagnostics";
import { SettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext): () => void {
  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: "Settings",
    icon: "Settings",
    Component: SettingsScreen,
  });
  const removeDiagnostics = client.addSettingsScreen({
    id: "diagnostics",
    title: "Diagnostics",
    icon: "Activity",
    Component: DiagnosticsScreen,
  });
  return () => {
    removeSettings();
    removeDiagnostics();
  };
}
