import type { RuntimeMode } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import type { KiroSettings } from "../settings.ts";
import {
  KIRO_COMMANDS_EXECUTE_METHOD,
  KIRO_DEFAULT_MODEL,
  KiroCommandResult,
} from "./kiroProtocol.ts";

/** Kiro enforces these itself: it asks unless launched trusting tools. */
export const KIRO_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** Read-only tools plus `write`: edits run without asking, shell and web still ask. */
const KIRO_EDIT_TRUSTED_TOOLS = [
  "read",
  "glob",
  "grep",
  "code",
  "introspect",
  "todo_list",
  "write",
];

/**
 * Kiro's permission mode is fixed at launch. Explicit approval or sandbox
 * overrides, and modes Kiro cannot enforce, launch it asking.
 */
export function kiroLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  if (runtimePolicy.approvalPolicy !== undefined || runtimePolicy.sandboxPolicy !== undefined) {
    return "approval-required";
  }
  return (KIRO_SUPPORTED_RUNTIME_MODES as ReadonlyArray<RuntimeMode>).includes(
    runtimePolicy.runtimeMode,
  )
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

export function kiroAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "full-access":
      return ["acp", "--trust-all-tools"];
    case "auto-accept-edits":
      return ["acp", "--trust-tools", KIRO_EDIT_TRUSTED_TOOLS.join(",")];
    default:
      return ["acp"];
  }
}

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly kiroSettings: Pick<KiroSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Kiro signs in through its own CLI (`kiro-cli login`) and advertises no ACP
 * auth methods, so the runtime never authenticates.
 */
export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { kiroSettings, environment, runtimeMode, ...options } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        spawn: {
          command: kiroSettings.binaryPath || "kiro-cli",
          args: [...kiroAcpSpawnArgs(runtimeMode)],
          cwd: input.cwd,
          ...(environment === undefined ? {} : { env: environment }),
        },
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/** The product slug `default` (V1 fork threads) is Kiro's own default model. */
export function resolveKiroModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return !trimmed || trimmed === "default" ? KIRO_DEFAULT_MODEL : trimmed;
}

const decodeCommandResult = Schema.decodeUnknownEffect(KiroCommandResult);

/**
 * Runs a Kiro slash command through `_kiro.dev/commands/execute`. Never call
 * this from inside a notification handler without forking: the reply arrives
 * on the same message loop the handler is blocking.
 */
export const executeKiroCommand = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  input: {
    readonly sessionId: string;
    readonly command: string;
    readonly args?: Record<string, unknown>;
  },
): Effect.Effect<KiroCommandResult, EffectAcpErrors.AcpError> =>
  runtime
    .request(KIRO_COMMANDS_EXECUTE_METHOD, {
      sessionId: input.sessionId,
      command: { command: input.command, args: input.args ?? {} },
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () =>
          Effect.fail(
            EffectAcpErrors.AcpRequestError.internalError(
              `Kiro did not answer the ${input.command} command`,
            ),
          ),
      }),
      Effect.flatMap((response) =>
        decodeCommandResult(response).pipe(
          Effect.mapError(() =>
            EffectAcpErrors.AcpRequestError.internalError(
              `Kiro answered the ${input.command} command in an unknown shape`,
            ),
          ),
        ),
      ),
    );
