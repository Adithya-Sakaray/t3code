import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  cursorAuthTokenFromJson,
  cursorCliAuthJsonPath,
  cursorPeriodUsageToLimits,
  cursorStatusAccessToken,
} from "./cursorUsageLimits.ts";

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

  it("uses Auto and API percents instead of includedSpend/limit when the included bucket is full", () => {
    const limits = cursorPeriodUsageToLimits({
      checkedAt,
      payload: {
        billingCycleStart: "1787228382000",
        billingCycleEnd: "1789906782000",
        planUsage: {
          totalSpend: 56831,
          includedSpend: 7000,
          bonusSpend: 49831,
          limit: 7000,
          autoPercentUsed: 40.305,
          apiPercentUsed: 76.95454545454545,
          totalPercentUsed: 43.382442748091606,
          autoModelSelectedDisplayMessage: "You've used 43% of your included total usage",
          namedModelSelectedDisplayMessage: "You've used 77% of your included API usage",
        },
      },
    });
    expect(
      limits?.windows.map((window) => ({
        id: window.id,
        label: window.label,
        used: window.usedPercent,
      })),
    ).toEqual([
      { id: "included", label: "Auto", used: 40.305 },
      { id: "included_api", label: "API", used: 76.95454545454545 },
    ]);
  });
});

describe("cursorStatusAccessToken", () => {
  it("reads a top-level accessToken from agent status JSON", () => {
    expect(cursorStatusAccessToken('{"email":"a@b.c","accessToken":"tok_123"}\n')).toBe("tok_123");
  });

  it("reads a nested auth token", () => {
    expect(cursorStatusAccessToken('{"auth":{"access_token":"nested"}}\n')).toBe("nested");
  });

  it("ignores the current CLI's hasAccessToken boolean", () => {
    expect(
      cursorStatusAccessToken(
        JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          hasAccessToken: true,
          hasRefreshToken: true,
          userInfo: { email: "a@b.c" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("cursorAuthTokenFromJson", () => {
  it("reads accessToken from the CLI login file", () => {
    expect(cursorAuthTokenFromJson({ accessToken: "tok_file", refreshToken: "ref" })).toBe(
      "tok_file",
    );
  });
});

describe("cursorCliAuthJsonPath", () => {
  it("uses XDG config on Linux", () => {
    expect(cursorCliAuthJsonPath({ HOME: "/home/ada", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(
      NodePath.join("/xdg", "cursor", "auth.json"),
    );
    expect(cursorCliAuthJsonPath({ HOME: "/home/ada" }, "linux")).toBe(
      NodePath.join("/home/ada", ".config", "cursor", "auth.json"),
    );
  });

  it("uses ~/.cursor on macOS and %APPDATA%/Cursor on Windows", () => {
    expect(cursorCliAuthJsonPath({ HOME: "/Users/ada" }, "darwin")).toBe(
      NodePath.join("/Users/ada", ".cursor", "auth.json"),
    );
    expect(cursorCliAuthJsonPath({ APPDATA: "/appdata" }, "win32")).toBe(
      NodePath.join("/appdata", "Cursor", "auth.json"),
    );
  });
});
