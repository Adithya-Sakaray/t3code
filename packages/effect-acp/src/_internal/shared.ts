import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/unstable/rpc";

import * as AcpSchema from "../_generated/schema.gen.ts";
import * as AcpError from "../errors.ts";
const isError = Schema.is(AcpSchema.Error);
const isAcpError = Schema.is(AcpError.AcpError);

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message.trim();
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return undefined;
}

/**
 * Some agent stacks (notably Kiro) surface protocol failures as defects rather
 * than typed JSON-RPC errors. Prefer a typed request failure so adapters can
 * map and retry instead of dying with an opaque "prompt request failed".
 */
function requestErrorFromDefect(method: string, defect: unknown): AcpError.AcpRequestError {
  return AcpError.AcpRequestError.internalError(
    messageFromUnknown(defect) ?? "Internal error",
    defect,
    {
      method,
      operation: "receive-response",
      cause: defect,
    },
  );
}

export const callRpc = <A>(
  method: string,
  effect: Effect.Effect<A, RpcClientError.RpcClientError | AcpSchema.Error>,
): Effect.Effect<A, AcpError.AcpError> =>
  effect.pipe(
    Effect.catchIf(isError, (error) =>
      Effect.fail(AcpError.AcpRequestError.fromProtocolError(error, { method })),
    ),
    Effect.catchTags({
      RpcClientError: (cause) =>
        Effect.fail(
          cause.reason._tag === "RpcClientDefect" && isAcpError(cause.reason.cause)
            ? cause.reason.cause
            : new AcpError.AcpTransportError({
                operation: "call-rpc",
                method,
                cause,
              }),
        ),
    }),
    Effect.catchCause((cause) => {
      // Keep typed Fail errors as-is; only rewrite pure defects.
      if (Cause.hasFails(cause) || !Cause.hasDies(cause)) {
        return Effect.failCause(cause);
      }
      const defectResult = Cause.findDefect(cause);
      if (Result.isFailure(defectResult)) {
        return Effect.failCause(cause);
      }
      return Effect.fail(requestErrorFromDefect(method, defectResult.success));
    }),
  );

export const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, AcpError.AcpError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* Effect.fail(AcpError.AcpRequestError.methodNotFound(method).toProtocolError());
  }
  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      AcpError.AcpRequestError.fromCoreHandlerError(error, method).toProtocolError(),
    ),
  );
});

export function decodeExtRequestRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<unknown, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError((error) => AcpError.AcpRequestError.invalidExtensionPayload(method, error)),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

export function decodeExtNotificationRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<void, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError((error) =>
        AcpError.AcpProtocolParseError.fromSchemaError(
          "decode-notification-payload",
          method,
          error,
        ),
      ),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

const encoder = new TextEncoder();

const JsonRpcId = Schema.Union([Schema.Number, Schema.String]);
const JsonRpcHeaders = Schema.Array(Schema.Unknown);

export const jsonRpcRequest = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    method: Schema.Literal(method),
    params,
    headers: JsonRpcHeaders.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  });

export const jsonRpcNotification = <A, I>(method: string, params: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal(method),
    params,
  });

export const jsonRpcResponse = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: JsonRpcId,
    result,
  });

export const encodeJsonl = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.map(Schema.encodeEffect(Schema.fromJsonString(schema))(value), (encoded) =>
    encoder.encode(`${encoded}\n`),
  );
