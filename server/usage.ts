import { createHash } from "node:crypto";
// Types only, from the module every supported Paseo resolves; Paseo 0.8–0.10
// reject `@getpaseo/plugin/server/usage` even as a type import.
import type {
  UsageReport,
  UsageSourceRegistration,
  UsageWindow,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  accountSettingsSchema,
  familySchema,
  nativeViewSchema,
  sessionStateSchema,
  type AccountService,
  type NativeView,
  type SettingsHost,
} from "./account.js";
import { AdapterError } from "./errors.js";
import { logger } from "./logger.js";
import { decodeModel, ZCODE_PROVIDER_ID } from "./mapping.js";
import type { AccountFamily } from "../shared/account.js";

type UsageScope = Parameters<UsageSourceRegistration["discover"]>[0];
type UsageAccount = Awaited<
  ReturnType<UsageSourceRegistration["discover"]>
>[number];

const inputSchema = z.object({ providerId: z.string().min(1) }).strict();
type UsageInput = z.output<typeof inputSchema>;

const FAMILY_LABELS: Record<AccountFamily, string> = {
  zai: "Z.ai",
  bigmodel: "BigModel",
};
const SETTINGS_PATH =
  "Settings → Plugins → zcode-provider → Settings → Account";

const limitSchema = z.object({
  type: z.string(),
  unit: z.number().optional(),
  number: z.number().optional(),
  percentage: z.number().optional(),
  nextResetTime: z.number().nullish(),
});
type QuotaLimit = z.output<typeof limitSchema>;
// The fields of ZCode's UsageEntitlementSnapshot that this source reads.
const snapshotSchema = z.object({
  unavailableReason: z.string().optional(),
  subscription: z
    .object({ details: z.array(z.object({ productName: z.string() })) })
    .nullish(),
  quota: z
    .object({ level: z.string().nullable(), limits: z.array(limitSchema) })
    .nullish(),
  mcpQuota: z.object({ aggregate: limitSchema }).nullish(),
});
type Snapshot = z.output<typeof snapshotSchema>;

// Z.ai Team Plan reports CREDIT_LIMIT where BigModel reports TOKENS_LIMIT.
const TOKEN_LIMITS = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);
// The windows ZCode Desktop shows, identified by ZCode's unit codes
// (packages/ui/src/CodingPlanUsageRemainingPanel.tsx).
const WINDOWS: readonly {
  id: string;
  label: string;
  shortLabel: string;
  summary?: boolean;
  matches(limit: QuotaLimit): boolean;
}[] = [
  {
    id: "five_hour",
    label: "5-hour",
    shortLabel: "5h",
    summary: true,
    matches: (limit) =>
      TOKEN_LIMITS.has(limit.type) && limit.unit === 3 && limit.number === 5,
  },
  {
    id: "weekly",
    label: "Weekly",
    shortLabel: "wk",
    summary: true,
    matches: (limit) => TOKEN_LIMITS.has(limit.type) && limit.unit === 6,
  },
  {
    id: "tool_calls",
    label: "Tool calls",
    shortLabel: "tools",
    matches: (limit) =>
      limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1,
  },
];

const noQuota = (detail: string): UsageReport => ({
  status: "unavailable",
  problem: { kind: "no_quota", detail },
});

function usageWindow(
  definition: Omit<UsageWindow, "usedPct" | "remainingPct" | "resetsAt">,
  limit: QuotaLimit,
): UsageWindow {
  // ZCode's percentage is the used share.
  const used =
    limit.percentage !== undefined && Number.isFinite(limit.percentage)
      ? Math.max(0, Math.min(100, limit.percentage))
      : null;
  return {
    ...definition,
    usedPct: used,
    remainingPct: used === null ? null : 100 - used,
    resetsAt: limit.nextResetTime
      ? new Date(limit.nextResetTime).toISOString()
      : null,
    tone:
      used === null
        ? "default"
        : used > 90
          ? "danger"
          : used >= 70
            ? "warning"
            : "ok",
  };
}

export function usageReport(snapshot: Snapshot): UsageReport {
  switch (snapshot.unavailableReason) {
    case undefined:
      break;
    case "no_plan":
      return noQuota("No active Coding Plan");
    case "not_configured":
    case "not_authenticated":
      return noQuota(
        `No connected Coding Plan account. Open ${SETTINGS_PATH}.`,
      );
    default:
      return {
        status: "error",
        error: "ZCode Coding Plan usage is unavailable",
      };
  }
  const limits = snapshot.quota?.limits ?? [];
  const windows: UsageWindow[] = [];
  for (const { matches, ...definition } of WINDOWS) {
    const limit = limits.find(matches);
    if (limit) windows.push(usageWindow(definition, limit));
  }
  if (snapshot.mcpQuota)
    windows.push(
      usageWindow(
        { id: "mcp", label: "ZCode MCP", shortLabel: "mcp" },
        snapshot.mcpQuota.aggregate,
      ),
    );
  if (windows.length === 0)
    return {
      status: "error",
      error: "ZCode returned no Coding Plan quota. Try again later.",
    };
  const level = snapshot.quota?.level;
  const planLabel =
    snapshot.subscription?.details[0]?.productName ??
    (level ? level.charAt(0).toUpperCase() + level.slice(1) : undefined);
  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
  };
}

interface AccountState {
  readonly session: z.output<typeof sessionStateSchema>;
  readonly family: AccountFamily | undefined;
  readonly view: NativeView;
}

async function readAccount(host: SettingsHost): Promise<AccountState> {
  const [session, active, settings, view] = await Promise.all([
    host.invoke("oauth", "restoreCachedSessionState", [], sessionStateSchema),
    host.invoke("oauth", "getActiveProvider", [], familySchema),
    host.invoke("setting", "get", [], accountSettingsSchema),
    host.invoke("provider-settings", "getView", [], nativeViewSchema),
  ]);
  const domain = familySchema.safeParse(settings.providerFamilyDomain || null);
  const family = (domain.success ? domain.data : null) ?? active ?? undefined;
  return { session, family, view };
}

// Desktop's resolveEntitledAccountProviderAccess: the entitled individual
// Coding Plan of the signed-in family, with its static account access.
function planAccess(state: AccountState, providerId?: string) {
  if (state.family === undefined) return [];
  return state.view.providers.flatMap((provider) => {
    const access = provider.effectiveConfig.access;
    if (
      (providerId !== undefined && provider.providerId !== providerId) ||
      access?.type !== "zhipu-account" ||
      access.accountType !== state.family ||
      access.mode !== "individual-coding-plan" ||
      access.entitled !== true
    )
      return [];
    return [
      {
        providerId: provider.providerId,
        access: {
          type: "zhipu-account",
          accountType: access.accountType,
          mode: access.mode,
          entitled: access.entitled,
        },
      },
    ];
  });
}

function accountKey(family: AccountFamily, userId: string | undefined) {
  if (!userId || userId === "unknown") return `${family}.individual`;
  // A stable, non-identifying key: the backend user ID is hashed.
  const digest = createHash("sha256")
    .update(`${family}:${userId}`)
    .digest("hex")
    .slice(0, 24);
  return `${family}.individual.${digest}`;
}

export interface UsageSourceOptions {
  /** Reuse discovered accounts this long; account changes clear them. */
  readonly accountsTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Coding Plan quota for Paseo's Usage screen (Paseo 0.11+), read through
 * ZCode's official usage-stats service on the account Server (ADR 18).
 */
export function createUsageSource(
  account: AccountService,
  options: UsageSourceOptions = {},
): { source: UsageSourceRegistration; dispose(): void } {
  const accountsTtlMs = options.accountsTtlMs ?? 5 * 60_000;
  const failureTtlMs = options.failureTtlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cached:
    | { at: number; ttl: number; accounts: Promise<UsageAccount[]> }
    | undefined;
  const dispose = account.onChange(() => {
    cached = undefined;
  });

  const discoverAccounts = async (): Promise<UsageAccount[]> => {
    const state = await account.use(readAccount);
    if (state.session.status === "signed-out" || state.family === undefined)
      return [];
    const family = state.family;
    const displayName =
      state.session.status === "authenticated"
        ? state.session.userInfo.displayName
        : undefined;
    const userId =
      state.session.status === "authenticated"
        ? state.session.userInfo.id
        : undefined;
    return planAccess(state).map(({ providerId }) => ({
      key: accountKey(family, userId),
      label: displayName
        ? `${FAMILY_LABELS[family]} (${displayName})`
        : FAMILY_LABELS[family],
      harness: "ZCode",
      input: { providerId } satisfies UsageInput,
    }));
  };

  const accounts = (): Promise<UsageAccount[]> => {
    if (cached && now() - cached.at < cached.ttl) return cached.accounts;
    const entry = {
      at: now(),
      ttl: accountsTtlMs,
      accounts: discoverAccounts().catch((error: unknown) => {
        // No runtime or no Server: no card, and a quick retry.
        if (!(error instanceof AdapterError))
          logger.error("zcode.usage.discover.failed", error);
        entry.ttl = failureTtlMs;
        return [];
      }),
    };
    cached = entry;
    return entry.accounts;
  };

  const source: UsageSourceRegistration = {
    id: "zcode",
    label: "ZCode",
    icon: "icon.svg",
    input: inputSchema,
    async discover(scope: UsageScope): Promise<UsageAccount[]> {
      const found = await accounts();
      if (scope.kind === "global") return found;
      if (scope.provider !== ZCODE_PROVIDER_ID) return [];
      if (scope.model === undefined) return found;
      let providerId: string;
      try {
        providerId = decodeModel(scope.model).providerId;
      } catch {
        return [];
      }
      return found.filter(
        (entry) => (entry.input as UsageInput).providerId === providerId,
      );
    },
    async fetch(input: unknown): Promise<UsageReport> {
      const { providerId } = inputSchema.parse(input);
      try {
        return await account.use(async (host) => {
          const state = await readAccount(host);
          if (state.session.status === "signed-out")
            return noQuota(`Signed out of ZCode. Open ${SETTINGS_PATH}.`);
          if (state.session.status === "reauthentication-required")
            return noQuota(
              `ZCode sign-in expired. Sign in again in ${SETTINGS_PATH}.`,
            );
          const [plan] = planAccess(state, providerId);
          if (!plan) return noQuota("No active Coding Plan");
          // Desktop's request: this plan only, never an environment API key.
          const snapshot = await host.invoke(
            "usage-stats",
            "getEntitlementSnapshot",
            [
              {
                includeSubscription: true,
                preferredProviderId: plan.providerId,
                accountAccess: plan.access,
                allowDisabledPreferredProvider: true,
                requirePreferredProvider: true,
                allowEnvApiKey: false,
              },
            ],
            snapshotSchema,
            15_000,
          );
          return usageReport(snapshot);
        });
      } catch (error) {
        if (
          error instanceof AdapterError &&
          error.code === "RUNTIME_SETUP_REQUIRED"
        )
          return { status: "error", error: error.message };
        // Native messages may include account data; they stay in the log.
        logger.error("zcode.usage.fetch.failed", error);
        return {
          status: "error",
          error: "ZCode could not read Coding Plan usage",
        };
      }
    },
  };
  return { source, dispose };
}
