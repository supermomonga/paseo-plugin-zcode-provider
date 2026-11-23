import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTokens,
  modelMetricValue,
  sessionMetrics,
  turnMetrics,
} from "./metrics.js";
import type { TurnHeaderRow } from "./vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";

const header = (fields: Partial<TurnHeaderRow> = {}): TurnHeaderRow => ({
  rowId: 1,
  turnId: "t",
  productTurnId: "t",
  entityId: "e",
  createdAt: 1,
  createdAtSeq: 1,
  kind: "turnHeader",
  origin: "userInput",
  state: "completedSuccess",
  startedAt: 10_000,
  ...fields,
});

const usage = (fields: {
  input?: number;
  output?: number;
  latestHitRate?: number | null;
}) => ({
  contextWindow:
    fields.latestHitRate === undefined
      ? null
      : {
          usedTokens: 1,
          maxTokens: 2,
          autoCompactThresholdTokens: null,
          cache: {
            inputTokens: 1,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
            latestHitRate: fields.latestHitRate,
            hitRate: null,
          },
        },
  cumulative: {
    inputTokens: fields.input ?? 0,
    outputTokens: fields.output ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
});

describe("formats", () => {
  it("reads like Paseo's own providers", () => {
    expect(formatDuration(30)).toBe("<0.1s");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(2_345_678)).toBe("2.3M");
  });

  it("names the model as the picker does, with its thinking level", () => {
    expect(modelMetricValue("GLM-5.1", "high")).toBe("GLM-5.1 (high)");
    expect(modelMetricValue("GLM-5.1", undefined)).toBe("GLM-5.1");
    expect(modelMetricValue(undefined, "high")).toBeUndefined();
  });
});

describe("turn metrics", () => {
  it("adds up the ZCode turns of one Paseo turn", () => {
    expect(
      turnMetrics(
        [
          header({
            startedAt: 10_000,
            endedAt: 14_000,
            activeMs: 3_000,
            modelDurationMs: 2_000,
            toolDurationMs: 0,
            outputTokens: 1_000,
            fileChanges: { additions: 5, deletions: 1, files: 1 },
          }),
          // A goal's continuation.
          header({
            origin: "goalContinuation",
            startedAt: 15_000,
            endedAt: 70_000,
            activeMs: 55_000,
            modelDurationMs: 8_000,
            toolDurationMs: 40_000,
            outputTokens: 1_500,
            fileChanges: { additions: 3, deletions: 0, files: 2 },
          }),
        ],
        "GLM-5.1 (high)",
      ),
    ).toEqual([
      { label: "Model", value: "GLM-5.1 (high)" },
      { label: "Speed", value: "~250 tok/s" },
      { label: "Elapsed", value: "1m 0s" },
      { label: "Worked", value: "58.0s" },
      { label: "Model time", value: "10.0s" },
      { label: "Tool time", value: "40.0s" },
      { label: "Output tokens", value: "2.5K" },
      { label: "Files changed", value: "3 (+8 −1)" },
    ]);
  });

  it("never shows a partial total or a duplicate of the elapsed time", () => {
    expect(
      turnMetrics(
        [
          header({ endedAt: 12_000, activeMs: 2_000, outputTokens: 10 }),
          header({ endedAt: 13_000, outputTokens: 10 }),
        ],
        "GLM-5.1",
      ),
    ).toEqual([
      { label: "Model", value: "GLM-5.1" },
      { label: "Elapsed", value: "3.0s" },
      { label: "Output tokens", value: "20" },
    ]);
    expect(
      turnMetrics([header({ endedAt: 12_000, activeMs: 2_000 })], undefined),
    ).toEqual([{ label: "Elapsed", value: "2.0s" }]);
  });

  it("shows the work time only when the turn waited", () => {
    const labels = (activeMs: number) =>
      turnMetrics([header({ endedAt: 12_500, activeMs })], undefined).map(
        (metric) => metric.label,
      );
    // ZCode measures its work time from other events than the turn's ends.
    expect(labels(2_600)).toEqual(["Elapsed"]);
    expect(labels(2_480)).toEqual(["Elapsed"]);
    expect(labels(1_000)).toEqual(["Elapsed", "Worked"]);
  });

  it("leaves out reverted changes and an implausible speed", () => {
    expect(
      turnMetrics(
        [
          header({
            endedAt: 10_050,
            modelDurationMs: 50,
            outputTokens: 1_000,
            fileChanges: {
              additions: 1,
              deletions: 1,
              files: 1,
              state: "reverted",
            },
          }),
        ],
        undefined,
      ).map((metric) => metric.label),
    ).toEqual(["Elapsed", "Model time", "Output tokens"]);
  });

  it("names only the model when ZCode recorded no turn", () => {
    expect(turnMetrics([], "GLM-5.1")).toEqual([
      { label: "Model", value: "GLM-5.1" },
    ]);
  });
});

describe("session metrics", () => {
  it("reports ZCode's totals and the last request's cache hit", () => {
    expect(
      sessionMetrics(
        usage({ input: 123_456, output: 7_890, latestHitRate: 0.874 }),
      ),
    ).toEqual([
      { label: "Tokens", value: "123.5K ↑ · 7.9K ↓" },
      { label: "Cache (last reply)", value: "87%", tone: "ok" },
    ]);
    expect(
      sessionMetrics(usage({ input: 10, output: 1, latestHitRate: 0.2 })),
    ).toEqual([
      { label: "Tokens", value: "10 ↑ · 1 ↓" },
      { label: "Cache (last reply)", value: "20%" },
    ]);
  });

  it("reports nothing before the first request", () => {
    expect(sessionMetrics(usage({ latestHitRate: null }))).toEqual([]);
  });
});
