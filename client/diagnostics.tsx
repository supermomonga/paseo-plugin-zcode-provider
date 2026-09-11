import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import {
  zcodeDiagnostics,
  type DiagnosticsResult,
} from "../shared/diagnostics";

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

function Installation({ result, theme, compact }: SectionProps) {
  const source =
    result.installRootSource === "environment"
      ? "PASEO_ZCODE_INSTALL"
      : "Default location";
  return (
    <SettingsSection title="ZCode installation">
      <SettingsCard>
        <SettingsRow label="Install root" hint={`Source: ${source}`}>
          <Value color={theme.colors.foreground} compact={compact}>
            {result.installRoot}
          </Value>
        </SettingsRow>
        <SettingsRow label="Platform">
          <Value color={theme.colors.foreground} compact={compact}>
            {result.platform}
          </Value>
        </SettingsRow>
        <SettingsRow label="ZCode app version">
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.appVersion ?? "Not reported"}
          </Value>
        </SettingsRow>
        <SettingsRow label="Bundled CLI version">
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.cliVersion ?? "Not reported"}
          </Value>
        </SettingsRow>
        <SettingsRow label="Provider plugin version">
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.providerVersion}
          </Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function Compatibility({ result, theme, compact }: SectionProps) {
  const supported = result.compatibility === "supported";
  return (
    <SettingsSection title="Compatibility">
      <SettingsCard>
        <SettingsRow label="Status">
          <Value
            color={
              supported ? theme.colors.statusSuccess : theme.colors.statusDanger
            }
            compact={compact}
          >
            {supported ? "Supported" : "Unsupported"}
          </Value>
        </SettingsRow>
        <SettingsRow label="Reason">
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.compatibilityReason}
          </Value>
        </SettingsRow>
        <SettingsRow
          label="Verified release fingerprint"
          hint="A difference is investigation evidence, not a startup restriction."
        >
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.artifactMatch === undefined
              ? "Not inspected"
              : result.artifactMatch
                ? "Matches"
                : "Differs"}
          </Value>
        </SettingsRow>
        <SettingsRow label="Install root permissions">
          <Value color={theme.colors.foregroundMuted} compact={compact}>
            {result.writableInstallRoot ? "Writable" : "Read-only"}
          </Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function HostCheck({
  result,
  busy,
  onRun,
  theme,
  compact,
}: SectionProps & { busy: boolean; onRun(): void }) {
  const smoke = result.smoke;
  return (
    <SettingsSection title="Host check">
      <SettingsCard>
        <SettingsRow
          label="Result"
          hint="Runs the bundled version and doctor commands."
        >
          <Value
            color={
              smoke === undefined
                ? theme.colors.foregroundMuted
                : smoke.passed
                  ? theme.colors.statusSuccess
                  : theme.colors.statusDanger
            }
            compact={compact}
          >
            {smoke === undefined
              ? "Not run"
              : smoke.passed
                ? "Passed"
                : "Failed"}
          </Value>
        </SettingsRow>
        {smoke === undefined ? null : (
          <>
            <SettingsRow label="Doctor command">
              <Value color={theme.colors.foregroundMuted} compact={compact}>
                {smoke.doctorPassed ? "Passed" : "Failed"}
              </Value>
            </SettingsRow>
            <SettingsRow
              label="Authentication"
              hint="This check does not verify credentials."
            >
              <Value color={theme.colors.foregroundMuted} compact={compact}>
                {smoke.authentication === "present"
                  ? "Detected"
                  : smoke.authentication === "missing"
                    ? "Missing"
                    : "Not determined"}
              </Value>
            </SettingsRow>
            {smoke.error === undefined ? null : (
              <SettingsRow label="Error">
                <Value color={theme.colors.statusDanger} compact={compact}>
                  {smoke.error}
                </Value>
              </SettingsRow>
            )}
          </>
        )}
      </SettingsCard>
      <SettingsAction
        label="Bundled CLI"
        actionLabel={busy ? "Checking…" : "Run host check"}
        disabled={busy}
        onPress={onRun}
      />
    </SettingsSection>
  );
}

function SessionStorage({ result, theme, compact }: SectionProps) {
  return (
    <SettingsSection title="Session storage">
      <SettingsCard>
        <SettingsRow
          label="Resume mapping directory"
          hint="Stores identifiers and workspace paths, not message contents."
        >
          <Value color={theme.colors.foreground} compact={compact}>
            {result.sessionsDirectory}
          </Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

interface SectionProps {
  result: Extract<DiagnosticsResult, { status: "ready" }>;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}

function ReadyView({
  result,
  busy,
  onCheck,
  onSmoke,
  theme,
  compact,
}: {
  result: Extract<DiagnosticsResult, { status: "ready" }>;
  busy: boolean;
  onCheck(): void;
  onSmoke(): void;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  return (
    <View style={{ gap: compact ? 16 : 24 }}>
      <Installation result={result} theme={theme} compact={compact} />
      <Compatibility result={result} theme={theme} compact={compact} />
      <HostCheck
        result={result}
        busy={busy}
        onRun={onSmoke}
        theme={theme}
        compact={compact}
      />
      <SessionStorage result={result} theme={theme} compact={compact} />
      <SettingsSection title="Detection">
        <SettingsAction
          label="Installed ZCode"
          actionLabel={busy ? "Checking…" : "Check again"}
          disabled={busy}
          onPress={onCheck}
        />
      </SettingsSection>
    </View>
  );
}

function FailedView({
  result,
  busy,
  onCheck,
  theme,
  compact,
}: {
  result: Extract<DiagnosticsResult, { status: "failed" }>;
  busy: boolean;
  onCheck(): void;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  return (
    <View style={{ gap: compact ? 16 : 24 }}>
      <SettingsSection title="ZCode diagnostics">
        <SettingsCard>
          <SettingsRow label="Result">
            <Value color={theme.colors.statusDanger} compact={compact}>
              Failed
            </Value>
          </SettingsRow>
          <SettingsRow label="Error code">
            <Value color={theme.colors.foreground} compact={compact}>
              {result.code}
            </Value>
          </SettingsRow>
          <SettingsRow label="Message">
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {result.message}
            </Value>
          </SettingsRow>
          <SettingsRow
            label="Diagnostic report"
            hint="Safe to attach to a GitHub issue; credentials, prompts, and raw native errors are excluded."
          >
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {result.diagnostic}
            </Value>
          </SettingsRow>
          <SettingsRow label="Provider plugin version">
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {result.providerVersion}
            </Value>
          </SettingsRow>
        </SettingsCard>
        <SettingsAction
          label="Installed ZCode"
          actionLabel={busy ? "Checking…" : "Check again"}
          disabled={busy}
          onPress={onCheck}
        />
      </SettingsSection>
    </View>
  );
}

export function DiagnosticsScreen({ theme, layout }: PluginSurfaceProps) {
  const run = useRpc(zcodeDiagnostics);
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const check = useCallback(
    async (smoke: boolean) => {
      setBusy(true);
      try {
        setResult(await run({ smoke }));
        setRequestError(null);
      } catch (cause) {
        setRequestError(
          cause instanceof Error
            ? cause.message
            : "The diagnostics request failed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [run],
  );

  useEffect(() => {
    void check(false);
  }, [check]);

  if (result === null) {
    return (
      <SettingsSection title="ZCode diagnostics">
        <SettingsCard>
          <SettingsRow label="Status">
            <Value
              color={theme.colors.foregroundMuted}
              compact={layout.compact}
            >
              {requestError ?? "Checking the ZCode installation…"}
            </Value>
          </SettingsRow>
        </SettingsCard>
        {requestError === null ? null : (
          <SettingsAction
            label="Diagnostics request"
            actionLabel={busy ? "Checking…" : "Try again"}
            disabled={busy}
            onPress={() => void check(false)}
          />
        )}
      </SettingsSection>
    );
  }

  const props = {
    busy,
    onCheck: () => void check(false),
    onSmoke: () => void check(true),
    theme,
    compact: layout.compact,
  };
  return result.status === "ready" ? (
    <>
      <ReadyView result={result} {...props} />
      {requestError === null ? null : (
        <RequestError
          message={requestError}
          theme={theme}
          compact={layout.compact}
        />
      )}
    </>
  ) : (
    <FailedView result={result} {...props} />
  );
}

function RequestError({
  message,
  theme,
  compact,
}: {
  message: string;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  return (
    <SettingsSection title="Last request">
      <Text
        accessibilityRole="alert"
        style={{
          color: theme.colors.statusDanger,
          fontSize: compact ? 13 : 14,
        }}
      >
        {message}
      </Text>
    </SettingsSection>
  );
}
