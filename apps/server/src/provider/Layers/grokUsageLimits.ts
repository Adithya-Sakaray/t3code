/**
 * Grok Build subscription usage. The CLI's `x.ai/billing` ACP method and the
 * CLI-proxy `GET /v1/billing?format=credits` response share a config object:
 * prefer `creditUsagePercent` + `currentPeriod`, then the older
 * `monthlyLimit` / `used` pair. A period without a percentage is unknown, not 0%.
 *
 * @module provider/Layers/grokUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { clampPercent, makeUsageLimits } from "../providerUsageLimits.ts";

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

function centVal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value)) return asNumber(value.val);
  return undefined;
}

function isoFromUnknown(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const dt = DateTime.make(text);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function durationMinsBetween(
  startIso: string | undefined,
  endIso: string | undefined,
): number | undefined {
  if (!startIso || !endIso) return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.max(1, Math.round((end - start) / 60_000));
}

function kindFromPeriodType(
  periodType: string | undefined,
  durationMins: number | undefined,
): ServerProviderUsageWindow["kind"] {
  const type = periodType?.toUpperCase() ?? "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (durationMins !== undefined) {
    if (durationMins >= MONTH_MINS * 0.8) return "monthly";
    if (durationMins >= WEEK_MINS * 0.8) return "weekly";
  }
  return "weekly";
}

function unwrapConfig(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.config)) return payload.config;
  if (payload.creditUsagePercent !== undefined || payload.currentPeriod !== undefined) {
    return payload;
  }
  if (payload.billingCycle !== undefined || payload.monthlyLimit !== undefined) {
    return payload;
  }
  return payload;
}

function grokBuildProductPercent(config: Record<string, unknown>): number | undefined {
  const products = config.productUsage;
  if (!Array.isArray(products)) return undefined;
  for (const entry of products) {
    if (!isRecord(entry)) continue;
    const product = (asString(entry.product) ?? "").toLowerCase().replace(/_/g, "");
    if (!product.includes("grokbuild") && product !== "productgrokbuild") continue;
    const percent = asNumber(entry.usagePercent) ?? asNumber(entry.creditUsagePercent);
    if (percent !== undefined) return percent;
  }
  return undefined;
}

function usedPercentFromConfig(config: Record<string, unknown>): number | undefined {
  const direct = asNumber(config.creditUsagePercent);
  if (direct !== undefined) return clampPercent(direct);
  const product = grokBuildProductPercent(config);
  if (product !== undefined) return clampPercent(product);

  const monthlyLimit = centVal(config.monthlyLimit) ?? centVal(config.monthly_limit);
  const used =
    centVal(config.used) ??
    (isRecord(config.usage)
      ? (centVal(config.usage.totalUsed) ?? centVal(config.usage.includedUsed))
      : undefined);
  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    return clampPercent((used / monthlyLimit) * 100);
  }

  const cap = centVal(config.onDemandCap) ?? centVal(config.on_demand_cap);
  const onDemandUsed = centVal(config.onDemandUsed) ?? centVal(config.on_demand_used);
  if (cap !== undefined && cap > 0 && onDemandUsed !== undefined) {
    return clampPercent((onDemandUsed / cap) * 100);
  }
  return undefined;
}

/**
 * Map an `x.ai/billing` ACP result or CLI-proxy credits JSON onto one Credits
 * window. Returns undefined when the payload has no usable percentage.
 */
export function grokBillingToLimits(input: {
  readonly payload: unknown;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const config = unwrapConfig(input.payload);
  if (!config) return undefined;
  const usedPercent = usedPercentFromConfig(config);
  if (usedPercent === undefined) return undefined;

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const billingCycle = isRecord(config.billingCycle) ? config.billingCycle : undefined;
  const startIso =
    isoFromUnknown(period?.start) ??
    isoFromUnknown(config.billingPeriodStart) ??
    isoFromUnknown(billingCycle?.billingPeriodStart);
  const resetsAt =
    isoFromUnknown(period?.end) ??
    isoFromUnknown(config.billingPeriodEnd) ??
    isoFromUnknown(billingCycle?.billingPeriodEnd);
  const durationMins =
    durationMinsBetween(startIso, resetsAt) ??
    (kindFromPeriodType(asString(period?.type), undefined) === "monthly" ? MONTH_MINS : WEEK_MINS);
  const kind = kindFromPeriodType(asString(period?.type), durationMins);
  const window: ServerProviderUsageWindow = {
    id: "credits",
    kind,
    label: kind === "monthly" ? "Monthly" : "Weekly",
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
    windowDurationMins: durationMins,
  };
  return makeUsageLimits({ checkedAt: input.checkedAt, windows: [window] });
}

/**
 * Pick a still-valid SuperGrok bearer from `~/.grok/auth.json`. Entries are
 * keyed by OIDC issuer URL; prefer `auth.x.ai`.
 */
export function grokAuthTokenFromJson(parsed: unknown, nowMs: number): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const entries = Object.entries(parsed)
    .filter(([, value]) => isRecord(value) && asString(value.key))
    .toSorted(([left], [right]) => {
      const score = (key: string) =>
        key.includes("auth.x.ai") ? 0 : key.includes("accounts.x.ai") ? 1 : 2;
      return score(left) - score(right);
    });
  for (const [, value] of entries) {
    if (!isRecord(value)) continue;
    const key = asString(value.key);
    if (!key) continue;
    const expiresAt = asString(value.expires_at) ?? asString(value.expiresAt);
    if (expiresAt) {
      const at = Date.parse(expiresAt);
      if (Number.isFinite(at) && at <= nowMs) continue;
    }
    return key;
  }
  return undefined;
}
