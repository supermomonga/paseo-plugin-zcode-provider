import type {
  PluginClientContext,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { AccountTab } from "./client/account";
import { DiagnosticsScreen } from "./client/diagnostics";
import { GoalPopover } from "./client/goal";
import { followGoals } from "./client/goal-pills";
import { RuntimeTab } from "./client/runtime";
import { TimelineTab } from "./client/timeline";

export default function contribute(client: PluginClientContext): () => void {
  // Paseo shows one tab per settings screen, in this order (ADR 30).
  const removeScreens = [
    client.addSettingsScreen({
      id: "runtime",
      title: "Runtime",
      icon: "HardDriveDownload",
      Component: RuntimeTab,
    }),
    client.addSettingsScreen({
      id: "account",
      title: "Account",
      icon: "CircleUser",
      Component: (props: PluginSurfaceProps) => (
        <AccountTab
          {...props}
          onOpenRuntime={() => client.openSettings("runtime")}
        />
      ),
    }),
    client.addSettingsScreen({
      id: "timeline",
      title: "Timeline",
      icon: "MessagesSquare",
      Component: TimelineTab,
    }),
    client.addSettingsScreen({
      id: "diagnostics",
      title: "Diagnostics",
      icon: "Activity",
      Component: DiagnosticsScreen,
    }),
  ];
  const stopGoals = followGoals(client, GoalPopover);
  return () => {
    for (const remove of removeScreens) remove();
    stopGoals();
  };
}
