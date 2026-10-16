import type { UsageBucket, UsageSource, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageSummaryForClient } from "./forkClientUsage.ts";

const bucket = (provider: UsageBucket["provider"]) =>
  ({
    day: "2026-09-29",
    provider,
    model: "claude-opus-5.5",
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 0.014,
    cacheSavingsUsd: 0,
    costSource: "providerReported",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  }) as UsageBucket;

const source = (provider: UsageSource["fingerprint"]["provider"]) =>
  ({
    fingerprint: {
      hostId: "host",
      provider,
      resolvedHomePath: `/home/box/.${provider}`,
      volumeId: "39:1",
    },
    status: "ok",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 1,
    message: null,
  }) as unknown as UsageSource;

const summary = {
  contractVersion: 6,
  readAt: "2026-10-16T14:58:13.590Z",
  timeZone: "Asia/Calcutta",
  sinceDay: "2026-09-17",
  untilDay: "2026-10-16",
  buckets: [bucket("codex"), bucket("kiro")],
  sources: [source("codex"), source("kiro")],
  pricing: { status: "fresh" },
  scanDurationMs: 10,
} as unknown as UsageSummary;

describe("usageSummaryForClient", () => {
  it("keeps Kiro usage for fork builds", () => {
    expect(usageSummaryForClient(summary, "0.1.0-adi.1")).toBe(summary);
  });

  it("drops Kiro usage for upstream clients and clients that send no version", () => {
    for (const version of ["0.1.0", "0.1.1-nightly.20261016.3203", undefined]) {
      const result = usageSummaryForClient(summary, version);
      expect(result.buckets.map((entry) => entry.provider)).toEqual(["codex"]);
      expect(result.sources.map((entry) => entry.fingerprint.provider)).toEqual(["codex"]);
    }
  });
});
