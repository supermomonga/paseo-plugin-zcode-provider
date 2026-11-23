import type { ProviderMetric } from "@getpaseo/plugin/server/provider";
import type { TurnHeaderRow } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";
import type { SessionUsageState } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";

// Session and turn metrics (ADR 36) from what ZCode itself records: each
// product turn's header row and the session's usage. The formats follow
// Paseo's own providers (packages/server/src/server/agent/providers/metrics.ts
// at v0.17.3), so a quantity reads the same whichever provider measured it.

const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5000;
const MIN_SPEED_DURATION_MS = 100;
const CACHE_HIT_OK_PERCENT = 50;

export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms > 0 && ms < 50) return "<0.1s";
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const count = Math.round(tokens);
  if (count < 1000) return String(count);
  const tenthsOfThousands = Math.round(count / 100);
  if (tenthsOfThousands < 10_000)
    return `${(tenthsOfThousands / 10).toFixed(1)}K`;
  return `${(Math.round(count / 100_000) / 10).toFixed(1)}M`;
}

function formatRate(tokensPerSecond: number): string | null {
  if (
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond > MAX_PLAUSIBLE_TOKENS_PER_SECOND
  )
    return null;
  const rounded = Math.round(tokensPerSecond);
  return rounded > 0 ? `~${rounded} tok/s` : null;
}

/** The sum, or undefined when any header lacks the value: never a partial total. */
function sum(
  headers: readonly TurnHeaderRow[],
  read: (header: TurnHeaderRow) => number | undefined,
): number | undefined {
  let total = 0;
  for (const header of headers) {
    const value = read(header);
    if (value === undefined || !Number.isFinite(value) || value < 0)
      return undefined;
    total += value;
  }
  return total;
}

const metric = (
  label: string,
  value: string | null | undefined,
): ProviderMetric[] => (value ? [{ label, value }] : []);

const duration = (label: string, ms: number | undefined) =>
  metric(label, ms === undefined ? null : formatDuration(ms));

/** The model as Paseo's picker names it, with the thinking level. */
export function modelMetricValue(
  modelId: string | undefined,
  thought: string | undefined,
): string | undefined {
  if (!modelId) return undefined;
  return thought ? `${modelId} (${thought})` : modelId;
}

/**
 * One Paseo turn, which can span several ZCode product turns (a goal's
 * continuations, background results). Without a Model row, Paseo would show
 * the agent's encoded model ID.
 */
export function turnMetrics(
  headers: readonly TurnHeaderRow[],
  model: string | undefined,
): ProviderMetric[] {
  if (headers.length === 0) return metric("Model", model);
  const started = Math.min(...headers.map((header) => header.startedAt));
  const ends = headers.map((header) => header.endedAt);
  const elapsed = ends.every((end) => end !== undefined)
    ? Math.max(...(ends as number[])) - started
    : undefined;
  // ZCode's work time leaves out waits for approvals and answers; Desktop
  // shows it as "Worked for". It is worth a row only when the turn waited:
  // otherwise it repeats the elapsed time, measured from other events.
  const worked = sum(headers, (header) => header.activeMs);
  const modelMs = sum(headers, (header) => header.modelDurationMs);
  const toolMs = sum(headers, (header) => header.toolDurationMs);
  const output = sum(headers, (header) => header.outputTokens);
  const speed =
    output !== undefined &&
    modelMs !== undefined &&
    modelMs >= MIN_SPEED_DURATION_MS
      ? formatRate(output / (modelMs / 1000))
      : null;
  const elapsedText =
    elapsed === undefined || elapsed < 0 ? null : formatDuration(elapsed);
  const workedText =
    worked === undefined || (elapsed !== undefined && worked >= elapsed)
      ? null
      : formatDuration(worked);
  const changes = headers.flatMap((header) =>
    header.fileChanges && header.fileChanges.state !== "reverted"
      ? [header.fileChanges]
      : [],
  );
  const files = changes.reduce((total, change) => total + change.files, 0);
  return [
    ...metric("Model", model),
    ...metric("Speed", speed),
    ...metric("Elapsed", elapsedText),
    ...(workedText && workedText !== elapsedText
      ? metric("Worked", workedText)
      : []),
    ...duration("Model time", modelMs),
    ...(toolMs !== undefined && toolMs > 0
      ? duration("Tool time", toolMs)
      : []),
    ...(output !== undefined && output > 0
      ? metric("Output tokens", formatTokens(output))
      : []),
    ...(files > 0
      ? metric(
          "Files changed",
          `${files} (+${changes.reduce((total, change) => total + change.additions, 0)} −${changes.reduce((total, change) => total + change.deletions, 0)})`,
        )
      : []),
  ];
}

/**
 * The session's own counters, which survive compaction. ZCode counts the main
 * conversation's requests; its input tokens include cached ones. The cache hit
 * is the last request's, as in Paseo's providers: a session-wide figure blends
 * prompts from before and after a compaction.
 */
export function sessionMetrics(usage: SessionUsageState): ProviderMetric[] {
  const { inputTokens, outputTokens } = usage.cumulative;
  const metrics: ProviderMetric[] =
    inputTokens + outputTokens > 0
      ? [
          {
            label: "Tokens",
            value: `${formatTokens(inputTokens)} ↑ · ${formatTokens(outputTokens)} ↓`,
          },
        ]
      : [];
  const hit = usage.contextWindow?.cache?.latestHitRate;
  if (typeof hit === "number" && Number.isFinite(hit) && hit >= 0) {
    const percent = Math.round(Math.min(hit, 1) * 100);
    metrics.push({
      label: "Cache (last reply)",
      value: `${percent}%`,
      ...(percent >= CACHE_HIT_OK_PERCENT ? { tone: "ok" as const } : {}),
    });
  }
  return metrics;
}
