import { describe, expect, it } from "vite-plus/test";

import { kiroUsagePayloadToLimits } from "./kiroUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("kiroUsagePayloadToLimits", () => {
  it("maps CREDIT breakdowns onto a monthly credits window", () => {
    expect(
      kiroUsagePayloadToLimits({
        checkedAt,
        payload: {
          data: {
            usageBreakdowns: [
              {
                type: "CREDIT",
                currentUsage: 40,
                usageLimit: 50,
                resetDate: "2026-08-01T00:00:00.000Z",
                displayName: "Credit",
                displayNamePlural: "Credits",
              },
            ],
          },
        },
      }),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "credits",
          kind: "monthly",
          label: "Credits",
          usedPercent: 80,
          resetsAt: "2026-08-01T00:00:00.000Z",
          windowDurationMins: 43200,
        },
      ],
    });
  });

  it("reads a flat credits_used / credits_total payload", () => {
    const limits = kiroUsagePayloadToLimits({
      checkedAt,
      payload: {
        credits_used: 1979.44,
        credits_total: 2000,
        pct: 98.9,
        resets: "2026-08-01",
      },
    });
    expect(limits?.windows[0]?.id).toBe("credits");
    expect(limits?.windows[0]?.usedPercent).toBe(98.9);
    expect(limits?.windows[0]?.resetsAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns undefined when the execute ack has no quota numbers", () => {
    expect(kiroUsagePayloadToLimits({ checkedAt, payload: { ok: true } })).toBeUndefined();
  });
});
