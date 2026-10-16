import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  KiroModelList,
  KiroSubagentListUpdate,
  KiroUsageData,
  kiroContextUsageFromMetadata,
  kiroEffortLevelsFromCommand,
  kiroModelsFromList,
  kiroSubagentUpdateFromRoster,
  kiroUsageLimitsFromData,
} from "./kiroProtocol.ts";

const ROOT = "1ad9674b-721c-4358-9c44-ab2dd1556a15";

describe("kiroContextUsageFromMetadata", () => {
  it("turns Kiro's context percentage into tokens of the model window", () => {
    // Recorded from kiro-cli 2.19.1 mid-turn.
    const usage = kiroContextUsageFromMetadata({
      notification: { sessionId: ROOT, contextUsagePercentage: 1.8154999017715454 },
      previous: null,
      contextWindowTokens: 1_000_000,
    });
    expect(usage).toEqual({ usedTokens: 18_155, maxTokens: 1_000_000 });
  });

  it("adds each turn's metered credits to the thread's running cost", () => {
    // The turn-end notification Kiro sends with metering.
    const first = kiroContextUsageFromMetadata({
      notification: {
        sessionId: ROOT,
        contextUsagePercentage: 1.85,
        meteringUsage: [
          { value: 0.056785035489220564, unit: "credit", unitPlural: "credits" },
          { value: 0.03761939054726368, unit: "credit", unitPlural: "credits" },
        ],
        turnDurationMs: 11631,
      },
      previous: null,
      contextWindowTokens: 200_000,
    });
    expect(first?.cost?.currency).toBe("credits");
    expect(first?.cost?.amount).toBeCloseTo(0.0944, 4);
    expect(first?.durationMs).toBe(11631);

    const second = kiroContextUsageFromMetadata({
      notification: {
        sessionId: ROOT,
        meteringUsage: [{ value: 0.5, unit: "credit", unitPlural: "credits" }],
      },
      previous: first,
      contextWindowTokens: null,
    });
    expect(second?.cost?.amount).toBeCloseTo(0.5944, 4);
    // A credits-only report keeps the last known context fill.
    expect(second?.usedTokens).toBe(first?.usedTokens);
    expect(second?.maxTokens).toBe(200_000);
  });

  it("counts a crew child's credits toward its root thread", () => {
    const usage = kiroContextUsageFromMetadata({
      notification: { sessionId: ROOT },
      previous: { usedTokens: 100, maxTokens: 1000, cost: { amount: 1, currency: "credits" } },
      contextWindowTokens: null,
      extraCredits: 0.25,
    });
    expect(usage?.cost?.amount).toBeCloseTo(1.25, 6);
    expect(usage?.usedTokens).toBe(100);
  });

  it("ignores the empty metadata Kiro sends as a turn starts", () => {
    expect(
      kiroContextUsageFromMetadata({
        notification: { sessionId: ROOT },
        previous: null,
        contextWindowTokens: 1_000_000,
      }),
    ).toBeNull();
  });
});

describe("kiroEffortLevelsFromCommand", () => {
  it("reads the levels a model offers, including GPT's none", () => {
    expect(
      kiroEffortLevelsFromCommand({
        success: true,
        message: "Available effort levels: none, low, medium, high, xhigh, max",
      }),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("treats Kiro's refusal as a model without effort", () => {
    expect(
      kiroEffortLevelsFromCommand({
        success: false,
        message:
          "Effort configuration is currently not available on claude-haiku-4.5. Select a /model that supports effort (like claude-opus-4.7) to configure.",
      }),
    ).toEqual([]);
  });

  it("leaves an answer it cannot read unknown", () => {
    expect(
      kiroEffortLevelsFromCommand({ success: true, message: "Effort set to high" }),
    ).toBeNull();
  });
});

describe("kiroSubagentUpdateFromRoster", () => {
  const roster = Schema.decodeUnknownSync(KiroSubagentListUpdate)({
    subagents: [
      {
        sessionId: "c770d0de-3b54-4903-8c87-164dd5972b6d",
        sessionName: "list_files",
        agentName: "kiro_default",
        initialQuery: "List the files in the current working directory and report their names.",
        status: { type: "working", message: "Running" },
        group: "crew-List the files in th",
        role: "kiro_default",
        dependsOn: [],
      },
    ],
    pendingStages: [],
  });

  it("links a running crew child by its session", () => {
    const entry = roster.subagents![0]!;
    expect(kiroSubagentUpdateFromRoster(entry)).toEqual({
      nativeTaskId: "c770d0de-3b54-4903-8c87-164dd5972b6d",
      prompt: "List the files in the current working directory and report their names.",
      title: "list_files",
      model: null,
      status: "running",
      childSessionId: "c770d0de-3b54-4903-8c87-164dd5972b6d",
      result: null,
      suppressNormalTool: true,
    });
  });

  it("finishes a terminated child", () => {
    const entry = { ...roster.subagents![0]!, status: { type: "terminated" } };
    expect(kiroSubagentUpdateFromRoster(entry).status).toBe("completed");
  });
});

describe("kiroUsageLimitsFromData", () => {
  it("maps the monthly credit allowance to a usage window", () => {
    const data = Schema.decodeUnknownSync(KiroUsageData)({
      planName: "KIRO PRO+",
      billingCycleReset: "2026-11-01",
      overagesEnabled: false,
      usageBreakdowns: [
        {
          resourceType: "CREDIT",
          displayName: "Credits",
          used: 280.8,
          limit: 2000,
          percentage: 14,
          hasLimit: true,
        },
      ],
    });
    expect(kiroUsageLimitsFromData({ data, checkedAt: "2026-10-16T12:00:00.000Z" })).toEqual({
      checkedAt: "2026-10-16T12:00:00.000Z",
      windows: [
        {
          id: "credits",
          kind: "monthly",
          label: "KIRO PRO+ credits",
          usedPercent: 14.04,
          resetsAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("reports nothing for an account without a limit", () => {
    const data = Schema.decodeUnknownSync(KiroUsageData)({
      usageBreakdowns: [{ resourceType: "CREDIT", used: 5, limit: 0, hasLimit: false }],
    });
    expect(kiroUsageLimitsFromData({ data, checkedAt: "2026-10-16T12:00:00.000Z" })).toBe(
      undefined,
    );
  });
});

describe("kiroModelsFromList", () => {
  it("reads `chat --list-models -f json`", () => {
    const list = Schema.decodeUnknownSync(KiroModelList)({
      default_model: "auto",
      models: [
        {
          model_name: "auto",
          model_id: "auto",
          context_window_tokens: 1000000,
          rate_multiplier: 1.0,
          rate_unit: "Credit",
        },
        {
          model_name: "claude-haiku-4.5",
          model_id: "claude-haiku-4.5",
          context_window_tokens: 200000,
          rate_multiplier: 0.4,
          rate_unit: "Credit",
        },
        { model_name: "auto", model_id: "auto" },
      ],
    });
    expect(kiroModelsFromList(list).map((model) => [model.id, model.contextWindowTokens])).toEqual([
      ["auto", 1000000],
      ["claude-haiku-4.5", 200000],
    ]);
  });
});
