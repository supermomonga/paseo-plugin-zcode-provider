import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { AccountService, type SettingsHost } from "./account.js";
import { AdapterError } from "./errors.js";

type Handler = (...args: unknown[]) => unknown;

const accountProvider = (
  providerId: string,
  group: string,
  mode: string,
  availability = "available",
) => ({
  providerId,
  providerName: providerId,
  enabled: true,
  executable: availability === "available",
  accountState: { availability, entitled: availability === "available" },
  effectiveConfig: {
    group,
    access: { type: "zhipu-account", accountType: "zai", mode },
    api: { type: "anthropic-messages", baseUrl: "https://api.z.ai" },
  },
  issues: [],
  models: [
    { modelId: "GLM-5.3", enabled: true, selectable: true, builtin: true },
  ],
});

const customProvider = {
  providerId: "command-code",
  providerName: "CommandCode",
  enabled: true,
  executable: true,
  personalConfig: {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "sk-secret" },
    api: {
      type: "openai-chat-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      headers: { "X-Team": "a" },
    },
    personalModelIds: ["deepseek/deepseek-v4.1-flash"],
  },
  effectiveConfig: {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "sk-secret" },
    api: {
      type: "openai-chat-completions",
      baseUrl: "https://api.commandcode.ai/provider/v1",
    },
  },
  issues: [],
  models: [
    {
      modelId: "deepseek/deepseek-v4.1-flash",
      enabled: true,
      selectable: true,
      builtin: false,
      effectiveConfig: {
        properties: {
          contextWindow: 1_000_000,
          inputFormat: { supportsImage: true },
        },
      },
    },
  ],
};

function nativeView(providers: unknown[] = []) {
  return {
    revision: 1,
    providerOrder: [],
    providerTemplates: [
      {
        templateId: "deepseek",
        templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
        config: {
          access: {
            type: "api-key",
            apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.deepseek.com/anthropic",
          },
        },
      },
    ],
    providers: [
      accountProvider(
        "account:zai-individual-coding-plan",
        "zai-family",
        "individual-coding-plan",
      ),
      accountProvider(
        "account:zai-start-plan",
        "zai-family",
        "start-plan",
        "unavailable",
      ),
      accountProvider(
        "account:bigmodel-start-plan",
        "bigmodel-family",
        "start-plan",
      ),
      ...providers,
    ],
  };
}

class FakeHost implements SettingsHost {
  diagnostic = { appVersion: "3.18.2" };
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly failures = new Set<(error: AdapterError) => void>();
  closed = 0;
  settings: Record<string, unknown> = {};
  session: unknown = { status: "signed-out" };
  /** The account's plan families, which ZCode 3.18 reports after sign-in. */
  families: string[] = ["zai"];
  oauthProviders = [
    { id: "zai", displayName: "Z.ai", enabled: true, order: 0 },
    { id: "bigmodel", displayName: "BigModel", enabled: true, order: 1 },
    { id: "zai_cn", displayName: "Z.ai (CN)", enabled: true, order: 2 },
  ];
  view = nativeView([customProvider]);
  readonly handlers: Record<string, Handler> = {
    "oauth.restoreCachedSessionState": () => this.session,
    "oauth.getActiveProvider": () => null,
    "oauth.getProviders": () => this.oauthProviders,
    "oauth.getAccountAvailability": () => ({
      loginProvider: "zai",
      userId: "1",
      sessionRevision: "r",
      families: this.families,
    }),
    "oauth.startOAuthWithPolling": (provider) => ({
      provider,
      authorizeUrl: "https://chat.z.ai/api/oauth/authorize?state=s",
      state: "s",
    }),
    "oauth.pollPendingOAuth": () => null,
    "oauth.cancelPending": () => undefined,
    "oauth.logout": () => undefined,
    "setting.get": () => this.settings,
    // ZCode 3.16's settingService: writing the connection selections needs
    // the settings the caller read, and fails if they changed since.
    "setting.update": (patch, expected) => {
      if (
        Object.hasOwn(patch as object, "providerFamilyConnectionSelections")
      ) {
        const cas = expected as Record<string, unknown> | undefined;
        if (cas?.providerFamilyDomainUpdatedAt === undefined)
          throw new Error("Account connection CAS required");
        if (
          this.settings.providerFamilyDomain !== cas.providerFamilyDomain ||
          (this.settings.providerFamilyDomainUpdatedAt ?? 0) !==
            cas.providerFamilyDomainUpdatedAt ||
          JSON.stringify(
            this.settings.providerFamilyConnectionSelections ?? {},
          ) !== JSON.stringify(cas.providerFamilyConnectionSelections ?? {})
        )
          throw new Error("Account connection settings changed");
      }
      this.settings = { ...this.settings, ...(patch as object) };
    },
    "provider-settings.getView": () => this.view,
    "provider-settings.refresh": () => this.view,
    "provider-settings.savePersonalProviderOverlay": () => this.view,
    "provider-settings.deletePersonalProvider": () => this.view,
    "provider-settings.addPersonalModel": () => this.view,
  };

  async invoke<Schema extends z.ZodType>(
    channel: string,
    method: string,
    args: readonly unknown[],
    resultSchema: Schema,
  ): Promise<z.output<Schema>> {
    const name = `${channel}.${method}`;
    this.calls.push({ method: name, args: [...args] });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Unexpected ${name}`);
    return resultSchema.parse(await handler(...args));
  }
  onFailure(listener: (error: AdapterError) => void) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }
  async close() {
    this.closed += 1;
  }
  called(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
  fail() {
    for (const listener of this.failures)
      listener(new AdapterError("NATIVE_EXITED", "ZCode Server exited"));
  }
}

function service(host = new FakeHost(), options = {}) {
  const account = new AccountService(async () => host, {
    idleMs: 60_000,
    pollMs: 1,
    ...options,
  });
  return { host, account };
}

async function ready(promise: ReturnType<AccountService["view"]>) {
  const view = await promise;
  if (view.status !== "ready") throw new Error(view.message);
  return view;
}

describe("account view", () => {
  it("shows only the signed-in family's plans and never returns API keys", async () => {
    const { host, account } = service();
    host.session = {
      status: "authenticated",
      userInfo: { id: "1", username: "momo", displayName: "Momo" },
    };
    host.settings = { providerFamilyDomain: "zai" };
    const view = await ready(account.view());
    expect(view.account).toEqual({
      state: "signed-in",
      family: "zai",
      displayName: "Momo",
      username: "momo",
    });
    expect(
      view.plans.map((plan) => [plan.providerId, plan.availability]),
    ).toEqual([
      ["account:zai-individual-coding-plan", "available"],
      ["account:zai-start-plan", "unavailable"],
    ]);
    expect(view.providers).toEqual([
      {
        providerId: "command-code",
        name: "CommandCode",
        enabled: true,
        executable: true,
        apiFormat: "openai-chat-completions",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKeySet: true,
        issues: [],
        models: [
          {
            modelId: "deepseek/deepseek-v4.1-flash",
            enabled: true,
            selectable: true,
            builtin: false,
            contextWindow: 1_000_000,
            vision: true,
          },
        ],
      },
    ]);
    expect(view.templates).toEqual([
      {
        templateId: "deepseek",
        name: "DeepSeek",
        apiFormat: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("sk-secret");
    await account.close();
  });

  it("reports why ZCode cannot start instead of throwing", async () => {
    const account = new AccountService(async () => {
      throw new AdapterError(
        "RUNTIME_SETUP_REQUIRED",
        "ZCode runtime is not set up.",
      );
    });
    expect(await account.view()).toEqual({
      status: "unavailable",
      code: "RUNTIME_SETUP_REQUIRED",
      message: "ZCode runtime is not set up.",
    });
  });

  it("closes the idle Server and starts a new one on demand", async () => {
    const hosts: FakeHost[] = [];
    const account = new AccountService(
      async () => {
        hosts.push(new FakeHost());
        return hosts.at(-1)!;
      },
      { idleMs: 1 },
    );
    await ready(account.view());
    await vi.waitFor(() => expect(hosts[0]!.closed).toBe(1));
    await ready(account.view());
    expect(hosts).toHaveLength(2);
    await account.close();
  });
});

describe("sign-in", () => {
  it("polls on the daemon and selects the account family when it completes", async () => {
    const { host, account } = service();
    let polls = 0;
    host.settings = {
      providerFamilyConnectionSelections: {
        bigmodel: { kind: "team-coding-plan" },
      },
    };
    host.handlers["oauth.pollPendingOAuth"] = () =>
      ++polls < 3 ? null : { kind: "session", provider: "zai" };
    const started = await ready(
      account.change({ action: "signIn", provider: "zai" }),
    );
    expect(started.signIn).toMatchObject({
      state: "pending",
      provider: "zai",
      authorizeUrl: "https://chat.z.ai/api/oauth/authorize?state=s",
    });
    await vi.waitFor(async () =>
      expect((await ready(account.view())).signIn.state).toBe("idle"),
    );
    expect(host.settings).toMatchObject({
      providerFamilyDomain: "zai",
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "team-coding-plan" },
      },
    });
    expect(host.called("provider-settings.refresh")[0]!.args).toEqual([
      "oauth-login-entitlement",
    ]);
    await account.close();
  });

  it("keeps a plan the user already chose for that family", async () => {
    const { host, account } = service();
    const team = {
      kind: "team-coding-plan",
      productId: "p",
      organizationId: "o",
      projectId: "j",
    };
    host.settings = { providerFamilyConnectionSelections: { zai: team } };
    host.handlers["oauth.pollPendingOAuth"] = () => ({
      kind: "duplicate",
      provider: "zai",
    });
    await account.change({ action: "signIn", provider: "zai" });
    await vi.waitFor(() =>
      expect(host.settings.providerFamilyDomain).toBe("zai"),
    );
    expect(host.settings.providerFamilyConnectionSelections).toEqual({
      zai: team,
    });
    await account.close();
  });

  it("reports a failed switch when the account settings changed meanwhile", async () => {
    const { host, account } = service();
    host.settings = {
      providerFamilyDomain: "bigmodel",
      providerFamilyDomainUpdatedAt: 5,
    };
    host.families = ["zai", "bigmodel"];
    const get = host.handlers["setting.get"]!;
    host.handlers["setting.get"] = () => {
      const read = structuredClone(get());
      // Another ZCode window switches the family after the plugin's read.
      host.settings = {
        ...host.settings,
        providerFamilyDomainUpdatedAt:
          (host.settings.providerFamilyDomainUpdatedAt as number) + 1,
      };
      return read;
    };
    host.handlers["oauth.pollPendingOAuth"] = () => ({
      kind: "session",
      provider: "zai",
    });
    await account.change({ action: "signIn", provider: "zai" });
    await vi.waitFor(async () =>
      expect((await ready(account.view())).signIn).toMatchObject({
        state: "failed",
        message: "Signed in, but ZCode could not switch to the account.",
      }),
    );
    expect(host.settings.providerFamilyDomain).toBe("bigmodel");
    await account.close();
  });

  // ZCode 3.18's single sign-in: the region picks the OAuth provider.
  it("offers Desktop's single Z.ai sign-in with a region from ZCode 3.18", async () => {
    const { host, account } = service();
    expect((await ready(account.view())).signInOptions).toEqual([
      { provider: "zai", label: "Global" },
      { provider: "zai_cn", label: "China mainland" },
    ]);
    // A runtime without zai_cn offers Z.ai or BigModel, as Desktop did.
    host.oauthProviders = host.oauthProviders.filter((p) => p.id !== "zai_cn");
    expect((await ready(account.view())).signInOptions).toEqual([
      { provider: "zai", label: "Z.ai (international)" },
      { provider: "bigmodel", label: "BigModel (China)" },
    ]);
    // Only what the runtime offers can be started.
    await expect(
      account.change({ action: "signIn", provider: "zai_cn" }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(host.called("oauth.startOAuthWithPolling")).toEqual([]);
    await account.close();
  });

  it("shows an account signed in through Z.ai in China", async () => {
    const { host, account } = service();
    host.session = {
      status: "authenticated",
      userInfo: { id: "1", displayName: "Momo" },
    };
    host.handlers["oauth.getActiveProvider"] = () => "zai_cn";
    // zai_cn is no plan family; the account's family is the chosen one.
    expect((await ready(account.view())).account).toEqual({
      state: "signed-in",
      loginProvider: "zai_cn",
      displayName: "Momo",
    });
    host.settings = { providerFamilyDomain: "bigmodel" };
    const view = await ready(account.view());
    expect(view.account).toMatchObject({ family: "bigmodel" });
    expect(view.plans.map((p) => p.providerId)).toEqual([
      "account:bigmodel-start-plan",
    ]);
    await account.close();
  });

  it("selects the family the account has after a China sign-in", async () => {
    const { host, account } = service();
    host.families = ["bigmodel"];
    host.handlers["oauth.pollPendingOAuth"] = () => ({
      kind: "session",
      provider: "zai_cn",
    });
    await account.change({ action: "signIn", provider: "zai_cn" });
    await vi.waitFor(() =>
      expect(host.settings).toMatchObject({
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      }),
    );
    expect(host.called("oauth.startOAuthWithPolling")[0]!.args).toEqual([
      "zai_cn",
    ]);
    await account.close();
  });

  it("selects nothing for an account without a plan family", async () => {
    const { host, account } = service();
    // A China sign-in that is not linked to BigModel.
    host.families = [];
    host.handlers["oauth.pollPendingOAuth"] = () => ({
      kind: "session",
      provider: "zai_cn",
    });
    await account.change({ action: "signIn", provider: "zai_cn" });
    await vi.waitFor(async () =>
      expect((await ready(account.view())).signIn.state).toBe("idle"),
    );
    expect(host.called("setting.update")).toEqual([]);
    expect(host.called("provider-settings.refresh")).toHaveLength(1);
    await account.close();
  });

  it("keeps the chosen family on ZCode 3.18 and switches to the sign-in's before", async () => {
    for (const [appVersion, expected] of [
      ["3.18.2", "bigmodel"],
      ["4.0.0", "bigmodel"],
      ["3.17.2", "zai"],
    ] as const) {
      const { host, account } = service();
      host.diagnostic = { appVersion };
      host.families = ["zai", "bigmodel"];
      host.settings = {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      };
      host.handlers["oauth.pollPendingOAuth"] = () => ({
        kind: "session",
        provider: "zai",
      });
      await account.change({ action: "signIn", provider: "zai" });
      await vi.waitFor(async () =>
        expect((await ready(account.view())).signIn.state).toBe("idle"),
      );
      expect(host.settings.providerFamilyDomain).toBe(expected);
      await account.close();
    }
  });

  it("times out, cancels the native flow and keeps the Server until then", async () => {
    let now = 0;
    const { host, account } = service(new FakeHost(), {
      idleMs: 1,
      now: () => now,
    });
    await account.change({ action: "signIn", provider: "zai_cn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.closed).toBe(0);
    now = 5 * 60_000;
    await vi.waitFor(async () =>
      expect((await ready(account.view())).signIn).toEqual({
        state: "failed",
        message: "Sign-in timed out. Try again.",
      }),
    );
    expect(host.called("oauth.cancelPending")).toHaveLength(1);
    await vi.waitFor(() => expect(host.closed).toBe(1));
    await account.close();
  });

  it("fails without exposing native errors", async () => {
    const { host, account } = service();
    host.handlers["oauth.pollPendingOAuth"] = () => {
      throw new Error("OAuth 登录失败: secret detail");
    };
    await account.change({ action: "signIn", provider: "zai" });
    await vi.waitFor(async () =>
      expect((await ready(account.view())).signIn).toEqual({
        state: "failed",
        message: "Sign-in was not completed. Try again.",
      }),
    );
    await account.close();
  });

  it("fails a pending sign-in when the Server exits", async () => {
    const hosts: FakeHost[] = [];
    const account = new AccountService(
      async () => {
        hosts.push(new FakeHost());
        return hosts.at(-1)!;
      },
      { pollMs: 60_000 },
    );
    await account.change({ action: "signIn", provider: "zai" });
    hosts[0]!.fail();
    expect((await ready(account.view())).signIn).toEqual({
      state: "failed",
      message: "ZCode Server stopped during sign-in. Try again.",
    });
    expect(hosts).toHaveLength(2);
    await account.close();
  });

  it("signs out like Desktop: logout, clear the family, refresh", async () => {
    const { host, account } = service();
    host.settings = { providerFamilyDomain: "zai" };
    await account.change({ action: "signOut" });
    expect(host.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "oauth.logout",
        "setting.update",
        "provider-settings.refresh",
      ]),
    );
    expect(host.settings.providerFamilyDomain).toBe("");
    await account.close();
  });
});

describe("model providers", () => {
  it("saves only edited leaves and keeps hidden fields", async () => {
    const { host, account } = service();
    await account.change({
      action: "updateProvider",
      providerId: "command-code",
      apiKey: "sk-new",
      baseUrl: "https://api.commandcode.ai/provider/v2",
    });
    expect(
      host.called("provider-settings.savePersonalProviderOverlay")[0]!.args,
    ).toEqual([
      "command-code",
      {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "sk-new" },
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://api.commandcode.ai/provider/v2",
          headers: { "X-Team": "a" },
        },
        personalModelIds: ["deepseek/deepseek-v4.1-flash"],
      },
      {},
    ]);
    await account.change({
      action: "updateProvider",
      providerId: "command-code",
      name: "Command Code",
      enabled: false,
    });
    expect(
      host.called("provider-settings.savePersonalProviderOverlay")[1]!.args,
    ).toEqual([
      "command-code",
      customProvider.personalConfig,
      { providerName: "Command Code", enabled: false },
    ]);
    await account.close();
  });

  it("refuses to edit plans that sign-in manages", async () => {
    const { host, account } = service();
    await expect(
      account.change({
        action: "updateProvider",
        providerId: "account:zai-start-plan",
        apiKey: "sk-new",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      account.change({
        action: "addModel",
        providerId: "missing",
        modelId: "m",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(
      host.called("provider-settings.savePersonalProviderOverlay"),
    ).toEqual([]);
    expect(host.called("provider-settings.addPersonalModel")).toEqual([]);
    await account.close();
  });

  it("creates from a template without overriding its endpoint", async () => {
    const { host, account } = service();
    host.handlers["provider-settings.createPersonalProvider"] = () => ({
      providerId: "deepseek",
      view: nativeView([
        {
          ...customProvider,
          providerId: "deepseek",
          templateId: "deepseek",
          personalConfig: { group: "standard-personal" },
          effectiveConfig: {
            group: "standard-personal",
            access: { type: "api-key" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://api.deepseek.com/anthropic",
            },
          },
        },
      ]),
    });
    await account.change({
      action: "createProvider",
      templateId: "deepseek",
      name: "DeepSeek",
      apiFormat: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk-deep",
    });
    expect(
      host.called("provider-settings.createPersonalProvider")[0]!.args,
    ).toEqual([
      { templateId: "deepseek", providerName: "DeepSeek", locale: "en-US" },
    ]);
    expect(
      host.called("provider-settings.savePersonalProviderOverlay")[0]!.args,
    ).toEqual([
      "deepseek",
      {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "sk-deep" },
      },
      { providerName: "DeepSeek" },
    ]);
    await account.close();
  });

  it("removes a new provider that ZCode rejects and hides the cause", async () => {
    const { host, account } = service();
    host.handlers["provider-settings.createPersonalProvider"] = () => ({
      providerId: "new-provider",
      view: nativeView([
        {
          ...customProvider,
          providerId: "new-provider",
          personalConfig: { group: "standard-personal" },
        },
      ]),
    });
    host.handlers["provider-settings.savePersonalProviderOverlay"] = () => {
      throw new Error("Invalid value sk-bad");
    };
    const failure = account.change({
      action: "createProvider",
      name: "Broken",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-bad",
    });
    await expect(failure).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    await expect(failure).rejects.not.toThrow(/sk-bad/u);
    expect(
      host.called("provider-settings.deletePersonalProvider")[0]!.args,
    ).toEqual(["new-provider"]);
    await account.close();
  });

  it("rejects unknown templates and non-http base URLs", async () => {
    const { account } = service();
    await expect(
      account.change({
        action: "createProvider",
        templateId: "missing",
        name: "x",
        apiFormat: "anthropic-messages",
        baseUrl: "https://example.com",
        apiKey: "k",
      }),
    ).rejects.toThrow("Unknown provider template");
    await expect(
      account.change({
        action: "createProvider",
        name: "x",
        apiFormat: "anthropic-messages",
        baseUrl: "file:///etc/passwd",
        apiKey: "k",
      }),
    ).rejects.toThrow();
    await account.close();
  });
});
