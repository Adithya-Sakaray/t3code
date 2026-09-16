/**
 * Kiro CLI subscription usage. `/usage` is a TUI card; ACP exposes the same
 * payload through `_kiro.dev/commands/execute` `{ command: "usage" }` as
 * `result.data`. Shapes vary by CLI version, so this mapper is structural.
 *
 * @module provider/Layers/kiroUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
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
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value > 1e12 ? value : value * 1000;
    const dt = DateTime.make(millis);
    return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
  }
  const text = asString(value);
  if (!text) return undefined;
  const dt = DateTime.make(text);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function labelForKind(kind: ServerProviderUsageWindow["kind"], fallback: string): string {
  if (kind === "session") return "Session";
  if (kind === "weekly") return "Weekly";
  if (kind === "monthly") return fallback === "Credits" ? "Credits" : "Monthly";
  return fallback;
}

function usedPercentFrom(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return clampPercent((used / limit) * 100);
}

function unwrapUsageRoot(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.data !== undefined) return unwrapUsageRoot(payload.data);
  if (
    payload.result !== undefined &&
    isRecord(payload.result) &&
    payload.result.data !== undefined
  ) {
    return unwrapUsageRoot(payload.result.data);
  }
  return payload;
}

function breakdownRows(root: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!isRecord(root)) return [];
  const list = root.usageBreakdowns ?? root.usageBreakdownList ?? root.breakdowns;
  if (Array.isArray(list)) {
    return list.filter(isRecord);
  }
  return [];
}

function windowFromBreakdown(
  row: Record<string, unknown>,
  index: number,
): ServerProviderUsageWindow | undefined {
  const used = asNumber(row.currentUsage) ?? asNumber(row.used) ?? asNumber(row.creditsUsed);
  const limit = asNumber(row.usageLimit) ?? asNumber(row.limit) ?? asNumber(row.creditsTotal);
  const remaining = asNumber(row.remaining);
  const usedPercent =
    usedPercentFrom(used, limit) ??
    (limit !== undefined && remaining !== undefined
      ? usedPercentFrom(limit - remaining, limit)
      : undefined) ??
    asNumber(row.utilization) ??
    asNumber(row.usedPercent);
  if (usedPercent === undefined) return undefined;

  const resetsAt =
    isoFromUnknown(row.resetDate) ??
    isoFromUnknown(row.nextDateReset) ??
    isoFromUnknown(row.resetsAt) ??
    isoFromUnknown(row.resetAt);
  const type = (asString(row.type) ?? asString(row.displayName) ?? "credit").toLowerCase();
  const kind = type.includes("session")
    ? "session"
    : type.includes("week")
      ? "weekly"
      : type.includes("trial") || type.includes("bonus")
        ? "other"
        : "monthly";
  const display = asString(row.displayNamePlural) ?? asString(row.displayName) ?? "Credits";
  const id =
    type.includes("trial") || type.includes("bonus")
      ? `trial_${index}`
      : type.includes("session")
        ? "session"
        : "credits";
  const windowDurationMins =
    kind === "session" ? SESSION_MINS : kind === "weekly" ? WEEK_MINS : MONTH_MINS;
  return {
    id,
    kind,
    label: labelForKind(kind, display),
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins,
  };
}

function windowsFromFlatCredits(root: Record<string, unknown>): ServerProviderUsageWindow[] {
  const used =
    asNumber(root.credits_used) ??
    asNumber(root.creditsUsed) ??
    asNumber(root.used) ??
    asNumber(root.currentUsage);
  const total =
    asNumber(root.credits_total) ??
    asNumber(root.creditsTotal) ??
    asNumber(root.limit) ??
    asNumber(root.usageLimit) ??
    asNumber(root.credits_limit);
  const remaining = asNumber(root.remaining) ?? asNumber(root.creditsRemaining);
  const usedPercent =
    asNumber(root.pct) ??
    asNumber(root.usedPercent) ??
    usedPercentFrom(used, total) ??
    (total !== undefined && remaining !== undefined
      ? usedPercentFrom(total - remaining, total)
      : undefined);
  if (usedPercent === undefined) return [];
  const resetsAt =
    isoFromUnknown(root.resets) ??
    isoFromUnknown(root.resetDate) ??
    isoFromUnknown(root.nextDateReset) ??
    isoFromUnknown(root.resetsAt);
  return [
    {
      id: "credits",
      kind: "monthly",
      label: "Credits",
      usedPercent: clampPercent(usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: MONTH_MINS,
    },
  ];
}

/**
 * Map an ACP `/usage` execute result (or its `data` payload) onto subscription
 * windows. Returns undefined when the payload has no usable quota numbers.
 */
export function kiroUsagePayloadToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const root = unwrapUsageRoot(input.payload);
  const windows: ServerProviderUsageWindow[] = [];
  const seen = new Set<string>();
  for (const [index, row] of breakdownRows(root).entries()) {
    const window = windowFromBreakdown(row, index);
    if (!window || seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }
  if (windows.length === 0 && isRecord(root)) {
    windows.push(...windowsFromFlatCredits(root));
  }
  if (windows.length === 0) return undefined;
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}
