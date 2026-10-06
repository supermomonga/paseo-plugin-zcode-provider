import { z } from "zod";
import {
  accountChangeSchema,
  apiFormatSchema,
  planModeSchema,
  type AccountChange,
  type AccountFamily,
  type AccountView,
  type ReadyAccountView,
} from "../shared/account.js";
import { AdapterError } from "./errors.js";
import type { SettingsChannel } from "./host/bridge.js";
import { logger } from "./logger.js";

/** The official services this screen uses, on a ZCode Server it owns. */
export interface SettingsHost {
  invoke<Schema extends z.ZodType>(
    channel: SettingsChannel,
    method: string,
    args: readonly unknown[],
    resultSchema: Schema,
    timeoutMs?: number,
  ): Promise<z.output<Schema>>;
  onFailure(listener: (error: AdapterError) => void): () => void;
  close(): Promise<void>;
}

export interface AccountServiceOptions {
  /** Closes the Server after this long without requests or a pending sign-in. */
  readonly idleMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

// ZCode keeps one pending flow per Server process for at most five minutes.
const SIGN_IN_LIFETIME_MS = 5 * 60_000;
const record = z.record(z.string(), z.unknown());
const toApiFormat = (value: unknown) => {
  const parsed = apiFormatSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const nativeConfigSchema = z.object({
  group: z.string().nullish(),
  visibility: z.string().nullish(),
  access: z
    .object({
      type: z.string(),
      apiKey: z.string().nullish(),
      apiKeyManagementUrl: z.string().nullish(),
      mode: z.string().nullish(),
    })
    .nullish(),
  api: z
    .object({ type: z.string().nullish(), baseUrl: z.string().nullish() })
    .nullish(),
  builtinModelIds: z.array(z.string()).nullish(),
});
const nativeProviderSchema = z.object({
  providerId: z.string(),
  providerName: z.string().nullish(),
  templateId: z.string().nullish(),
  enabled: z.boolean(),
  executable: z.boolean(),
  accountState: z
    .object({
      availability: z.string(),
      entitled: z.boolean(),
      unavailableReason: z.string().nullish(),
    })
    .optional(),
  // Kept on the daemon only: it may contain the API key.
  personalConfig: record.optional(),
  effectiveConfig: nativeConfigSchema,
  issues: z.array(
    z.object({ code: z.string(), path: z.array(z.unknown()).optional() }),
  ),
  models: z.array(
    z.object({
      modelId: z.string(),
      enabled: z.boolean(),
      selectable: z.boolean(),
      builtin: z.boolean(),
      effectiveConfig: z
        .object({
          properties: z
            .object({
              contextWindow: z.number().optional(),
              inputFormat: z
                .object({ supportsImage: z.boolean().optional() })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});
const nativeViewSchema = z.object({
  providerTemplates: z.array(
    z.object({
      templateId: z.string(),
      templateNameMap: z.record(z.string(), z.string()),
      config: nativeConfigSchema,
    }),
  ),
  providers: z.array(nativeProviderSchema),
});
type NativeView = z.output<typeof nativeViewSchema>;
type NativeProvider = z.output<typeof nativeProviderSchema>;

const sessionStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authenticated"),
    userInfo: z.object({
      username: z.string().optional(),
      displayName: z.string().optional(),
    }),
  }),
  z.object({ status: z.literal("signed-out") }),
  z.object({ status: z.literal("reauthentication-required") }),
]);
const familySchema = z.enum(["zai", "bigmodel"]).nullable();
const accountSettingsSchema = z.object({
  providerFamilyDomain: z.string().optional(),
  providerFamilyConnectionSelections: record.optional(),
});
const startedSchema = z.object({
  authorizeUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:"),
});
const pollSchema = z
  .object({ kind: z.string(), provider: z.string().optional() })
  .nullable();

type SignIn = ReadyAccountView["signIn"];

function issueText(issue: NativeProvider["issues"][number]): string {
  const field = issue.path?.at(-1);
  if (issue.code === "required-field-missing") {
    if (field === "apiKey") return "API key is missing";
    if (field === "baseUrl" || field === "api") return "Base URL is missing";
  }
  return `ZCode reported ${issue.code}`;
}

const isCustom = (provider: NativeProvider) =>
  provider.effectiveConfig.group === "standard-personal";

function project(
  view: NativeView,
  account: ReadyAccountView["account"],
  family: AccountFamily | undefined,
  signIn: SignIn,
): ReadyAccountView {
  const visible = view.providers.filter(
    (provider) => provider.effectiveConfig.visibility !== "hidden",
  );
  return {
    status: "ready",
    account,
    signIn,
    plans:
      account.state === "signed-out" || family === undefined
        ? []
        : visible
            .filter(
              (provider) =>
                provider.effectiveConfig.group === `${family}-family` &&
                provider.effectiveConfig.access?.type === "zhipu-account",
            )
            .flatMap((provider) => {
              const mode = planModeSchema.safeParse(
                provider.effectiveConfig.access?.mode,
              );
              if (!mode.success) return [];
              return [
                {
                  providerId: provider.providerId,
                  name: provider.providerName ?? provider.providerId,
                  mode: mode.data,
                  availability:
                    provider.accountState?.availability ?? "unknown",
                  entitled: provider.accountState?.entitled ?? false,
                  ...(provider.accountState?.unavailableReason
                    ? {
                        unavailableReason:
                          provider.accountState.unavailableReason,
                      }
                    : {}),
                  models: provider.models
                    .filter((model) => model.selectable)
                    .map((model) => model.modelId),
                },
              ];
            }),
    providers: visible.filter(isCustom).map((provider) => {
      const { access, api } = provider.effectiveConfig;
      const format = toApiFormat(api?.type);
      return {
        providerId: provider.providerId,
        name: provider.providerName ?? provider.providerId,
        ...(provider.templateId ? { templateId: provider.templateId } : {}),
        enabled: provider.enabled,
        executable: provider.executable,
        ...(format ? { apiFormat: format } : {}),
        ...(api?.baseUrl ? { baseUrl: api.baseUrl } : {}),
        apiKeySet: Boolean(access?.apiKey?.trim()),
        ...(access?.apiKeyManagementUrl
          ? { apiKeyManagementUrl: access.apiKeyManagementUrl }
          : {}),
        issues: provider.issues.map(issueText),
        models: provider.models.map((model) => {
          const properties = model.effectiveConfig?.properties;
          return {
            modelId: model.modelId,
            enabled: model.enabled,
            selectable: model.selectable,
            builtin: model.builtin,
            ...(properties?.contextWindow === undefined
              ? {}
              : { contextWindow: properties.contextWindow }),
            vision: properties?.inputFormat?.supportsImage === true,
          };
        }),
      };
    }),
    templates: view.providerTemplates.map((template) => {
      const { access, api } = template.config;
      const format = toApiFormat(api?.type);
      return {
        templateId: template.templateId,
        name:
          template.templateNameMap["en-US"] ??
          template.templateNameMap["zh-CN"] ??
          template.templateId,
        ...(format ? { apiFormat: format } : {}),
        ...(api?.baseUrl ? { baseUrl: api.baseUrl } : {}),
        ...(access?.apiKeyManagementUrl
          ? { apiKeyManagementUrl: access.apiKeyManagementUrl }
          : {}),
      };
    }),
  };
}

/**
 * Account sign-in and model providers through the official ZCode services.
 * Desktop uses the same calls, so ZCode validates and stores everything: the
 * plugin keeps no credentials and never returns API keys to clients.
 */
export class AccountService {
  private host?: Promise<SettingsHost>;
  private active = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private signIn: SignIn = { state: "idle" };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(
    private readonly startHost: () => Promise<SettingsHost>,
    options: AccountServiceOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 60_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  view(): Promise<AccountView> {
    return this.run((host) => this.read(host));
  }

  async change(input: AccountChange): Promise<AccountView> {
    const change = accountChangeSchema.parse(input);
    return this.run(async (host) => {
      await this.apply(host, change);
      return this.read(host);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.pollTimer);
    const host = this.host;
    this.host = undefined;
    await host?.then((value) => value.close()).catch(() => {});
  }

  // Requests run one at a time so sign-in completion, sign-out and provider
  // edits cannot interleave on the shared Server.
  private run(
    operation: (host: SettingsHost) => Promise<AccountView>,
  ): Promise<AccountView> {
    const result = this.queue.then(async (): Promise<AccountView> => {
      if (this.closed)
        throw new AdapterError("NATIVE_EXITED", "ZCode settings are closed");
      this.active += 1;
      clearTimeout(this.idleTimer);
      try {
        let host: SettingsHost;
        try {
          host = await this.acquire();
        } catch (error) {
          logger.error("zcode.account.host.failed", error);
          return {
            status: "unavailable",
            code: error instanceof AdapterError ? error.code : "HOST_FAILED",
            message:
              error instanceof AdapterError
                ? error.message
                : "ZCode Server could not be started",
          };
        }
        return await operation(host);
      } finally {
        this.active -= 1;
        this.scheduleIdle();
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private acquire(): Promise<SettingsHost> {
    if (this.host) return this.host;
    const started = this.startHost().then((host) => {
      host.onFailure(() => this.drop(started));
      return host;
    });
    this.host = started;
    started.catch(() => {
      if (this.host === started) this.host = undefined;
    });
    return started;
  }

  private drop(host: Promise<SettingsHost>): void {
    if (this.host !== host) return;
    this.host = undefined;
    if (this.signIn.state === "pending") {
      clearTimeout(this.pollTimer);
      this.signIn = {
        state: "failed",
        message: "ZCode Server stopped during sign-in. Try again.",
      };
    }
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.closed || this.active > 0 || this.signIn.state === "pending")
      return;
    this.idleTimer = setTimeout(() => {
      if (this.active > 0 || this.signIn.state === "pending") return;
      const host = this.host;
      this.host = undefined;
      void host?.then((value) => value.close()).catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async read(host: SettingsHost): Promise<AccountView> {
    const [session, active, settings, view] = await Promise.all([
      host.invoke("oauth", "restoreCachedSessionState", [], sessionStateSchema),
      host.invoke("oauth", "getActiveProvider", [], familySchema),
      host.invoke("setting", "get", [], accountSettingsSchema),
      host.invoke("provider-settings", "getView", [], nativeViewSchema),
    ]);
    const domain = familySchema.safeParse(
      settings.providerFamilyDomain || null,
    );
    const family = (domain.success ? domain.data : null) ?? active ?? undefined;
    const account: ReadyAccountView["account"] =
      session.status === "signed-out"
        ? { state: "signed-out" }
        : {
            state:
              session.status === "authenticated"
                ? "signed-in"
                : "reauthentication-required",
            ...(family ? { family } : {}),
            ...(session.status === "authenticated" &&
            session.userInfo.displayName
              ? { displayName: session.userInfo.displayName }
              : {}),
            ...(session.status === "authenticated" && session.userInfo.username
              ? { username: session.userInfo.username }
              : {}),
          };
    return project(view, account, family, this.signIn);
  }

  private async apply(
    host: SettingsHost,
    change: z.output<typeof accountChangeSchema>,
  ): Promise<void> {
    switch (change.action) {
      case "signIn": {
        const started = await host.invoke(
          "oauth",
          "startOAuthWithPolling",
          [change.family],
          startedSchema,
        );
        this.signIn = {
          state: "pending",
          family: change.family,
          authorizeUrl: started.authorizeUrl,
          expiresAt: this.now() + SIGN_IN_LIFETIME_MS,
        };
        this.schedulePoll();
        return;
      }
      case "cancelSignIn":
        clearTimeout(this.pollTimer);
        this.signIn = { state: "idle" };
        await host.invoke("oauth", "cancelPending", [], z.unknown());
        return;
      case "signOut":
        clearTimeout(this.pollTimer);
        this.signIn = { state: "idle" };
        // Desktop's sign-out: the OAuth logout also removes derived plan keys.
        await host.invoke("oauth", "logout", [], z.unknown());
        await host.invoke(
          "setting",
          "update",
          [
            {
              providerFamilyDomain: "",
              providerFamilyDomainUpdatedAt: this.now(),
              providerFamilyDomainMigrated: true,
            },
          ],
          z.unknown(),
        );
        await this.refresh(host, "oauth-logout");
        return;
      case "createProvider":
        return this.createProvider(host, change);
      case "updateProvider": {
        const provider = await this.customProvider(host, change.providerId);
        await this.mutate(
          host,
          "savePersonalProviderOverlay",
          [
            provider.providerId,
            this.personalConfig(provider, change),
            {
              ...(change.name === undefined
                ? {}
                : { providerName: change.name }),
              ...(change.enabled === undefined
                ? {}
                : { enabled: change.enabled }),
            },
          ],
          z.unknown(),
        );
        return;
      }
      case "deleteProvider":
        await this.customProvider(host, change.providerId);
        await this.mutate(
          host,
          "deletePersonalProvider",
          [change.providerId],
          z.unknown(),
        );
        return;
      case "addModel":
        await this.customProvider(host, change.providerId);
        await this.mutate(
          host,
          "addPersonalModel",
          [change.providerId, change.modelId, {}],
          z.unknown(),
        );
        return;
      case "deleteModel":
        await this.customProvider(host, change.providerId);
        await this.mutate(
          host,
          "deletePersonalModel",
          [change.providerId, change.modelId],
          z.unknown(),
        );
        return;
      case "setModelEnabled":
        await this.customProvider(host, change.providerId);
        await this.mutate(
          host,
          "setPersonalModelEnabled",
          [change.providerId, change.modelId, change.enabled],
          z.unknown(),
        );
        return;
    }
  }

  private async createProvider(
    host: SettingsHost,
    change: Extract<
      z.output<typeof accountChangeSchema>,
      { action: "createProvider" }
    >,
  ): Promise<void> {
    if (change.templateId !== undefined) {
      const view = await host.invoke(
        "provider-settings",
        "getView",
        [],
        nativeViewSchema,
      );
      if (
        !view.providerTemplates.some(
          (template) => template.templateId === change.templateId,
        )
      )
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "Unknown provider template",
        );
    }
    const created = await this.mutate(
      host,
      "createPersonalProvider",
      [
        {
          ...(change.templateId ? { templateId: change.templateId } : {}),
          providerName: change.name,
          locale: "en-US",
        },
      ],
      z.object({ providerId: z.string(), view: nativeViewSchema }),
    );
    const provider = created.view.providers.find(
      (entry) => entry.providerId === created.providerId,
    );
    try {
      if (!provider)
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "ZCode did not return the new provider",
        );
      await this.mutate(
        host,
        "savePersonalProviderOverlay",
        [
          created.providerId,
          this.personalConfig(provider, change),
          { providerName: change.name },
        ],
        z.unknown(),
      );
    } catch (error) {
      // Do not leave an unusable entry behind when ZCode rejects the details.
      await host
        .invoke(
          "provider-settings",
          "deletePersonalProvider",
          [created.providerId],
          z.unknown(),
        )
        .catch(() => {});
      throw error;
    }
  }

  // Applies only the edited leaves to the stored personal rule, as Desktop
  // does, so hidden headers and inherited template values are preserved.
  private personalConfig(
    provider: NativeProvider,
    change: {
      apiFormat?: string;
      baseUrl?: string;
      apiKey?: string;
    },
  ): Record<string, unknown> {
    const personal = { ...provider.personalConfig };
    const effective = provider.effectiveConfig;
    if (change.apiKey !== undefined) {
      personal.access = {
        ...record.catch({}).parse(personal.access ?? {}),
        type: effective.access?.type ?? "api-key",
        apiKey: change.apiKey,
      };
    }
    const typeChanged =
      change.apiFormat !== undefined &&
      change.apiFormat !== (effective.api?.type ?? undefined);
    const urlChanged =
      change.baseUrl !== undefined &&
      change.baseUrl !== (effective.api?.baseUrl ?? undefined);
    if (typeChanged || urlChanged) {
      personal.api = {
        ...record.catch({}).parse(personal.api ?? {}),
        ...(typeChanged || !effective.api?.type
          ? { type: change.apiFormat }
          : {}),
        ...(urlChanged ? { baseUrl: change.baseUrl } : {}),
      };
    }
    return personal;
  }

  private async customProvider(
    host: SettingsHost,
    providerId: string,
  ): Promise<NativeProvider> {
    const view = await host.invoke(
      "provider-settings",
      "getView",
      [],
      nativeViewSchema,
    );
    const provider = view.providers.find(
      (entry) => entry.providerId === providerId,
    );
    // Account plans are managed by sign-in; their access cannot be edited.
    if (!provider || !isCustom(provider))
      throw new AdapterError("INVALID_CONFIGURATION", "Unknown model provider");
    return provider;
  }

  private async mutate<Schema extends z.ZodType>(
    host: SettingsHost,
    method: string,
    args: readonly unknown[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    try {
      return await host.invoke("provider-settings", method, args, schema);
    } catch (error) {
      logger.error("zcode.account.provider.failed", error);
      // ZCode's validation messages may echo the submitted values.
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode rejected the provider settings. Check the base URL, API format and API key.",
        {},
        { cause: error },
      );
    }
  }

  private async refresh(host: SettingsHost, reason: string): Promise<void> {
    await host.invoke(
      "provider-settings",
      "refresh",
      [reason],
      z.unknown(),
      60_000,
    );
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      const pending = this.signIn;
      if (pending.state !== "pending" || this.closed) return;
      const step = this.queue.then(() => this.poll(pending));
      this.queue = step.catch(() => {});
    }, this.pollMs);
    this.pollTimer.unref?.();
  }

  // The daemon, not the browser, receives the result: the sign-in page can be
  // opened on any device, including one other than the daemon machine.
  private async poll(pending: Extract<SignIn, { state: "pending" }>) {
    if (this.signIn !== pending || this.closed) return;
    const fail = (message: string) => {
      if (this.signIn === pending) this.signIn = { state: "failed", message };
      this.scheduleIdle();
    };
    let host: SettingsHost;
    try {
      if (!this.host) throw new Error("ZCode Server stopped");
      host = await this.host;
    } catch {
      return fail("ZCode Server stopped during sign-in. Try again.");
    }
    let result: z.output<typeof pollSchema>;
    try {
      result = await host.invoke("oauth", "pollPendingOAuth", [], pollSchema);
    } catch (error) {
      logger.error("zcode.account.signin.failed", error);
      return fail("Sign-in was not completed. Try again.");
    }
    if (result?.kind === "session" || result?.kind === "duplicate") {
      try {
        await this.completeSignIn(host, pending.family);
      } catch (error) {
        logger.error("zcode.account.signin.settings.failed", error);
        return fail("Signed in, but ZCode could not switch to the account.");
      }
      if (this.signIn === pending) this.signIn = { state: "idle" };
      this.scheduleIdle();
      return;
    }
    if (this.now() >= pending.expiresAt) {
      await host
        .invoke("oauth", "cancelPending", [], z.unknown())
        .catch(() => {});
      return fail("Sign-in timed out. Try again.");
    }
    if (this.signIn === pending) this.schedulePoll();
  }

  // Desktop's completion: select the signed-in family and its individual
  // Coding Plan unless a plan is already chosen, then refresh entitlements.
  // Without the family the Server does not offer the account's models.
  private async completeSignIn(
    host: SettingsHost,
    family: AccountFamily,
  ): Promise<void> {
    const settings = await host.invoke(
      "setting",
      "get",
      [],
      accountSettingsSchema,
    );
    const selections = settings.providerFamilyConnectionSelections ?? {};
    await host.invoke(
      "setting",
      "update",
      [
        {
          providerFamilyDomain: family,
          providerFamilyDomainUpdatedAt: this.now(),
          providerFamilyDomainMigrated: true,
          providerFamilyConnectionSelections: {
            ...selections,
            [family]: selections[family] ?? { kind: "individual-coding-plan" },
          },
        },
      ],
      z.unknown(),
    );
    await this.refresh(host, "oauth-login-entitlement");
  }
}
