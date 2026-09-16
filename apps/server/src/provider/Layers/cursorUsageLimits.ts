/**
 * Cursor Agent subscription usage. Dashboard Connect RPC
 * `GetCurrentPeriodUsage` reports included spend in USD cents plus a billing
 * cycle end. `totalPercentUsed` is a different internal metric; the Limits bar
 * follows included spend / limit, matching Cursor's "included usage" copy.
 *
 * Newer `agent status --format json` only reports `hasAccessToken: true` and
 * no longer prints the bearer. The probe still accepts a token from status
 * when present, then the CLI login file (`auth.json`) the agent itself uses.
 *
 * @module provider/Layers/cursorUsageLimits
 */
import * as NodePath from "node:path";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

const MONTH_MINS = 30 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoFromMillis(millis: number): string | undefined {
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  const dt = DateTime.make(millis);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromUnknown(value: unknown): string | undefined {
  if (typeof value === "number") return isoFromMillis(value > 1e12 ? value : value * 1000);
  const text = asString(value);
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const epoch = Number(text);
    return isoFromMillis(text.length >= 13 ? epoch : epoch * 1000);
  }
  const dt = DateTime.make(text);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function durationMinsBetween(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return MONTH_MINS;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return MONTH_MINS;
  return Math.max(1, Math.round((end - start) / 60_000));
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tokenFromRecord(record: Record<string, unknown>): string | undefined {
  const direct =
    asString(record.accessToken) ??
    asString(record.access_token) ??
    asString(record.token) ??
    asString(record.authToken);
  if (direct) return direct;
  if (isRecord(record.auth)) return tokenFromRecord(record.auth);
  if (isRecord(record.credentials)) return tokenFromRecord(record.credentials);
  return undefined;
}

/** Bearer token from `agent status --format json`. Booleans like `hasAccessToken` do not count. */
export function cursorStatusAccessToken(stdout: string): string | undefined {
  const parsed = parseJsonObject(stdout);
  return parsed ? tokenFromRecord(parsed) : undefined;
}

/** Bearer token from the Cursor Agent login file. */
export function cursorAuthTokenFromJson(parsed: unknown): string | undefined {
  return isRecord(parsed) ? tokenFromRecord(parsed) : undefined;
}

/**
 * Login file the Cursor Agent reads for `agent login`. Windows uses `%APPDATA%/Cursor`,
 * macOS `~/.cursor`, Linux `$XDG_CONFIG_HOME/cursor` (or `~/.config/cursor`).
 */
export function cursorCliAuthJsonPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  if (platform === "win32") {
    const appData =
      environment.APPDATA?.trim() || (home ? NodePath.join(home, "AppData", "Roaming") : "");
    return NodePath.join(appData, "Cursor", "auth.json");
  }
  if (platform === "darwin") {
    return NodePath.join(home, ".cursor", "auth.json");
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return NodePath.join(configHome, "cursor", "auth.json");
}

function percentFromDisplayMessage(
  ...messages: ReadonlyArray<string | undefined>
): number | undefined {
  for (const message of messages) {
    const match = message?.match(/used\s+(\d+(?:\.\d+)?)\s*%/i);
    if (match) return clampPercent(Number(match[1]));
  }
  return undefined;
}

function spendUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const limit = asNumber(planUsage.limit);
  const included = asNumber(planUsage.includedSpend) ?? asNumber(planUsage.totalSpend);
  const remaining = asNumber(planUsage.remaining);
  if (limit !== undefined && limit > 0 && included !== undefined) {
    return clampPercent((included / limit) * 100);
  }
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    return clampPercent(((limit - remaining) / limit) * 100);
  }
  return undefined;
}

/**
 * Cursor's dashboard now reports Auto vs API percents separately. `includedSpend`
 * often equals `limit` once the included-dollar bucket is full, even when Auto
 * still has headroom — that ratio is not the number the product shows.
 */
function includedUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const auto = asNumber(planUsage.autoPercentUsed);
  if (auto !== undefined) return clampPercent(auto);
  const fromCopy = percentFromDisplayMessage(
    asString(planUsage.autoModelSelectedDisplayMessage),
    asString(planUsage.displayMessage),
  );
  if (fromCopy !== undefined) return fromCopy;
  const spend = spendUsedPercent(planUsage);
  if (spend !== undefined) return spend;
  const totalPercent = asNumber(planUsage.totalPercentUsed);
  return totalPercent !== undefined ? clampPercent(totalPercent) : undefined;
}

function apiUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const api = asNumber(planUsage.apiPercentUsed);
  if (api !== undefined) return clampPercent(api);
  return percentFromDisplayMessage(asString(planUsage.namedModelSelectedDisplayMessage));
}

function spendLimitWindow(
  spend: Record<string, unknown>,
  checkedAt: string,
  cycle: { start?: string; end?: string },
): ServerProviderUsageWindow | undefined {
  const limit = asNumber(spend.limit) ?? asNumber(spend.spendLimit);
  const used = asNumber(spend.used) ?? asNumber(spend.spent) ?? asNumber(spend.currentSpend);
  if (limit === undefined || limit <= 0 || used === undefined) return undefined;
  const resetsAt = isoFromUnknown(cycle.end);
  return {
    id: "spend_limit",
    kind: "monthly",
    label: "Spend limit",
    usedPercent: clampPercent((used / limit) * 100),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins: durationMinsBetween(cycle.start, cycle.end),
  };
}

/**
 * Map `GetCurrentPeriodUsage` JSON onto monthly included-usage (and optional
 * spend-limit) windows. Returns undefined when no quota percentage is present.
 */
export function cursorPeriodUsageToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  if (!isRecord(input.payload)) return undefined;
  const planUsage = isRecord(input.payload.planUsage) ? input.payload.planUsage : undefined;
  const includedPercent = planUsage
    ? includedUsedPercent(planUsage)
    : asNumber(input.payload.totalPercentUsed);
  const namedPercent = planUsage ? apiUsedPercent(planUsage) : undefined;
  if (includedPercent === undefined && namedPercent === undefined) return undefined;

  const startIso = isoFromUnknown(input.payload.billingCycleStart);
  const resetsAt = isoFromUnknown(input.payload.billingCycleEnd);
  const windowDurationMins = durationMinsBetween(startIso, resetsAt);
  const windows: ServerProviderUsageWindow[] = [];
  if (includedPercent !== undefined) {
    windows.push({
      id: "included",
      kind: "monthly",
      label: planUsage && asNumber(planUsage.autoPercentUsed) !== undefined ? "Auto" : "Included",
      usedPercent: includedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  }
  if (namedPercent !== undefined) {
    windows.push({
      id: "included_api",
      kind: "monthly",
      label: "API",
      usedPercent: namedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  }
  if (isRecord(input.payload.spendLimitUsage)) {
    const spend = spendLimitWindow(input.payload.spendLimitUsage, input.checkedAt, {
      ...(startIso ? { start: startIso } : {}),
      ...(resetsAt ? { end: resetsAt } : {}),
    });
    if (spend) windows.push(spend);
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}
