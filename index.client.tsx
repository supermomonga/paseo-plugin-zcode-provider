import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DiagnosticsScreen } from "./client/diagnostics";

export default function contribute(client: PluginClientContext): () => void {
  client.addSettingsScreen({
    id: "diagnostics",
    title: "Diagnostics",
    icon: "Activity",
    Component: DiagnosticsScreen,
  });
  return () => {};
}
