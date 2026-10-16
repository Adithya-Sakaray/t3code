import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { KiroSettings } from "../settings.ts";
import { makeKiroAcpRuntime, resolveKiroModelId } from "./acpSupport.ts";

const KIRO_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Titles, commit messages, and PR text from a one-shot Kiro session. Kiro
 * launches asking, so a prompt that reaches for a tool is declined rather than
 * run.
 */
export const makeKiroTextGeneration = Effect.fn("makeKiroTextGeneration")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runKiroJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    const fail = (detail: string, cause?: unknown) =>
      new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
    return Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeKiroAcpRuntime({
        kiroSettings: settings,
        environment,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const text = update.content.text;
        return Ref.update(outputRef, (current) => current + text);
      });
      yield* runtime.handleRequestPermission((request) =>
        Effect.succeed({
          outcome: {
            outcome: "selected" as const,
            optionId:
              request.options.find((option) => option.kind === "reject_once")?.optionId ??
              request.options[0]?.optionId ??
              "reject_once",
          },
        }),
      );

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        const model = resolveKiroModelId(modelSelection.model);
        if (started.sessionSetupResult.models?.currentModelId !== model) {
          yield* runtime.setSessionModel(model);
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(KIRO_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(fail("Kiro ACP request timed out.")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause) ? cause : fail("Kiro ACP request failed.", cause),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* fail(
          promptResult.stopReason === "cancelled"
            ? "Kiro ACP request was cancelled."
            : "Kiro returned empty output.",
        );
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Kiro", trimmed);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause) ? cause : fail("Kiro ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner(
    "KiroTextGeneration",
    TextGenerationOperations.withoutInvestigation("Kiro", runKiroJson),
  );
});
