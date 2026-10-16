/**
 * Kiro's ACP extensions and CLI output, decoded at the boundary.
 *
 * Kiro speaks ACP v1 plus vendor methods under `_kiro.dev/*`:
 * - `_kiro.dev/metadata` streams context fill and, at turn end, metered credits.
 * - `_kiro.dev/subagent/list_update` is the full crew roster; each child runs
 *   in its own ACP session whose `session/update` traffic follows.
 * - `_kiro.dev/commands/execute` runs a slash command (`effort`, `usage`,
 *   `model`) and answers `{ success, message, data }`.
 *
 * @module provider-kiro/server/kiroProtocol
 */
import type { ServerProviderUsageLimits, ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const KIRO_METADATA_METHOD = "_kiro.dev/metadata";
export const KIRO_SUBAGENT_LIST_UPDATE_METHOD = "_kiro.dev/subagent/list_update";
export const KIRO_COMMANDS_EXECUTE_METHOD = "_kiro.dev/commands/execute";

/** Kiro's default model id; a real model, not a sentinel. */
export const KIRO_DEFAULT_MODEL = "auto";
/** Selection option id; the V1 fork stored effort under this id, so imported threads keep it. */
export const KIRO_EFFORT_OPTION_ID = "effort";
/** Kiro credits are billed at $0.04 each once a plan's included credits run out. */
export const KIRO_USD_PER_CREDIT = 0.04;
export const KIRO_CREDITS_CURRENCY = "credits";

const KiroMeteringEntry = Schema.Struct({
  value: Schema.Number,
  unit: Schema.optionalKey(Schema.String),
  unitPlural: Schema.optionalKey(Schema.String),
});

export const KiroMetadataNotification = Schema.Struct({
  sessionId: Schema.String,
  contextUsagePercentage: Schema.optionalKey(Schema.Number),
  meteringUsage: Schema.optionalKey(Schema.Array(KiroMeteringEntry)),
  turnDurationMs: Schema.optionalKey(Schema.Number),
});
export type KiroMetadataNotification = typeof KiroMetadataNotification.Type;

const KiroSubagentStatus = Schema.Union([
  Schema.String,
  Schema.Struct({ type: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

const KiroSubagentEntry = Schema.Struct({
  sessionId: Schema.String,
  sessionName: Schema.optionalKey(Schema.String),
  agentName: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  initialQuery: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(KiroSubagentStatus),
});
export type KiroSubagentEntry = typeof KiroSubagentEntry.Type;

export const KiroSubagentListUpdate = Schema.Struct({
  subagents: Schema.optionalKey(Schema.Array(KiroSubagentEntry)),
});
export type KiroSubagentListUpdate = typeof KiroSubagentListUpdate.Type;

export const KiroCommandResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});
export type KiroCommandResult = typeof KiroCommandResult.Type;

const KiroUsageBreakdown = Schema.Struct({
  resourceType: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  used: Schema.Number,
  limit: Schema.Number,
  hasLimit: Schema.optionalKey(Schema.Boolean),
});

export const KiroUsageData = Schema.Struct({
  planName: Schema.optionalKey(Schema.String),
  billingCycleReset: Schema.optionalKey(Schema.String),
  usageBreakdowns: Schema.Array(KiroUsageBreakdown),
});
export type KiroUsageData = typeof KiroUsageData.Type;

/** `kiro-cli chat --list-models -f json`. */
export const KiroModelList = Schema.Struct({
  default_model: Schema.optionalKey(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      model_id: Schema.String,
      model_name: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
      context_window_tokens: Schema.optionalKey(Schema.Number),
      rate_multiplier: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type KiroModelList = typeof KiroModelList.Type;

/** `kiro-cli whoami -f json`. */
export const KiroWhoami = Schema.Struct({
  accountType: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
});
export type KiroWhoami = typeof KiroWhoami.Type;

/** One model as the driver knows it: what the CLI lists plus what a session probe learned. */
export interface KiroModelInfo {
  readonly id: string;
  readonly name: string;
  readonly contextWindowTokens: number | null;
  readonly rateMultiplier: number | null;
  /** Effort levels the model accepts; empty when it has none, null when not probed yet. */
  readonly effortLevels: ReadonlyArray<string> | null;
}

export function kiroModelsFromList(list: KiroModelList): ReadonlyArray<KiroModelInfo> {
  const seen = new Set<string>();
  return list.models.flatMap((model) => {
    const id = model.model_id.trim();
    if (id.length === 0 || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: model.model_name?.trim() || id,
        contextWindowTokens: positiveOrNull(model.context_window_tokens),
        rateMultiplier: positiveOrNull(model.rate_multiplier),
        effortLevels: null,
      },
    ];
  });
}

function positiveOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

const EFFORT_LEVELS_PREFIX = /available effort levels:\s*(.+)$/i;

/**
 * Effort levels from `effort {}`. Kiro answers `success: false` for models
 * without effort, so that is an empty list; anything unparseable is unknown.
 */
export function kiroEffortLevelsFromCommand(
  result: KiroCommandResult,
): ReadonlyArray<string> | null {
  if (!result.success) return [];
  const match = EFFORT_LEVELS_PREFIX.exec(result.message?.trim() ?? "");
  if (!match?.[1]) return null;
  return match[1]
    .split(",")
    .map((level) => level.trim().toLowerCase())
    .filter((level) => /^[a-z0-9_-]{1,32}$/.test(level));
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function kiroEffortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level;
}

/** Credits a metadata notification metered, or 0 when it carries none. */
export function kiroMeteredCredits(notification: KiroMetadataNotification): number {
  let credits = 0;
  for (const entry of notification.meteringUsage ?? []) {
    const unit = (entry.unitPlural ?? entry.unit ?? "credit").toLowerCase();
    if (unit !== "credit" && unit !== "credits") continue;
    if (Number.isFinite(entry.value) && entry.value > 0) credits += entry.value;
  }
  return credits;
}

/**
 * Folds one metadata notification into a session's context usage.
 *
 * Kiro reports context as a percentage of the running model's window, so the
 * token counts are that percentage of `contextWindowTokens`. Credits are
 * cumulative: each metered notification adds to the cost the thread already
 * carries. Returns null when the notification changes nothing.
 */
export function kiroContextUsageFromMetadata(input: {
  readonly notification: KiroMetadataNotification;
  readonly previous: ThreadTokenUsageSnapshot | null;
  readonly contextWindowTokens: number | null;
  /** Credits metered by other sessions (crew children) to add to this one. */
  readonly extraCredits?: number;
}): ThreadTokenUsageSnapshot | null {
  const { notification, previous } = input;
  const percentage = notification.contextUsagePercentage;
  const credits = kiroMeteredCredits(notification) + (input.extraCredits ?? 0);
  const hasPercentage = percentage !== undefined && Number.isFinite(percentage) && percentage >= 0;
  if (!hasPercentage && credits <= 0) return null;

  const maxTokens = input.contextWindowTokens ?? previous?.maxTokens ?? null;
  const usedTokens = hasPercentage
    ? maxTokens === null
      ? (previous?.usedTokens ?? 0)
      : Math.round((Math.min(100, percentage) / 100) * maxTokens)
    : (previous?.usedTokens ?? 0);
  const previousCredits =
    previous?.cost?.currency === KIRO_CREDITS_CURRENCY ? previous.cost.amount : 0;
  const totalCredits = previousCredits + credits;
  const durationMs = notification.turnDurationMs;

  return {
    ...previous,
    usedTokens,
    ...(maxTokens === null ? {} : { maxTokens: Math.max(1, Math.round(maxTokens)) }),
    ...(credits > 0 && durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs: Math.trunc(durationMs) }
      : {}),
    ...(totalCredits > 0
      ? { cost: { amount: totalCredits, currency: KIRO_CREDITS_CURRENCY } }
      : {}),
  };
}

function rosterStatus(entry: KiroSubagentEntry): string {
  const status = entry.status;
  return (typeof status === "string" ? status : (status?.type ?? "")).trim().toLowerCase();
}

/** Maps a roster entry to the shared adapter's subagent update. */
export function kiroSubagentUpdateFromRoster(entry: KiroSubagentEntry): AcpAdapterV2SubagentUpdate {
  const status = rosterStatus(entry);
  return {
    nativeTaskId: entry.sessionId,
    prompt: entry.initialQuery?.trim() ?? "",
    title: entry.sessionName?.trim() || entry.agentName?.trim() || null,
    model: null,
    status:
      status === "terminated" || status === "completed" || status === "done"
        ? "completed"
        : status === "failed" || status === "error"
          ? "failed"
          : status === "cancelled" || status === "canceled" || status === "stopped"
            ? "cancelled"
            : status === "pending" || status === "queued"
              ? "pending"
              : "running",
    childSessionId: entry.sessionId,
    result: null,
    suppressNormalTool: true,
  };
}

/** Kiro's monthly credit allowance as a usage window. */
export function kiroUsageLimitsFromData(input: {
  readonly data: KiroUsageData;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const credits =
    input.data.usageBreakdowns.find((entry) => entry.resourceType === "CREDIT") ??
    input.data.usageBreakdowns[0];
  if (credits === undefined || credits.hasLimit === false || !(credits.limit > 0)) {
    return undefined;
  }
  const resetsAt = kiroResetDate(input.data.billingCycleReset);
  return {
    checkedAt: input.checkedAt,
    windows: [
      {
        id: "credits",
        kind: "monthly",
        label: input.data.planName?.trim()
          ? `${input.data.planName.trim()} credits`
          : (credits.displayName?.trim() ?? "Credits"),
        usedPercent: Math.max(0, Math.min(100, (credits.used / credits.limit) * 100)),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ],
  };
}

function kiroResetDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // Kiro reports a bare UTC date for the billing cycle reset.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  return Option.getOrUndefined(Option.map(DateTime.make(iso), DateTime.formatIso));
}

function kiroToolName(update: EffectAcpSchema.SessionNotification["update"]): string | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  const kiro = (update._meta as { readonly kiro?: { readonly toolName?: unknown } } | null)?.kiro;
  return typeof kiro?.toolName === "string" ? kiro.toolName : undefined;
}

/**
 * A crew child answers, reports that answer through its `summary` tool, then
 * repeats it as text. The repeat would run into the first answer in the
 * subagent's message, so text a session streams after its summary is blanked.
 * `summarizedSessions` remembers which sessions have summarized.
 */
export function kiroDropSummaryEcho(
  summarizedSessions: Set<string>,
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const { update } = notification;
  if (kiroToolName(update) === "summary") {
    summarizedSessions.add(notification.sessionId);
    return notification;
  }
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text" &&
    summarizedSessions.has(notification.sessionId)
  ) {
    return { ...notification, update: { ...update, content: { ...update.content, text: "" } } };
  }
  return notification;
}
