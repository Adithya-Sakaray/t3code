import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { KiroSettings } from "../settings.ts";
import {
  executeKiroCommand,
  kiroLaunchRuntimeMode,
  makeKiroAcpRuntime,
  resolveKiroModelId,
} from "./acpSupport.ts";
import {
  KIRO_EFFORT_OPTION_ID,
  KIRO_METADATA_METHOD,
  KIRO_SUBAGENT_LIST_UPDATE_METHOD,
  KiroMetadataNotification,
  KiroSubagentListUpdate,
  KiroUsageData,
  kiroContextUsageFromMetadata,
  kiroMeteredCredits,
  kiroSubagentUpdateFromRoster,
  kiroUsageLimitsFromData,
} from "./kiroProtocol.ts";

export const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
export const KIRO_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(KIRO_PROVIDER);
const DEFAULT_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const decodeModelCommandData = Schema.decodeUnknownOption(
  Schema.Struct({
    models: Schema.Array(Schema.Struct({ id: Schema.String, contextWindow: Schema.Number })),
  }),
);
const decodeUsageData = Schema.decodeUnknownOption(KiroUsageData);

/** Kiro's own usage and quota failures, so the thread shows Limited instead of Failed. */
const KIRO_USAGE_LIMIT_ERROR = /usage limit|out of credits|insufficient credits|quota|throttl/i;
/** A turn usually meters several times; one usage read per window is plenty. */
const USAGE_REFRESH_INTERVAL_MS = 30_000;

export const KiroProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // Permissions are launch flags, so a mode change reopens the session.
    supportsRuntimeModeSwitchInSession: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface KiroAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Publishes the account's credit window after metered turns. */
  readonly onUsageLimits?: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

/**
 * State the flavor learns from live sessions, shared by every thread of the
 * instance. Session ids are UUIDs, so maps keyed by them never collide.
 */
interface KiroLiveState {
  /** Context window by model id, from Kiro's `model` command. */
  readonly contextWindows: Map<string, number>;
  /** The model each root session runs; crew children run on their root's model. */
  readonly modelBySession: Map<string, string>;
  /** Last roster status projected per child session, to skip repeats. */
  readonly rosterStatus: Map<string, string>;
  lastUsageRefreshMs: number;
}

const loadContextWindows = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  sessionId: string,
  state: KiroLiveState,
) =>
  state.contextWindows.size > 0
    ? Effect.void
    : executeKiroCommand(runtime, { sessionId, command: "model" }).pipe(
        Effect.map((result) => {
          const data = decodeModelCommandData(result.data);
          if (data._tag === "None") return;
          for (const model of data.value.models) {
            if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
              state.contextWindows.set(model.id, model.contextWindow);
            }
          }
        }),
        Effect.catchCause(() => Effect.void),
      );

/**
 * Applies the requested model, then its effort. Effort only exists for some
 * models, so a stored effort Kiro rejects for the running model is skipped,
 * not a failed turn.
 */
const applyKiroModelSelection =
  (state: KiroLiveState): NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> =>
  ({ runtime, startResult, modelSelection }) =>
    Effect.gen(function* () {
      const sessionId = startResult.sessionId;
      const current = startResult.sessionSetupResult.models?.currentModelId?.trim() || undefined;
      const requested = resolveKiroModelId(modelSelection.model);
      if (requested !== current) {
        yield* runtime.setSessionModel(requested);
      }
      state.modelBySession.set(sessionId, requested);
      yield* loadContextWindows(runtime, sessionId, state);
      const effort = getModelSelectionStringOptionValue(modelSelection, KIRO_EFFORT_OPTION_ID);
      if (effort !== undefined) {
        const result = yield* executeKiroCommand(runtime, {
          sessionId,
          command: "effort",
          args: { value: effort },
        }).pipe(Effect.option);
        if (result._tag === "None" || !result.value.success) {
          yield* Effect.logWarning("Kiro skipped an effort the running model does not offer", {
            model: requested,
            effort,
            detail: result._tag === "Some" ? result.value.message : undefined,
          });
        } else {
          yield* Effect.logDebug("Kiro effort applied", { model: requested, effort });
        }
      }
      return requested;
    });

const registerKiroExtensions =
  (state: KiroLiveState, options: KiroAdapterV2Options) =>
  ({
    runtime,
    rootSessionId,
    updateContextUsage,
    reportSubagent,
  }: AcpAdapterV2ExtensionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const refreshUsageLimits = (sessionId: string) =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (
            options.onUsageLimits === undefined ||
            now - state.lastUsageRefreshMs < USAGE_REFRESH_INTERVAL_MS
          ) {
            return;
          }
          state.lastUsageRefreshMs = now;
          const result = yield* executeKiroCommand(runtime, { sessionId, command: "usage" });
          const data = decodeUsageData(result.data);
          if (!result.success || data._tag === "None") return;
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const limits = kiroUsageLimitsFromData({ data: data.value, checkedAt });
          if (limits !== undefined) {
            yield* options.onUsageLimits({ windows: limits.windows, checkedAt });
          }
        }).pipe(Effect.catchCause(() => Effect.void));

      yield* runtime.handleExtNotification(
        KIRO_METADATA_METHOD,
        KiroMetadataNotification,
        (notification) =>
          Effect.gen(function* () {
            const root = yield* rootSessionId;
            const model =
              state.modelBySession.get(notification.sessionId) ??
              (root === null ? undefined : state.modelBySession.get(root));
            yield* updateContextUsage({
              sessionId: notification.sessionId,
              update: (previous) =>
                kiroContextUsageFromMetadata({
                  notification,
                  previous,
                  contextWindowTokens:
                    model === undefined ? null : (state.contextWindows.get(model) ?? null),
                }),
            });
            const credits = kiroMeteredCredits(notification);
            if (credits <= 0 || root === null) return;
            // A crew child's credits count toward the thread that spawned it.
            if (notification.sessionId !== root) {
              yield* updateContextUsage({
                sessionId: root,
                update: (previous) =>
                  kiroContextUsageFromMetadata({
                    notification: { sessionId: root },
                    previous,
                    contextWindowTokens: null,
                    extraCredits: credits,
                  }),
              });
            }
            // The reply comes back on this message loop, so never wait on it here.
            yield* Effect.forkDetach(refreshUsageLimits(root));
          }),
      );

      yield* runtime.handleExtNotification(
        KIRO_SUBAGENT_LIST_UPDATE_METHOD,
        KiroSubagentListUpdate,
        (roster) =>
          Effect.forEach(
            roster.subagents ?? [],
            (entry) => {
              const update = kiroSubagentUpdateFromRoster(entry);
              if (state.rosterStatus.get(entry.sessionId) === update.status) return Effect.void;
              state.rosterStatus.set(entry.sessionId, update.status);
              return reportSubagent(update);
            },
            { discard: true },
          ),
      );
    });

export function makeKiroAcpAdapterFlavor(
  options: KiroAdapterV2Options,
  state: KiroLiveState = {
    contextWindows: new Map(),
    modelBySession: new Map(),
    rosterStatus: new Map(),
    lastUsageRefreshMs: 0,
  },
): AcpAdapterV2Flavor {
  return {
    driver: KIRO_PROVIDER,
    runtimeHarness: "Kiro",
    capabilities: KiroProviderCapabilitiesV2,
    resolveModelId: (selection) => resolveKiroModelId(selection.model),
    applyModelSelection: applyKiroModelSelection(state),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeKiroAcpRuntime({
          ...input,
          kiroSettings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
          runtimeMode: kiroLaunchRuntimeMode(runtimePolicy),
        })),
    registerExtensions: registerKiroExtensions(state, options),
    // Crew children are reported by the roster; defining this routes their
    // sessions' updates into the subagent threads. Kiro's spawn tool itself
    // stays an ordinary tool row.
    extractSubagentUpdate: () => undefined,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              message: cause.errorMessage,
              code: String(cause.code),
              class: KIRO_USAGE_LIMIT_ERROR.test(cause.errorMessage)
                ? "usage_limit"
                : "provider_error",
            }
          : { class: "provider_error" }),
      }),
  };
}

export const makeKiroAdapterV2 = Effect.fn("makeKiroAdapterV2")(function* (
  options: KiroAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeKiroAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const createKiroAdapterV2 = (
  input: ProviderAdapterDriverCreateInput<KiroSettings>,
  extra: Pick<KiroAdapterV2Options, "onUsageLimits"> = {},
) =>
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcess.Environment;
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeKiroAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      selfInvocation,
      continuationRequests,
      ...extra,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: KIRO_PROVIDER,
          threadId,
        }),
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterDriverCreateError({
          driver: KIRO_PROVIDER,
          instanceId: input.instanceId,
          detail: "Failed to create Kiro ACP adapter.",
          cause,
        }),
    ),
    Effect.withSpan("createKiroAdapterV2"),
  );

export const KiroAdapterV2Driver: ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> = {
  driverKind: KIRO_PROVIDER,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: (input) => createKiroAdapterV2(input),
};
