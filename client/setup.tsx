import { useCallback, useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import {
  zcodeRuntimeInstall,
  zcodeRuntimeRemove,
  zcodeRuntimeStatus,
  type RuntimeSetupStatus,
} from "../shared/runtime-setup";

type Theme = PluginSurfaceProps["theme"];
type Job = RuntimeSetupStatus["job"];

function Value({
  children,
  color,
  compact,
}: {
  children: string;
  color: string;
  compact: boolean;
}) {
  return (
    <Text
      selectable
      style={{ color, fontSize: compact ? 13 : 14, lineHeight: 20 }}
    >
      {children}
    </Text>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function jobLabel(job: Job): string {
  switch (job.state) {
    case "idle":
      return "Not started";
    case "succeeded":
      return "Completed";
    case "failed":
      return `Failed (${job.code})`;
    case "running": {
      const name = job.component === "node" ? "Node.js" : "ZCode runtime";
      if (job.phase !== "download") return `${name}: ${job.phase}ing`;
      const percent =
        job.totalBytes > 0
          ? Math.floor((job.receivedBytes / job.totalBytes) * 100)
          : 0;
      return `${name}: downloading ${percent}% of ${megabytes(job.totalBytes)}`;
    }
  }
}

function Components({
  status,
  theme,
  compact,
}: {
  status: RuntimeSetupStatus;
  theme: Theme;
  compact: boolean;
}) {
  return (
    <>
      {status.components.map((component) => (
        <SettingsSection
          key={component.id}
          title={`${component.name} ${component.version}`}
        >
          <SettingsCard>
            <SettingsRow label="Status">
              <Value
                color={
                  component.installed
                    ? theme.colors.statusSuccess
                    : theme.colors.foregroundMuted
                }
                compact={compact}
              >
                {component.installed ? "Installed" : "Not installed"}
              </Value>
            </SettingsRow>
            <SettingsRow label="Source" hint={megabytes(component.sizeBytes)}>
              <Value color={theme.colors.foregroundMuted} compact={compact}>
                {component.url}
              </Value>
            </SettingsRow>
            <SettingsRow label="SHA-256" hint="Checked before extraction">
              <Value color={theme.colors.foregroundMuted} compact={compact}>
                {component.sha256}
              </Value>
            </SettingsRow>
            <SettingsRow label="License">
              <Value color={theme.colors.foregroundMuted} compact={compact}>
                {component.license}
              </Value>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      ))}
    </>
  );
}

export function SetupScreen({ theme, layout }: PluginSurfaceProps) {
  const fetchStatus = useRpc(zcodeRuntimeStatus);
  const install = useRpc(zcodeRuntimeInstall);
  const remove = useRpc(zcodeRuntimeRemove);
  const [status, setStatus] = useState<RuntimeSetupStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, setPending] = useState(false);
  const compact = layout.compact;

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchStatus({}));
      setRequestError(null);
    } catch (cause) {
      setRequestError(
        cause instanceof Error ? cause.message : "The setup request failed.",
      );
    }
  }, [fetchStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = status?.job.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setPending(true);
      try {
        await action();
      } catch (cause) {
        setRequestError(
          cause instanceof Error ? cause.message : "The setup request failed.",
        );
      } finally {
        setPending(false);
        await refresh();
      }
    },
    [refresh],
  );

  if (status === null)
    return (
      <SettingsSection title="ZCode runtime setup">
        <SettingsCard>
          <SettingsRow label="Status">
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {requestError ?? "Checking the managed runtime…"}
            </Value>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );

  const installed =
    status.components.length > 0 &&
    status.components.every((component) => component.installed);
  const total = status.components
    .filter((component) => !component.installed)
    .reduce((sum, component) => sum + component.sizeBytes, 0);
  const busy = pending || running;

  return (
    <View style={{ gap: compact ? 16 : 24 }}>
      <SettingsSection title="ZCode runtime setup">
        <SettingsCard>
          <SettingsRow label="Downloads from">
            <Value color={theme.colors.foreground} compact={compact}>
              nodejs.org and this plugin's GitHub releases
            </Value>
          </SettingsRow>
          <SettingsRow
            label="ZCode build"
            hint="ZCode does not publish its CLI; CI builds the unmodified source."
          >
            <Value color={theme.colors.foreground} compact={compact}>
              Unofficial, not endorsed by ZCode or Z.ai
            </Value>
          </SettingsRow>
          <SettingsRow label="Runs as">
            <Value color={theme.colors.foreground} compact={compact}>
              The daemon user, on the daemon machine
            </Value>
          </SettingsRow>
          <SettingsRow label="Changes">
            <Value color={theme.colors.foreground} compact={compact}>
              Only the destination below; PATH is untouched
            </Value>
          </SettingsRow>
          <SettingsRow label="Destination">
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {status.directory}
            </Value>
          </SettingsRow>
          <SettingsRow label="Platform">
            <Value
              color={
                status.supported
                  ? theme.colors.foregroundMuted
                  : theme.colors.statusDanger
              }
              compact={compact}
            >
              {status.supported
                ? status.platform
                : `${status.platform} is not supported. Set PASEO_ZCODE_RUNTIME and PASEO_ZCODE_NODE instead.`}
            </Value>
          </SettingsRow>
          {status.override ? (
            <SettingsRow
              label="Environment override"
              hint="Unset both variables and restart the daemon to use the managed runtime."
            >
              <Value color={theme.colors.statusWarning} compact={compact}>
                PASEO_ZCODE_RUNTIME / PASEO_ZCODE_NODE are set, so sessions use
                them instead of this runtime.
              </Value>
            </SettingsRow>
          ) : null}
          <SettingsRow
            label="Progress"
            error={status.job.state === "failed" ? status.job.message : null}
          >
            <Value
              color={
                status.job.state === "failed"
                  ? theme.colors.statusDanger
                  : theme.colors.foregroundMuted
              }
              compact={compact}
            >
              {jobLabel(status.job)}
            </Value>
          </SettingsRow>
        </SettingsCard>
        {status.supported ? (
          <SettingsAction
            label={installed ? "Runtime installed" : "Install runtime"}
            hint={installed ? undefined : `Downloads ${megabytes(total)}`}
            actionLabel={
              running
                ? "Installing…"
                : installed
                  ? "Installed"
                  : "Download and install"
            }
            disabled={busy || installed}
            onPress={() => void run(() => install({}))}
          />
        ) : null}
      </SettingsSection>
      <Components status={status} theme={theme} compact={compact} />
      {status.loginCommand === undefined ? null : (
        <SettingsSection title="Sign in to ZCode">
          <SettingsCard>
            <SettingsRow label="Run it">
              <Value color={theme.colors.foreground} compact={compact}>
                In a terminal on the daemon machine
              </Value>
            </SettingsRow>
            <SettingsRow label="Authorization">
              <Value color={theme.colors.foreground} compact={compact}>
                Opens a browser; add --no-browser to print the URL
              </Value>
            </SettingsRow>
            {/* A full-width block: a row value would squeeze the label column. */}
            <View style={{ padding: compact ? 12 : 16 }}>
              <Text
                selectable
                style={{
                  color: theme.colors.foreground,
                  fontFamily: Platform.select({
                    ios: "Menlo",
                    default: "monospace",
                  }),
                  fontSize: compact ? 12 : 13,
                  lineHeight: 20,
                }}
              >
                {status.loginCommand}
              </Text>
            </View>
          </SettingsCard>
        </SettingsSection>
      )}
      <SettingsSection title="Remove">
        <SettingsAction
          label="Managed runtime"
          hint={
            removeMessage ??
            "Deletes the destination directory. Stop ZCode sessions first. ZCode settings, logins and conversations are kept."
          }
          actionLabel={confirmRemove ? "Confirm removal" : "Remove"}
          disabled={busy}
          onPress={() => {
            if (!confirmRemove) {
              setConfirmRemove(true);
              return;
            }
            setConfirmRemove(false);
            void run(async () => {
              const result = await remove({});
              setRemoveMessage(
                result.status === "removed"
                  ? "Removed."
                  : `Removal failed: ${result.message}`,
              );
            });
          }}
        />
      </SettingsSection>
      {requestError === null ? null : (
        <SettingsSection title="Last request">
          <Text
            accessibilityRole="alert"
            style={{
              color: theme.colors.statusDanger,
              fontSize: compact ? 13 : 14,
            }}
          >
            {requestError}
          </Text>
        </SettingsSection>
      )}
    </View>
  );
}
