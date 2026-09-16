import { describe, expect, it } from "vite-plus/test";

import { cursorPeriodUsageToLimits, cursorStatusAccessToken } from "./cursorUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("cursorPeriodUsageToLimits", () => {
  it("uses included spend over the included limit, not totalPercentUsed", () => {
    expect(
      cursorPeriodUsageToLimits({
        checkedAt,
        payload: {
          billingCycleStart: "2026-07-01T00:00:00.000Z",
          billingCycleEnd: "2026-08-01T00:00:00.000Z",
          planUsage: {
            totalSpend: 1288,
            includedSpend: 1288,
            remaining: 712,
            limit: 2000,
            totalPercentUsed: 3.73,
          },
          spendLimitUsage: { limitType: "user" },
        },
      }),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "included",
          kind: "monthly",
          label: "Included",
          usedPercent: 64.4,
          resetsAt: "2026-08-01T00:00:00.000Z",
          windowDurationMins: 44640,
        },
      ],
    });
  });

  it("adds a spend-limit window when that payload has used and limit", () => {
    const limits = cursorPeriodUsageToLimits({
      checkedAt,
      payload: {
        billingCycleEnd: "2026-08-01T00:00:00.000Z",
        planUsage: { includedSpend: 10, limit: 100 },
        spendLimitUsage: { used: 25, limit: 50 },
      },
    });
    expect(limits?.windows.map((window) => window.id)).toEqual(["included", "spend_limit"]);
    expect(limits?.windows[1]?.usedPercent).toBe(50);
  });
});

describe("cursorStatusAccessToken", () => {
  it("reads a top-level accessToken from agent status JSON", () => {
    expect(cursorStatusAccessToken('{"email":"a@b.c","accessToken":"tok_123"}\n')).toBe("tok_123");
  });

  it("reads a nested auth token", () => {
    expect(cursorStatusAccessToken('{"auth":{"access_token":"nested"}}\n')).toBe("nested");
  });
});
