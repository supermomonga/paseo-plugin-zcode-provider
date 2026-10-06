import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import {
  getPaseoClient,
  openExternalUrl,
  type PluginSurfaceProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  zcodeAccountChange,
  zcodeAccountView,
  type AccountChange,
  type AccountFamily,
  type AccountView,
  type ApiFormat,
  type CustomProvider,
  type ProviderTemplate,
  type ReadyAccountView,
  isHttpUrl,
} from "../shared/account";
import { Value } from "./value";

type Theme = PluginSurfaceProps["theme"];
type Run = (change: AccountChange) => Promise<AccountView | null>;
interface PartProps {
  readonly theme: Theme;
  readonly compact: boolean;
  readonly busy: boolean;
  readonly run: Run;
}

const FAMILIES: readonly { label: string; value: AccountFamily }[] = [
  { label: "Z.ai (international)", value: "zai" },
  { label: "BigModel (China)", value: "bigmodel" },
];
const API_FORMATS: readonly { label: string; value: ApiFormat }[] = [
  { label: "Anthropic messages (/messages)", value: "anthropic-messages" },
  {
    label: "Chat completions (/chat/completions)",
    value: "openai-chat-completions",
  },
  { label: "Responses (/responses)", value: "openai-responses" },
];
const CUSTOM = "custom";

const failure = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The account request failed.";

// openExternalUrl, copyText and getPaseoClient arrived in Paseo 0.9; 0.8
// hosts omit them.
async function openUrl(url: string): Promise<void> {
  if (typeof openExternalUrl === "function") await openExternalUrl(url);
  else await Linking.openURL(url);
}
const canCopy = typeof copyText === "function";

// Paseo caches provider catalogs, so new models would otherwise appear only
// after a manual refresh.
function refreshCatalog(serverId: string): void {
  if (typeof getPaseoClient !== "function") return;
  getPaseoClient(serverId)
    .providers.refresh({ providers: ["zcode"] })
    .catch(() => {});
}

function planStatus(plan: ReadyAccountView["plans"][number]): string {
  if (plan.availability === "available") return "Available";
  if (plan.availability === "pending") return "Checking…";
  switch (plan.unavailableReason) {
    case "not-entitled":
      return "No subscription";
    case "not-connected":
      return "Not selected";
    case "not-authenticated":
      return "Sign-in required";
    case "credential-failed":
      return "Could not verify the account";
  }
  return plan.availability === "unknown" ? "Unknown" : "Unavailable";
}

function providerStatus(provider: CustomProvider): string {
  if (!provider.enabled) return "Disabled";
  if (provider.issues.length > 0) return provider.issues.join(", ");
  if (!provider.executable)
    return provider.models.some((model) => model.enabled)
      ? "Not ready"
      : "Add a model to use it";
  return "Ready";
}

function modelHint(model: CustomProvider["models"][number]): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined)
    parts.push(
      model.contextWindow >= 1_000_000
        ? `${model.contextWindow / 1_000_000}M context`
        : `${Math.round(model.contextWindow / 1000)}K context`,
    );
  if (model.vision) parts.push("Vision");
  parts.push(model.builtin ? "From template" : "Added by you");
  return parts.join(" · ");
}

function Monospace({
  children,
  theme,
  compact,
}: {
  children: string;
  theme: Theme;
  compact: boolean;
}) {
  // A full-width block: a row value would squeeze the label column.
  return (
    <View style={{ padding: compact ? 12 : 16 }}>
      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
          fontSize: compact ? 12 : 13,
          lineHeight: 20,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

function Account({
  view,
  theme,
  compact,
  busy,
  run,
}: PartProps & { view: ReadyAccountView }) {
  const [family, setFamily] = useState<AccountFamily>("zai");
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { account, signIn } = view;
  const open = (url: string) => {
    setOpenError(null);
    openUrl(url).catch(() =>
      setOpenError("The browser could not be opened. Copy the link instead."),
    );
  };
  const start = async () => {
    const next = await run({ action: "signIn", family });
    if (next?.status === "ready" && next.signIn.state === "pending")
      open(next.signIn.authorizeUrl);
  };
  const region = FAMILIES.find(
    (entry) =>
      entry.value ===
      (account.state === "signed-out" ? undefined : account.family),
  )?.label;

  return (
    <SettingsSection title="ZCode account">
      <SettingsCard>
        <SettingsRow
          label="Status"
          hint="Shared with ZCode Desktop and the CLI on the daemon machine."
        >
          <Value
            color={
              account.state === "signed-in"
                ? theme.colors.statusSuccess
                : account.state === "reauthentication-required"
                  ? theme.colors.statusWarning
                  : theme.colors.foregroundMuted
            }
            compact={compact}
          >
            {account.state === "signed-in"
              ? `Signed in${account.displayName ? ` as ${account.displayName}` : ""}`
              : account.state === "reauthentication-required"
                ? "Session expired. Sign in again."
                : "Signed out"}
          </Value>
        </SettingsRow>
        {region === undefined ? null : (
          <SettingsRow label="Region">
            <Value color={theme.colors.foregroundMuted} compact={compact}>
              {region}
            </Value>
          </SettingsRow>
        )}
        {/* SettingsCard divides direct children, so rows are keyed arrays. */}
        {signIn.state === "pending" ? (
          [
            <SettingsRow
              key="waiting"
              label="Waiting for sign-in"
              hint="Finish in the browser on any device. The daemon receives the result; the link expires after five minutes."
              error={openError}
            />,
            <Monospace key="url" theme={theme} compact={compact}>
              {signIn.authorizeUrl}
            </Monospace>,
            <SettingsAction
              key="open"
              label="Sign-in page"
              actionLabel="Open"
              onPress={() => open(signIn.authorizeUrl)}
            />,
            canCopy ? (
              <SettingsAction
                key="copy"
                label="Sign-in link"
                actionLabel="Copy"
                onPress={() => void copyText(signIn.authorizeUrl)}
              />
            ) : null,
            <SettingsAction
              key="cancel"
              label="Cancel sign-in"
              actionLabel="Cancel"
              disabled={busy}
              onPress={() => void run({ action: "cancelSignIn" })}
            />,
          ]
        ) : account.state === "signed-in" ? (
          <SettingsAction
            label="Sign out"
            hint="New sessions can no longer use the account's plans."
            actionLabel={confirmSignOut ? "Confirm sign out" : "Sign out"}
            disabled={busy}
            onPress={() => {
              if (!confirmSignOut) {
                setConfirmSignOut(true);
                return;
              }
              setConfirmSignOut(false);
              void run({ action: "signOut" });
            }}
          />
        ) : (
          [
            <SettingsSelect<AccountFamily>
              key="region"
              label="Region"
              value={family}
              options={FAMILIES}
              onValueChange={setFamily}
              disabled={busy}
            />,
            <SettingsAction
              key="sign-in"
              label="Sign in"
              hint="Opens the sign-in page in your browser."
              error={signIn.state === "failed" ? signIn.message : null}
              actionLabel="Sign in"
              disabled={busy}
              onPress={() => void start()}
            />,
          ]
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function Plans({
  view,
  theme,
  compact,
}: {
  view: ReadyAccountView;
  theme: Theme;
  compact: boolean;
}) {
  if (view.account.state === "signed-out" || view.plans.length === 0)
    return null;
  return (
    <SettingsSection title="Plans">
      <SettingsCard>
        {view.plans.map((plan) => (
          <SettingsRow
            key={plan.providerId}
            label={plan.name}
            hint={plan.models.length > 0 ? plan.models.join(", ") : undefined}
          >
            <Value
              color={
                plan.availability === "available"
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted
              }
              compact={compact}
            >
              {planStatus(plan)}
            </Value>
          </SettingsRow>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function NewProvider({
  templates,
  existing,
  busy,
  run,
  onCreated,
}: PartProps & {
  templates: readonly ProviderTemplate[];
  existing: readonly CustomProvider[];
  onCreated: (providerId: string | null) => void;
}) {
  const [templateId, setTemplateId] = useState(CUSTOM);
  const template = templates.find((entry) => entry.templateId === templateId);
  const [apiFormat, setApiFormat] = useState<ApiFormat>(
    "openai-chat-completions",
  );
  const fields = useRef({ name: "", baseUrl: "", apiKey: "" });
  const [error, setError] = useState<string | null>(null);

  const choose = (id: string) => {
    const next = templates.find((entry) => entry.templateId === id);
    setTemplateId(id);
    setApiFormat(next?.apiFormat ?? "openai-chat-completions");
    fields.current = {
      name: next?.name ?? "",
      baseUrl: next?.baseUrl ?? "",
      apiKey: fields.current.apiKey,
    };
  };
  const create = async () => {
    const name = fields.current.name.trim();
    const baseUrl = fields.current.baseUrl.trim();
    const apiKey = fields.current.apiKey.trim();
    if (!name) return setError("Enter a name.");
    if (!isHttpUrl(baseUrl)) return setError("Enter an http(s) base URL.");
    if (!apiKey) return setError("Enter an API key.");
    setError(null);
    const next = await run({
      action: "createProvider",
      ...(template ? { templateId: template.templateId } : {}),
      name,
      apiFormat,
      baseUrl,
      apiKey,
    });
    if (next?.status !== "ready") return;
    const before = new Set(existing.map((entry) => entry.providerId));
    onCreated(
      next.providers.find((entry) => !before.has(entry.providerId))
        ?.providerId ?? null,
    );
  };

  return (
    <SettingsSection title="New provider">
      <SettingsCard>
        <SettingsSelect
          label="Template"
          hint="Templates fill in the endpoint and known models."
          value={templateId}
          options={[
            { label: "Custom", value: CUSTOM },
            ...templates.map((entry) => ({
              label: entry.name,
              value: entry.templateId,
            })),
          ]}
          onValueChange={choose}
          disabled={busy}
        />
        <SettingsInput
          key={`name-${templateId}`}
          label="Name"
          initialValue={template?.name ?? ""}
          placeholder="CommandCode"
          onChangeText={(text) => (fields.current.name = text)}
          disabled={busy}
        />
        <SettingsInput
          key={`url-${templateId}`}
          label="Base URL"
          initialValue={template?.baseUrl ?? ""}
          placeholder="https://api.example.com/v1"
          onChangeText={(text) => (fields.current.baseUrl = text)}
          disabled={busy}
        />
        <SettingsSelect<ApiFormat>
          label="API format"
          value={apiFormat}
          options={API_FORMATS}
          onValueChange={setApiFormat}
          disabled={busy}
        />
        <SettingsInput
          label="API key"
          hint="Stored by ZCode on the daemon machine. It is never shown again."
          secureTextEntry
          onChangeText={(text) => (fields.current.apiKey = text)}
          disabled={busy}
        />
        {template?.apiKeyManagementUrl ? (
          <SettingsAction
            label="Get an API key"
            hint={template.apiKeyManagementUrl}
            actionLabel="Open"
            onPress={() => void openUrl(template.apiKeyManagementUrl!)}
          />
        ) : null}
        <SettingsAction
          label="Create provider"
          hint={
            template
              ? "The template's models are added automatically."
              : "Add models after creating the provider."
          }
          error={error}
          actionLabel="Create"
          disabled={busy}
          onPress={() => void create()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ProviderEditor({
  provider,
  busy,
  run,
  onDeleted,
}: PartProps & { provider: CustomProvider; onDeleted: () => void }) {
  const fields = useRef({
    name: provider.name,
    baseUrl: provider.baseUrl ?? "",
    apiKey: "",
    modelId: "",
  });
  const [apiFormat, setApiFormat] = useState<ApiFormat>(
    provider.apiFormat ?? "openai-chat-completions",
  );
  // Remount counters that clear the API key and model inputs after success.
  const [keyInput, setKeyInput] = useState(0);
  const [modelInput, setModelInput] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const added = provider.models.filter((model) => !model.builtin);
  const [removal, setRemoval] = useState(added[0]?.modelId ?? "");
  const id = provider.providerId;

  const save = async () => {
    const name = fields.current.name.trim();
    const baseUrl = fields.current.baseUrl.trim();
    const apiKey = fields.current.apiKey.trim();
    if (!name) return setError("Enter a name.");
    if (!isHttpUrl(baseUrl)) return setError("Enter an http(s) base URL.");
    setError(null);
    const next = await run({
      action: "updateProvider",
      providerId: id,
      ...(name === provider.name ? {} : { name }),
      ...(baseUrl === (provider.baseUrl ?? "") ? {} : { baseUrl }),
      ...(apiFormat === provider.apiFormat ? {} : { apiFormat }),
      ...(apiKey ? { apiKey } : {}),
    });
    if (next === null) return;
    fields.current.apiKey = "";
    setKeyInput((value) => value + 1);
  };
  const addModel = async () => {
    const modelId = fields.current.modelId.trim();
    if (!modelId) return setModelError("Enter a model ID.");
    if (provider.models.some((model) => model.modelId === modelId))
      return setModelError("The model is already listed.");
    setModelError(null);
    if ((await run({ action: "addModel", providerId: id, modelId })) === null)
      return;
    fields.current.modelId = "";
    setRemoval((current) => current || modelId);
    setModelInput((value) => value + 1);
  };
  const removeModel = async () => {
    const next = await run({
      action: "deleteModel",
      providerId: id,
      modelId: removal,
    });
    if (next?.status !== "ready") return;
    const models =
      next.providers.find((entry) => entry.providerId === id)?.models ?? [];
    setRemoval(models.find((model) => !model.builtin)?.modelId ?? "");
  };

  return (
    <>
      <SettingsSection title={provider.name}>
        <SettingsCard>
          <SettingsSwitch
            label="Enabled"
            hint={providerStatus(provider)}
            value={provider.enabled}
            onValueChange={(enabled) =>
              void run({ action: "updateProvider", providerId: id, enabled })
            }
            disabled={busy}
          />
          <SettingsInput
            label="Name"
            initialValue={provider.name}
            onChangeText={(text) => (fields.current.name = text)}
            disabled={busy}
          />
          <SettingsInput
            label="Base URL"
            initialValue={provider.baseUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChangeText={(text) => (fields.current.baseUrl = text)}
            disabled={busy}
          />
          <SettingsSelect<ApiFormat>
            label="API format"
            value={apiFormat}
            options={API_FORMATS}
            onValueChange={setApiFormat}
            disabled={busy}
          />
          <SettingsInput
            key={`key-${keyInput}`}
            label="API key"
            hint={
              provider.apiKeySet
                ? "Saved. Enter a new key to replace it."
                : "Required."
            }
            placeholder={provider.apiKeySet ? "••••••••" : undefined}
            secureTextEntry
            onChangeText={(text) => (fields.current.apiKey = text)}
            disabled={busy}
          />
          {provider.apiKeyManagementUrl ? (
            <SettingsAction
              label="Get an API key"
              hint={provider.apiKeyManagementUrl}
              actionLabel="Open"
              onPress={() => void openUrl(provider.apiKeyManagementUrl!)}
            />
          ) : null}
          <SettingsAction
            label="Save changes"
            error={error}
            actionLabel="Save"
            disabled={busy}
            onPress={() => void save()}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Models">
        <SettingsCard>
          {provider.models.map((model) => (
            <SettingsSwitch
              key={model.modelId}
              label={model.modelId}
              hint={modelHint(model)}
              value={model.enabled}
              onValueChange={(enabled) =>
                void run({
                  action: "setModelEnabled",
                  providerId: id,
                  modelId: model.modelId,
                  enabled,
                })
              }
              disabled={busy}
            />
          ))}
          <SettingsInput
            key={`model-${modelInput}`}
            label="Model ID"
            hint="As the provider names it, e.g. deepseek/deepseek-v4.1-flash."
            onChangeText={(text) => (fields.current.modelId = text)}
            disabled={busy}
          />
          <SettingsAction
            label="Add model"
            hint="ZCode applies known settings for recognised models."
            error={modelError}
            actionLabel="Add"
            disabled={busy}
            onPress={() => void addModel()}
          />
          {added.length === 0
            ? null
            : [
                <SettingsSelect
                  key="removal"
                  label="Model to remove"
                  value={removal}
                  options={added.map((model) => ({
                    label: model.modelId,
                    value: model.modelId,
                  }))}
                  onValueChange={setRemoval}
                  disabled={busy}
                />,
                <SettingsAction
                  key="remove"
                  label="Remove model"
                  hint="Template models can only be turned off."
                  actionLabel="Remove"
                  disabled={busy || !removal}
                  onPress={() => void removeModel()}
                />,
              ]}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Delete provider">
        <SettingsAction
          label={provider.name}
          hint="Removes the provider, its API key and its models from ZCode."
          actionLabel={confirmDelete ? "Confirm deletion" : "Delete"}
          disabled={busy}
          onPress={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            setConfirmDelete(false);
            void run({ action: "deleteProvider", providerId: id }).then(
              (next) => {
                if (next !== null) onDeleted();
              },
            );
          }}
        />
      </SettingsSection>
    </>
  );
}

function Providers(props: PartProps & { view: ReadyAccountView }) {
  const { view } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const provider = view.providers.find((entry) => entry.providerId === editing);
  const toggle = (id: string) =>
    setEditing((current) => (current === id ? null : id));

  return (
    <>
      <SettingsSection title="Model providers">
        <SettingsCard>
          {view.providers.map((entry) => (
            <SettingsAction
              key={entry.providerId}
              label={entry.name}
              hint={`${providerStatus(entry)} · ${entry.models.filter((model) => model.enabled).length} of ${entry.models.length} models on`}
              actionLabel={editing === entry.providerId ? "Close" : "Edit"}
              onPress={() => toggle(entry.providerId)}
            />
          ))}
          <SettingsAction
            label="Add provider"
            hint="Use an API key from Z.ai, DeepSeek, OpenRouter or any compatible endpoint."
            actionLabel={editing === CUSTOM ? "Close" : "Add"}
            onPress={() => toggle(CUSTOM)}
          />
        </SettingsCard>
      </SettingsSection>
      {editing === CUSTOM ? (
        <NewProvider
          {...props}
          templates={view.templates}
          existing={view.providers}
          onCreated={setEditing}
        />
      ) : provider ? (
        <ProviderEditor
          {...props}
          key={provider.providerId}
          provider={provider}
          onDeleted={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

export function AccountTab({
  theme,
  layout,
  host,
  onOpenRuntime,
}: PluginSurfaceProps & { onOpenRuntime: () => void }) {
  const fetchView = useRpc(zcodeAccountView);
  const change = useRpc(zcodeAccountChange);
  const [view, setView] = useState<AccountView | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const compact = layout.compact;

  const refresh = useCallback(async () => {
    try {
      setView(await fetchView({}));
      setRequestError(null);
    } catch (cause) {
      setRequestError(failure(cause));
    }
  }, [fetchView]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const waiting = view?.status === "ready" && view.signIn.state === "pending";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  // Sign-in completes on the daemon; refresh models once it reports success.
  const wasWaiting = useRef(false);
  const signedIn =
    view?.status === "ready" && view.account.state === "signed-in";
  useEffect(() => {
    if (wasWaiting.current && !waiting && signedIn) refreshCatalog(host.id);
    wasWaiting.current = waiting;
  }, [waiting, signedIn, host.id]);

  const run = useCallback<Run>(
    async (input) => {
      setPending(true);
      try {
        const next = await change(input);
        setView(next);
        setRequestError(null);
        if (input.action !== "signIn" && input.action !== "cancelSignIn")
          refreshCatalog(host.id);
        return next;
      } catch (cause) {
        setRequestError(failure(cause));
        return null;
      } finally {
        setPending(false);
      }
    },
    [change, host.id],
  );

  const error =
    requestError === null ? null : (
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
    );

  if (view === null || view.status === "unavailable")
    return (
      <View style={{ gap: compact ? 16 : 24 }}>
        <SettingsSection title="ZCode account">
          <SettingsCard>
            <SettingsRow label="Status">
              <Value
                color={
                  view === null
                    ? theme.colors.foregroundMuted
                    : theme.colors.statusWarning
                }
                compact={compact}
              >
                {view === null
                  ? requestError === null
                    ? "Starting ZCode…"
                    : "ZCode could not be reached."
                  : view.message}
              </Value>
            </SettingsRow>
            {view?.code === "RUNTIME_SETUP_REQUIRED" ? (
              <SettingsAction
                label="ZCode runtime"
                hint="Install it before signing in or adding providers."
                actionLabel="Open Runtime"
                onPress={onOpenRuntime}
              />
            ) : view === null && requestError === null ? null : (
              <SettingsAction
                label="Retry"
                actionLabel="Retry"
                disabled={pending}
                onPress={() => void refresh()}
              />
            )}
          </SettingsCard>
        </SettingsSection>
        {error}
      </View>
    );

  const parts = { theme, compact, busy: pending, run };
  return (
    <View style={{ gap: compact ? 16 : 24 }}>
      <Account {...parts} view={view} />
      <Plans view={view} theme={theme} compact={compact} />
      <Providers {...parts} view={view} />
      {error}
    </View>
  );
}
