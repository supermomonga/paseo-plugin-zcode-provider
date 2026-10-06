import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { AccountTab } from "./account";
import { RuntimeTab } from "./runtime";

const TABS = [
  { id: "runtime", label: "Runtime" },
  { id: "account", label: "Account" },
] as const;
type Tab = (typeof TABS)[number]["id"];

// Plugin settings screens have no host tab control; this follows the look of
// the host's small segmented control.
function Tabs({
  value,
  onChange,
  theme,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
  theme: PluginSurfaceProps["theme"];
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        alignSelf: "flex-start",
        gap: 4,
        padding: 2,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === value;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.id)}
            style={({ pressed }) => ({
              minHeight: 28,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: 10,
              backgroundColor:
                selected || pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text
              style={{
                color: selected
                  ? theme.colors.foreground
                  : theme.colors.foregroundMuted,
                fontSize: 14,
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SettingsScreen(props: PluginSurfaceProps) {
  const [tab, setTab] = useState<Tab>("runtime");
  return (
    <View style={{ gap: props.layout.compact ? 16 : 24 }}>
      <Tabs value={tab} onChange={setTab} theme={props.theme} />
      {tab === "runtime" ? (
        <RuntimeTab {...props} />
      ) : (
        <AccountTab {...props} onOpenRuntime={() => setTab("runtime")} />
      )}
    </View>
  );
}
