import { UsageReportSchema } from "@getpaseo/protocol/messages";
import { UsageScopeSchema } from "@getpaseo/plugin/server/usage";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { AccountService, type SettingsHost } from "./account.js";
import { AdapterError } from "./errors.js";
import { encodeModel } from "./mapping.js";
import { createUsageSource, usageReport } from "./usage.js";

const PLAN = "account:zai-individual-coding-plan";

const plan = (
  providerId: string,
  accountType: string,
  mode: string,
  entitled = true,
) => ({
  providerId,
  enabled: true,
  executable: entitled,
  effectiveConfig: {
    group: `${accountType}-family`,
    access: { type: "zhipu-account", accountType, mode, entitled },
  },
  issues: [],
  models: [],
});

const limit = (
  type: string,
  unit: number,
  number: number,
  percentage?: number,
) => ({
  type,
  unit,
  number,
  ...(percentage === undefined ? {} : { percentage }),
  nextResetTime: Date.UTC(2026, 9, 6, 15),
  usageDetails: [],
});

const snapshot = {
  generatedAt: 1,
  authenticated: true,
  provider: { id: PLAN, name: "GLM Coding Plan" },
  remaining: null,
  subscription: {
    identityType: "email",
    identityMasked: null,
    details: [{ productId: "p", productName: "GLM Coding Pro" }],
  },
  quota: {
    level: "pro",
    limits: [
      limit("TOKENS_LIMIT", 3, 5, 31),
      limit("TOKENS_LIMIT", 6, 1, 75),
      limit("TIME_LIMIT", 5, 1),
      limit("OTHER_LIMIT", 1, 1, 10),
    ],
  },
  mcpQuota: {
    serverTime: 1,
    level: "pro",
    scope: { providerFamily: "zai", targetType: "PERSONAL" },
    aggregate: { ...limit("MCP_USAGE_LIMIT", 0, 0, 95), remaining: 5 },
  },
};

class FakeHost implements SettingsHost {
  readonly calls: { method: string; args: readonly unknown[] }[] = [];
  session: unknown = {
    status: "authenticated",
    userInfo: { id: "user-42", username: "me@example.com", displayName: "Me" },
  };
  family: unknown = "zai";
  providers: unknown[] = [
    plan(PLAN, "zai", "individual-coding-plan"),
    plan("account:zai-start-plan", "zai", "start-plan"),
    plan(
      "account:bigmodel-individual-coding-plan",
      "bigmodel",
      "individual-coding-plan",
    ),
  ];
  usage: () => unknown = () => snapshot;
  readonly handlers: Record<string, () => unknown> = {
    "oauth.restoreCachedSessionState": () => this.session,
    "oauth.getActiveProvider": () => this.family,
    "oauth.cancelPending": () => undefined,
    "setting.get": () => ({}),
    "provider-settings.getView": () => ({
      providerTemplates: [],
      providers: this.providers,
    }),
    "usage-stats.getEntitlementSnapshot": () => this.usage(),
  };
  async invoke<Schema extends z.ZodType>(
    channel: string,
    method: string,
    args: readonly unknown[],
    schema: Schema,
  ): Promise<z.output<Schema>> {
    const name = `${channel}.${method}`;
    this.calls.push({ method: name, args });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Unexpected ${name}`);
    return schema.parse(await handler());
  }
  onFailure() {
    return () => {};
  }
  async close() {}
}

function fixture(options: { start?: () => Promise<SettingsHost> } = {}) {
  const host = new FakeHost();
  let time = 0;
  const account = new AccountService(options.start ?? (async () => host), {
    idleMs: 1_000,
  });
  const usage = createUsageSource(account, { now: () => time });
  return {
    host,
    account,
    usage,
    advance: (ms: number) => (time += ms),
    count: (method: string) =>
      host.calls.filter((call) => call.method === method).length,
  };
}

describe("usage source discovery", () => {
  it("finds the entitled individual plan of the signed-in family", async () => {
    const { usage } = fixture();
    const accounts = await usage.source.discover({ kind: "global" });
    expect(accounts).toHaveLength(1);
    const [account] = accounts;
    expect(account).toMatchObject({
      label: "Z.ai (Me)",
      harness: "ZCode",
      input: { providerId: PLAN },
    });
    // Paseo's key contract: stable, never a credential or raw identifier.
    expect(account!.key).toMatch(/^zai\.individual\.[0-9a-f]{24}$/);
    expect(JSON.stringify(account)).not.toMatch(/user-42|example\.com/);
    expect(usage.source.input.parse(account!.input)).toEqual({
      providerId: PLAN,
    });
  });

  it.each([
    [
      "signed out",
      (host: FakeHost) => (host.session = { status: "signed-out" }),
    ],
    ["no family", (host: FakeHost) => (host.family = null)],
    [
      "no entitled plan",
      (host: FakeHost) =>
        (host.providers = [plan(PLAN, "zai", "individual-coding-plan", false)]),
    ],
  ])("returns no account when %s", async (_, change) => {
    const { host, usage } = fixture();
    change(host);
    expect(await usage.source.discover({ kind: "global" })).toEqual([]);
  });

  it("reuses accounts until they expire or the account changes", async () => {
    const { account, usage, advance, count } = fixture();
    await usage.source.discover({ kind: "global" });
    await usage.source.discover({ kind: "global" });
    expect(count("provider-settings.getView")).toBe(1);
    await account.change({ action: "cancelSignIn" });
    const views = count("provider-settings.getView");
    await usage.source.discover({ kind: "global" });
    expect(count("provider-settings.getView")).toBe(views + 1);
    advance(5 * 60_000);
    await usage.source.discover({ kind: "global" });
    expect(count("provider-settings.getView")).toBe(views + 2);
  });

  it("returns no account without a runtime and retries soon", async () => {
    let starts = 0;
    const { usage, advance } = fixture({
      start: async () => {
        starts += 1;
        throw new AdapterError("RUNTIME_SETUP_REQUIRED", "not set up");
      },
    });
    expect(await usage.source.discover({ kind: "global" })).toEqual([]);
    await usage.source.discover({ kind: "global" });
    expect(starts).toBe(1);
    advance(30_000);
    await usage.source.discover({ kind: "global" });
    expect(starts).toBe(2);
  });

  it("scopes session discovery to ZCode agents on the plan", async () => {
    const { usage } = fixture();
    const session = (provider: string, model?: string) =>
      usage.source.discover(
        UsageScopeSchema.parse({
          kind: "session",
          provider,
          ...(model === undefined ? {} : { model }),
          env: {},
        }),
      );
    expect(await session("codex")).toEqual([]);
    expect(await session("zcode")).toHaveLength(1);
    expect(
      await session(
        "zcode",
        encodeModel({ providerId: PLAN, modelId: "GLM-5.3" }),
      ),
    ).toHaveLength(1);
    expect(
      await session(
        "zcode",
        encodeModel({ providerId: "zai-api", modelId: "GLM-5.3" }),
      ),
    ).toEqual([]);
  });
});

describe("usage source fetch", () => {
  it("asks for this plan the way Desktop does and maps every window", async () => {
    const { host, usage } = fixture();
    const report = await usage.source.fetch({ providerId: PLAN });
    expect(
      host.calls.find(
        (call) => call.method === "usage-stats.getEntitlementSnapshot",
      )?.args,
    ).toEqual([
      {
        includeSubscription: true,
        preferredProviderId: PLAN,
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
        allowDisabledPreferredProvider: true,
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      },
    ]);
    expect(UsageReportSchema.parse(report)).toEqual(report);
    const resetsAt = new Date(Date.UTC(2026, 9, 6, 15)).toISOString();
    expect(report).toEqual({
      status: "available",
      planLabel: "GLM Coding Pro",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          shortLabel: "5h",
          summary: true,
          usedPct: 31,
          remainingPct: 69,
          resetsAt,
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: 75,
          remainingPct: 25,
          resetsAt,
          tone: "warning",
        },
        {
          id: "tool_calls",
          label: "Tool calls",
          shortLabel: "tools",
          usedPct: null,
          remainingPct: null,
          resetsAt,
          tone: "default",
        },
        {
          id: "mcp",
          label: "ZCode MCP",
          shortLabel: "mcp",
          usedPct: 95,
          remainingPct: 5,
          resetsAt,
          tone: "danger",
        },
      ],
    });
  });

  it("treats Team Plan credit limits as token windows", () => {
    const report = usageReport({
      quota: { level: "max", limits: [limit("CREDIT_LIMIT", 3, 5, 10)] },
    });
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Max",
      windows: [{ id: "five_hour", usedPct: 10 }],
    });
  });

  it.each([
    [
      "no_plan",
      {
        status: "unavailable",
        problem: { kind: "no_quota", detail: "No active Coding Plan" },
      },
    ],
    [
      "not_configured",
      { status: "unavailable", problem: { kind: "no_quota" } },
    ],
    ["unavailable", { status: "error" }],
  ])("reports %s from ZCode", async (reason, expected) => {
    const { host, usage } = fixture();
    host.usage = () => ({ ...snapshot, unavailableReason: reason });
    const report = await usage.source.fetch({ providerId: PLAN });
    expect(report).toMatchObject(expected);
    expect(UsageReportSchema.parse(report)).toEqual(report);
  });

  it("reports a missing quota as an error", () => {
    expect(usageReport({ quota: null, mcpQuota: null })).toMatchObject({
      status: "error",
    });
  });

  it.each([
    [{ status: "signed-out" }, "Signed out"],
    [{ status: "reauthentication-required" }, "sign-in expired"],
  ])("asks to sign in without querying usage: %j", async (session, text) => {
    const { host, usage, count } = fixture();
    host.session = session;
    const report = await usage.source.fetch({ providerId: PLAN });
    expect(report).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(report)).toContain(text);
    expect(count("usage-stats.getEntitlementSnapshot")).toBe(0);
  });

  it("does not query a plan that is not entitled", async () => {
    const { usage, count } = fixture();
    const report = await usage.source.fetch({
      providerId: "account:zai-start-plan",
    });
    expect(report).toMatchObject({ status: "unavailable" });
    expect(count("usage-stats.getEntitlementSnapshot")).toBe(0);
  });

  it("does not expose native errors", async () => {
    const { host, usage } = fixture();
    host.usage = () => {
      throw new Error("token sk-secret for me@example.com");
    };
    const report = await usage.source.fetch({ providerId: PLAN });
    expect(report).toEqual({
      status: "error",
      error: "ZCode could not read Coding Plan usage",
    });
  });

  it("points to runtime setup when no runtime is installed", async () => {
    const { usage } = fixture({
      start: async () => {
        throw new AdapterError("RUNTIME_SETUP_REQUIRED", "Install it first.");
      },
    });
    expect(await usage.source.fetch({ providerId: PLAN })).toEqual({
      status: "error",
      error: "Install it first.",
    });
  });
});
