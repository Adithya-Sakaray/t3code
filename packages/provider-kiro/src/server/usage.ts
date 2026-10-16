/**
 * Usage history for Kiro CLI: the per-session `.json` sidecars under each
 * instance's `KIRO_HOME` (default `~/.kiro`) in `sessions/cli`.
 *
 * Each sidecar's `session_state.conversation_metadata.user_turn_metadatas`
 * records one entry per user turn. Kiro bills in credits, which are the
 * billing truth; token counters are usually zero.
 *
 * @module provider-kiro/server/usage
 */
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  EMPTY_TOTALS,
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { KiroSettings } from "../settings.ts";
import { KIRO_USD_PER_CREDIT } from "./kiroProtocol.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function meteredCredits(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let credits = 0;
  for (const entry of value) {
    const metering = record(entry);
    const unit = metering?.["unit"];
    const amount = metering?.["value"];
    if (unit !== "credit" && unit !== "credits") continue;
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) credits += amount;
  }
  return credits;
}

/** Usage records for every metered turn in one Kiro session sidecar. */
export function parseKiroSessionDocument(document: unknown): ReadonlyArray<UsageRecord> {
  const root = record(document);
  const sessionId = nonEmpty(root?.["session_id"]);
  if (root === null || sessionId === null) return [];
  const sessionState = record(root["session_state"]);
  const turns = record(sessionState?.["conversation_metadata"])?.["user_turn_metadatas"];
  if (!Array.isArray(turns)) return [];
  const sessionModel =
    nonEmpty(record(record(sessionState?.["rts_model_state"])?.["model_info"])?.["model_id"]) ??
    "auto";
  return turns.flatMap((value): ReadonlyArray<UsageRecord> => {
    const turn = record(value);
    const timestampMs = parseTimestampMs(turn?.["end_timestamp"]);
    if (turn === null || timestampMs === null) return [];
    const credits = meteredCredits(turn["metering_usage"]);
    const totals = {
      ...EMPTY_TOTALS,
      uncachedInputTokens: tokenCount(turn["input_token_count"]),
      cachedInputTokens: tokenCount(turn["cache_read_input_token_count"]),
      cacheCreationTokens: tokenCount(turn["cache_write_input_token_count"]),
      outputTokens: tokenCount(turn["output_token_count"]),
    };
    if (credits <= 0 && totalTokens(totals) === 0) return [];
    return [
      {
        provider: "kiro",
        timestampMs,
        model: nonEmpty(turn["model"]) ?? sessionModel,
        sessionId,
        totals,
        reportedCostUsd: credits > 0 ? credits * KIRO_USD_PER_CREDIT : null,
        speed: "standard",
        dedupeKey: null,
      },
    ];
  });
}

interface CachedSidecar {
  readonly mtimeMs: number;
  readonly size: number;
  readonly records: ReadonlyArray<UsageRecord>;
}

/** Parsed sidecars by path; a file is re-read only when its size or mtime moves. */
const sidecarCache = new Map<string, CachedSidecar>();

const readSessionsDir = (dir: string, windowStartMs: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { dir, files: null } satisfies ProviderUsageScan;
    const names = yield* fileSystem.readDirectory(dir);
    let failed = false;
    const files: Array<{ readonly path: string; readonly records: ReadonlyArray<UsageRecord> }> =
      [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const mtimeMs = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
      if (mtimeMs < windowStartMs) continue;
      const size = Number(info.value.size);
      const cached = sidecarCache.get(filePath);
      if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
        files.push({ path: filePath, records: cached.records });
        continue;
      }
      const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
      const document = Option.flatMap(raw, decodeJson);
      if (Option.isNone(document)) {
        failed = true;
        continue;
      }
      const records = parseKiroSessionDocument(document.value);
      sidecarCache.set(filePath, { mtimeMs, size, records });
      files.push({ path: filePath, records });
    }
    return {
      dir,
      files,
      status: failed ? "partial" : "ok",
      ...(failed ? { message: "Some Kiro session files could not be read." } : {}),
    } satisfies ProviderUsageScan;
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        dir,
        files: [],
        status: "partial",
        message: "Kiro session history could not be read.",
      } satisfies ProviderUsageScan),
    ),
  );

export type KiroUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const kiroUsageReader: ProviderUsageReader<KiroSettings, KiroUsageReaderEnv> = {
  kind: "scan",
  provider: "kiro",
  scan: Effect.fn("kiroUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    // Instances that share a KIRO_HOME share one history; read it once.
    const dirs = new Set(
      instances.map(({ environment }) =>
        path.resolve(
          expandHomePath(
            environment.KIRO_HOME?.trim() || path.join(homeDirectory, ".kiro"),
            homeDirectory,
          ),
          "sessions",
          "cli",
        ),
      ),
    );
    return yield* Effect.forEach([...dirs], (dir) => readSessionsDir(dir, windowStartMs), {
      concurrency: "unbounded",
    });
  }),
};
