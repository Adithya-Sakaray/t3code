import { describe, expect, it } from "vite-plus/test";

import { grokAuthTokenFromJson, grokBillingToLimits } from "./grokUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("grokBillingToLimits", () => {
  it("maps CLI-proxy weekly credits onto a weekly window", () => {
    expect(
      grokBillingToLimits({
        checkedAt,
        payload: {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-07-07T10:46:52.885Z",
              end: "2026-07-14T10:46:52.885Z",
            },
            creditUsagePercent: 75,
            productUsage: [{ product: "GrokBuild", usagePercent: 75 }],
          },
        },
      }),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "credits",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 75,
          resetsAt: "2026-07-14T10:46:52.885Z",
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("falls back to monthlyLimit / usage.totalUsed from ACP billing", () => {
    const limits = grokBillingToLimits({
      checkedAt,
      payload: {
        billingCycle: {
          billingPeriodStart: "2026-05-01T00:00:00Z",
          billingPeriodEnd: "2026-06-01T00:00:00Z",
        },
        monthlyLimit: { val: 1000 },
        usage: { totalUsed: { val: 250 } },
      },
    });
    expect(limits?.windows[0]).toMatchObject({
      id: "credits",
      kind: "monthly",
      usedPercent: 25,
      resetsAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("does not invent 0% when the period has no percentage", () => {
    expect(
      grokBillingToLimits({
        checkedAt,
        payload: {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-07-07T00:00:00Z",
              end: "2026-07-14T00:00:00Z",
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("grokAuthTokenFromJson", () => {
  it("prefers a non-expired SuperGrok OIDC key", () => {
    const now = Date.parse("2026-07-18T10:00:00.000Z");
    expect(
      grokAuthTokenFromJson(
        {
          "https://accounts.x.ai/sign-in": {
            key: "legacy-token",
            expires_at: "2026-08-01T00:00:00Z",
          },
          "https://auth.x.ai:: ": { key: "supergrok-token", expires_at: "2026-08-01T00:00:00Z" },
        },
        now,
      ),
    ).toBe("supergrok-token");
  });

  it("skips expired entries", () => {
    const now = Date.parse("2026-07-18T10:00:00.000Z");
    expect(
      grokAuthTokenFromJson(
        { "https://auth.x.ai:: ": { key: "stale", expires_at: "2026-07-01T00:00:00Z" } },
        now,
      ),
    ).toBeUndefined();
  });
});
