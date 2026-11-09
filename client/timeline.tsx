import { useCallback } from "react";
import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { zcodeTimelineSettings } from "../shared/timeline";
import { Value } from "./value";

const LABEL = "Show model changes";

export function TimelineTab({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(zcodeTimelineSettings);
  const toggle = useCallback(
    (showModelChanges: boolean) => {
      if (settings.status === "ready")
        void settings.save(
          { ...settings.values, showModelChanges },
          settings.revision,
        );
    },
    [settings],
  );

  if (settings.status === "loading")
    return (
      <SettingsSection title="Timeline">
        <SettingsCard>
          <SettingsRow label={LABEL}>
            <Value
              color={theme.colors.foregroundMuted}
              compact={layout.compact}
            >
              Loading…
            </Value>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  if (settings.status !== "ready")
    return (
      <SettingsSection title="Timeline">
        <SettingsCard>
          <SettingsRow label={LABEL} error={settings.error} />
          <SettingsAction
            label="Try again"
            actionLabel="Reload"
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Restore the default"
              actionLabel="Reset"
              disabled={settings.saving}
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  return (
    <SettingsSection title="Timeline">
      <SettingsCard>
        <SettingsSwitch
          label={LABEL}
          hint="Adds a line when ZCode runs a turn on a different model than the previous turn. Applies to lines that arrive after the change; reopened agents show their history with the current setting."
          value={settings.values.showModelChanges}
          disabled={settings.saving}
          error={settings.saveError}
          onValueChange={toggle}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
