/**
 * Cursor Agent subscription usage. Dashboard Connect RPC
 * `GetCurrentPeriodUsage` reports included spend in USD cents plus a billing
 * cycle end. `totalPercentUsed` is a different internal metric; the Limits bar
 * follows included spend / limit, matching Cursor's "included usage" copy.
 *
 * @module provider/Layers/cursorUsageLimits
 */
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

function isoFromUnknown(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
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

/** Bearer token from `agent status --format json`. */
export function cursorStatusAccessToken(stdout: string): string | undefined {
  const parsed = parseJsonObject(stdout);
  return parsed ? tokenFromRecord(parsed) : undefined;
}

function includedUsedPercent(planUsage: Record<string, unknown>): number | undefined {
  const limit = asNumber(planUsage.limit);
  const included = asNumber(planUsage.includedSpend) ?? asNumber(planUsage.totalSpend);
  const remaining = asNumber(planUsage.remaining);
  if (limit !== undefined && limit > 0 && included !== undefined) {
    return clampPercent((included / limit) * 100);
  }
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    return clampPercent(((limit - remaining) / limit) * 100);
  }
  const message = asString(planUsage.displayMessage);
  const match = message?.match(/used\s+(\d+(?:\.\d+)?)\s*%/i);
  if (match) return clampPercent(Number(match[1]));
  const totalPercent = asNumber(planUsage.totalPercentUsed);
  return totalPercent !== undefined ? clampPercent(totalPercent) : undefined;
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
  const usedPercent = planUsage
    ? includedUsedPercent(planUsage)
    : asNumber(input.payload.totalPercentUsed);
  if (usedPercent === undefined) return undefined;

  const startIso = isoFromUnknown(input.payload.billingCycleStart);
  const resetsAt = isoFromUnknown(input.payload.billingCycleEnd);
  const windows: ServerProviderUsageWindow[] = [
    {
      id: "included",
      kind: "monthly",
      label: "Included",
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: durationMinsBetween(startIso, resetsAt),
    },
  ];
  if (isRecord(input.payload.spendLimitUsage)) {
    const spend = spendLimitWindow(input.payload.spendLimitUsage, input.checkedAt, {
      ...(startIso ? { start: startIso } : {}),
      ...(resetsAt ? { end: resetsAt } : {}),
    });
    if (spend) windows.push(spend);
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}
