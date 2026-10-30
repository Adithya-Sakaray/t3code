// Background checks run only `--version`, `whoami`, and `chat --list-models`. Effort, modes, and
// the credit window need a live ACP session, which boots the user's MCP servers, so that probe
// runs only when Kiro's version or models change, or on refresh, and is cached per instance.
import {
  ServerProviderUsageLimits,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { KiroSettings } from "../settings.ts";
import {
  executeKiroCommand,
  KIRO_SUPPORTED_RUNTIME_MODES,
  makeKiroAcpRuntime,
} from "./acpSupport.ts";
import {
  KIRO_DEFAULT_MODEL,
  KIRO_EFFORT_OPTION_ID,
  KiroModelList,
  KiroUsageData,
  KiroWhoami,
  kiroEffortLabel,
  kiroEffortLevelsFromCommand,
  kiroModelsFromList,
  kiroUsageLimitsFromData,
  type KiroModelInfo,
} from "./kiroProtocol.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  supportedRuntimeModes: KIRO_SUPPORTED_RUNTIME_MODES,
} as const;

const CLI_TIMEOUT_MS = 10_000;

const KIRO_ACCOUNT_TYPE_LABELS: Record<string, string> = {
  IamIdentityCenter: "IAM Identity Center",
  BuilderId: "Builder ID",
};
const SESSION_PROBE_TIMEOUT_MS = 90_000;

const KiroMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
type KiroMode = typeof KiroMode.Type;

/** What a session probe learned, persisted under the provider cache directory. */
const KiroCapabilityCache = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  probedAt: Schema.String,
  effortLevels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  modes: Schema.Array(KiroMode),
  currentModeId: Schema.NullOr(Schema.String),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
});
export type KiroCapabilityCache = typeof KiroCapabilityCache.Type;
const KiroCapabilityCacheJson = Schema.fromJsonString(KiroCapabilityCache);
const decodeCapabilityCache = Schema.decodeUnknownEffect(KiroCapabilityCacheJson);
const encodeCapabilityCache = Schema.encodeEffect(KiroCapabilityCacheJson);
const decodeModelList = Schema.decodeUnknownOption(Schema.fromJsonString(KiroModelList));
const decodeWhoami = Schema.decodeUnknownOption(Schema.fromJsonString(KiroWhoami));
const decodeUsageData = Schema.decodeUnknownOption(KiroUsageData);

function modeLabel(mode: KiroMode): string {
  const name = mode.name.trim() || mode.id;
  const bare = name.replace(/^kiro_/, "").replace(/_/g, " ");
  return name.startsWith("kiro_") ? bare.charAt(0).toUpperCase() + bare.slice(1) : name;
}

function buildKiroModelCapabilities(input: {
  readonly effortLevels: ReadonlyArray<string> | null;
  readonly modes: ReadonlyArray<KiroMode>;
  readonly currentModeId: string | null;
}): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      ...(input.effortLevels !== null && input.effortLevels.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: KIRO_EFFORT_OPTION_ID,
              label: "Effort",
              options: input.effortLevels.map((level) => ({
                value: level,
                label: kiroEffortLabel(level),
              })),
            }),
          ]
        : []),
      ...(input.modes.length > 1
        ? [
            buildSelectOptionDescriptor({
              id: ACP_SESSION_MODE_OPTION_ID,
              label: "Mode",
              options: input.modes.map((mode) => ({
                value: mode.id,
                label: modeLabel(mode),
                ...(mode.description ? { description: mode.description } : {}),
                ...(mode.id === input.currentModeId ? { isDefault: true } : {}),
              })),
            }),
          ]
        : []),
    ],
  });
}

export function buildKiroServerModels(input: {
  readonly models: ReadonlyArray<KiroModelInfo>;
  readonly defaultModelId: string;
  readonly cache: KiroCapabilityCache | null;
  readonly settings: Pick<KiroSettings, "customModels">;
}): ReadonlyArray<ServerProviderModel> {
  const modes = input.cache?.modes ?? [];
  const currentModeId = input.cache?.currentModeId ?? null;
  const builtIn = input.models.map((model): ServerProviderModel => ({
    slug: model.id,
    name: model.name,
    isCustom: false,
    ...(model.id === input.defaultModelId ? { isDefault: true } : {}),
    capabilities: buildKiroModelCapabilities({
      effortLevels: input.cache?.effortLevels[model.id] ?? null,
      modes,
      currentModeId,
    }),
  }));
  return providerModelsFromSettings(
    builtIn,
    input.settings.customModels,
    buildKiroModelCapabilities({ effortLevels: null, modes, currentModeId }),
  );
}

const FALLBACK_MODELS: ReadonlyArray<KiroModelInfo> = [
  {
    id: KIRO_DEFAULT_MODEL,
    name: KIRO_DEFAULT_MODEL,
    contextWindowTokens: null,
    rateMultiplier: null,
    effortLevels: null,
  },
];

export const buildInitialKiroProviderSnapshot = Effect.fn(
  "KiroStatus.buildInitialKiroProviderSnapshot",
)(function* (settings: KiroSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: buildKiroServerModels({
      models: FALLBACK_MODELS,
      defaultModelId: KIRO_DEFAULT_MODEL,
      cache: null,
      settings,
    }),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Kiro CLI availability..."
        : "Kiro is disabled in T3 Code settings.",
    },
  });
});

const runKiroCli = Effect.fn("KiroStatus.runKiroCli")(function* (
  settings: Pick<KiroSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "kiro-cli";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
}, Effect.timeoutOption(CLI_TIMEOUT_MS));

export function kiroAuthFromWhoami(
  output: { readonly code: number; readonly stdout: string; readonly stderr: string } | undefined,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  if (output.code !== 0) {
    // Signed out, kiro-cli exits 1 printing `{"account":null}`.
    return /"account"\s*:\s*null|not logged in/i.test(`${output.stdout}\n${output.stderr}`)
      ? { status: "unauthenticated" }
      : { status: "unknown" };
  }
  // `whoami -f json` prints the account object, then a plain-text profile section.
  const whoami = decodeWhoami(extractJsonObject(output.stdout));
  if (Option.isNone(whoami)) return { status: "unknown" };
  return {
    status: "authenticated",
    ...(whoami.value.email?.trim() ? { email: whoami.value.email.trim() } : {}),
    ...(whoami.value.accountType?.trim()
      ? {
          type:
            KIRO_ACCOUNT_TYPE_LABELS[whoami.value.accountType.trim()] ??
            whoami.value.accountType.trim(),
        }
      : {}),
  };
}

const readKiroCapabilityCache = Effect.fn("KiroStatus.readKiroCapabilityCache")(
  function* (cacheFile: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(cacheFile);
    return yield* decodeCapabilityCache(raw);
  },
  Effect.asSome,
  Effect.catchCause(() => Effect.succeed(Option.none<KiroCapabilityCache>())),
);

const writeKiroCapabilityCache = (cacheFile: string, cache: KiroCapabilityCache) =>
  encodeCapabilityCache(cache).pipe(
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cacheFile, contents })),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to write the Kiro capability cache", { cause }),
    ),
  );

/** Whether the cache still describes this Kiro install and every model it lists. */
export function kiroCapabilityCacheIsCurrent(input: {
  readonly cache: KiroCapabilityCache | null;
  readonly version: string | null;
  readonly modelIds: ReadonlyArray<string>;
}): boolean {
  const { cache } = input;
  return (
    cache !== null &&
    cache.version === input.version &&
    input.modelIds.every((id) => Object.hasOwn(cache.effortLevels, id))
  );
}

/**
 * Opens one ACP session, never prompting it, to read what only a session
 * reports: effort levels per model, agent modes, and the credit window.
 */
const probeKiroSession = Effect.fn("KiroStatus.probeKiroSession")(
  function* (input: {
    readonly settings: KiroSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly modelIds: ReadonlyArray<string>;
    readonly version: string | null;
  }) {
    const runtime = yield* makeKiroAcpRuntime({
      kiroSettings: input.settings,
      environment: input.environment,
      cwd: input.cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    const sessionId = started.sessionId;
    const effortLevels: Record<string, ReadonlyArray<string>> = {};
    for (const modelId of input.modelIds) {
      const levels = yield* runtime.setSessionModel(modelId).pipe(
        Effect.andThen(executeKiroCommand(runtime, { sessionId, command: "effort" })),
        Effect.map(kiroEffortLevelsFromCommand),
        Effect.orElseSucceed(() => null),
      );
      if (levels !== null) effortLevels[modelId] = levels;
    }
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const usage = yield* executeKiroCommand(runtime, { sessionId, command: "usage" }).pipe(
      Effect.map((result) => (result.success ? decodeUsageData(result.data) : Option.none())),
      Effect.orElseSucceed(() => Option.none<KiroUsageData>()),
    );
    const usageLimits = Option.isSome(usage)
      ? kiroUsageLimitsFromData({ data: usage.value, checkedAt })
      : undefined;
    const modes = started.sessionSetupResult.modes;
    return {
      version: input.version,
      probedAt: checkedAt,
      effortLevels,
      modes: (modes?.availableModes ?? []).map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
      currentModeId: modes?.currentModeId ?? null,
      ...(usageLimits === undefined ? {} : { usageLimits }),
    } satisfies KiroCapabilityCache;
  },
  Effect.scoped,
  Effect.timeoutOption(SESSION_PROBE_TIMEOUT_MS),
);

export interface KiroStatusInput {
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  /** Where session probes start Kiro; the server's working directory. */
  readonly probeCwd: string;
  readonly cacheFile: string;
  /** Explicit model refresh: probe a session even when the cache is current. */
  readonly forceSessionProbe: boolean;
}

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  input: KiroStatusInput,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const { settings, environment } = input;
  if (!settings.enabled) return yield* buildInitialKiroProviderSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallback = (probe: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly message: string;
  }) =>
    buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: buildKiroServerModels({
        models: FALLBACK_MODELS,
        defaultModelId: KIRO_DEFAULT_MODEL,
        cache: null,
        settings,
      }),
      probe: { ...probe, status: "error", auth: { status: "unknown" } },
    });

  const versionResult = yield* runKiroCli(settings, ["--version"], environment).pipe(Effect.result);
  if (versionResult._tag === "Failure") {
    const missing = isCommandMissingCause(versionResult.failure);
    return fallback({
      installed: !missing,
      version: null,
      message: missing
        ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
        : "Failed to run the Kiro CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return fallback({
      installed: true,
      version: null,
      message: "Kiro CLI is installed but `kiro-cli --version` timed out.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return fallback({
      installed: true,
      version,
      message: "Kiro CLI is installed but failed to run.",
    });
  }

  const [whoamiResult, modelsResult] = yield* Effect.all(
    [
      runKiroCli(settings, ["whoami", "-f", "json"], environment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      ),
      runKiroCli(settings, ["chat", "--list-models", "-f", "json"], environment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      ),
    ],
    { concurrency: 2 },
  );
  const auth = kiroAuthFromWhoami(whoamiResult);
  const modelList =
    modelsResult !== undefined && modelsResult.code === 0
      ? Option.getOrUndefined(decodeModelList(modelsResult.stdout.trim()))
      : undefined;
  const models = modelList === undefined ? FALLBACK_MODELS : kiroModelsFromList(modelList);
  const defaultModelId = modelList?.default_model?.trim() || KIRO_DEFAULT_MODEL;

  let cache = Option.getOrNull(yield* readKiroCapabilityCache(input.cacheFile));
  const canProbe = auth.status === "authenticated" && modelList !== undefined;
  if (
    canProbe &&
    (input.forceSessionProbe ||
      !kiroCapabilityCacheIsCurrent({ cache, version, modelIds: models.map((model) => model.id) }))
  ) {
    const probed = yield* probeKiroSession({
      settings,
      environment,
      cwd: input.probeCwd,
      modelIds: models.map((model) => model.id),
      version,
    }).pipe(Effect.orElseSucceed(() => Option.none<KiroCapabilityCache>()));
    if (Option.isSome(probed)) {
      cache = probed.value;
      yield* writeKiroCapabilityCache(input.cacheFile, probed.value);
    } else {
      yield* Effect.logWarning(
        "Kiro session probe failed or timed out; keeping cached capabilities",
      );
    }
  }

  // The last credit window a probe or a metered turn saved; turns keep it current.
  const usageLimits = cache?.usageLimits;

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: true,
    checkedAt,
    models: buildKiroServerModels({ models, defaultModelId, cache, settings }),
    probe: {
      installed: true,
      version,
      status: auth.status === "unauthenticated" ? "error" : "ready",
      auth,
      ...(auth.status === "unauthenticated"
        ? { message: "Kiro CLI is not signed in. Run `kiro-cli login` on this machine." }
        : modelList === undefined
          ? { message: "Kiro CLI did not list its models." }
          : {}),
      ...(usageLimits === undefined ? {} : { usageLimits }),
    },
  });
});

/**
 * Saves a credit window a metered turn reported, so status checks between
 * turns and after a restart keep showing it.
 */
export const rememberKiroUsageLimits = (
  cacheFile: string,
  usageLimits: ServerProviderUsageLimits,
) =>
  readKiroCapabilityCache(cacheFile).pipe(
    Effect.flatMap((cache) =>
      writeKiroCapabilityCache(cacheFile, {
        ...Option.getOrElse(cache, () => ({
          // A runtime-only cache never matches an install, so the next check still probes.
          version: null,
          probedAt: usageLimits.checkedAt,
          effortLevels: {},
          modes: [],
          currentModeId: null,
        })),
        usageLimits,
      }),
    ),
  );
