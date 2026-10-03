/** @module Server function creation and registration. */
import type {
  ClientFunction,
  ClientFunctionWithOptions,
  InferInput,
  InferOutput,
  JsonValue,
  NoArgClientFunction,
  ServerFunctionInit,
  ServerFunctionOptions,
  StandardSchemaV1,
} from "./types.d.ts";
import { getFunctionsForPrefix } from "./functionsMap.ts";
import { defaultServerFnOptions } from "./options.ts";
import { resolveRPCPrefix } from "./server-helpers.ts";
import { runValidation } from "./schema.ts";
import { OPERATION_ABORTED, VALIDATION_HINT } from "./constants.ts";

/**
 * Extended options for createServerFunction, including rpcPrefix for multi-instance support.
 */
export interface CreateServerFunctionOptions
  extends Partial<ServerFunctionOptions> {
  /**
   * RPC prefix for this function. Enables multiple RPC instances with different prefixes.
   * When using multi-prefix setup, functions with the same name but different prefixes
   * can coexist without collision.
   * @default undefined — resolved with `resolveRPCPrefix()` to explicit, global, then `"__rpc"`
   * @example
   * // v1 API
   * export const login = createServerFunction(
   *   "login",
   *   async (signal, credentials: { email: string; password: string }) => ({...}),
   *   { rpcPrefix: "v1:rpc" },
   * );
   *
   * // v2 API - same function name, different prefix
   * export const login = createServerFunction(
   *   "login",
   *   async (signal, credentials) => ({...}),
   *   { rpcPrefix: "v2:rpc" },
   * );
   */
  rpcPrefix?: string;
}

/**
 * Creates a server-side RPC function.
 * Registers the function in the server functions map (scoped by rpcPrefix) and returns
 * a client-compatible wrapper that exposes `data` (Promise) and `cancel` (function)
 * for request lifecycle control.
 * @param name - Unique identifier used by the RPC router to dispatch requests
 * @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
 * @param fnOptions - Optional contentType, credentials, and rpcPrefix settings
 * @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
 */
/**
 * Creates a server function whose **input** is described by a Standard Schema.
 *
 * The schema drives the handler's first-parameter type, so the validated value
 * flows in without a cast, and a handler annotated with a type the schema does
 * not produce is a **type error** rather than a runtime surprise.
 *
 * `ServerFunctionInit` is a function type, so under `strictFunctionTypes` the
 * parameter is contravariant: for a handler to satisfy this signature its
 * annotated parameter must be a supertype of `InferOutput<TSchema>`. An
 * incompatible annotation therefore fails to compile.
 */
export function createServerFunction<
  TSchema extends StandardSchemaV1<unknown, unknown>,
  TResult extends JsonValue | void = JsonValue,
>(
  name: string,
  handler: (
    signal: AbortSignal,
    input: InferOutput<TSchema>,
  ) => Promise<TResult>,
  fnOptions: CreateServerFunctionOptions & { schema: TSchema },
): ClientFunction<
  // The client sends the schema's **Input**, while the handler receives its
  // **Output** — the two differ exactly when the schema transforms, which is the
  // whole point of the spec's Input/Output split. A coercing pipe
  // (`v.pipe(v.string(), v.transform(Number), v.number())`) therefore accepts
  // strings from the browser and hands the handler numbers. The `& JsonValue` is
  // the wire boundary, not a widening: only JSON-serialisable values can cross.
  InferInput<TSchema> & JsonValue,
  TResult
>;

/**
 * Creates a server function with no input schema.
 *
 * The options type forbids `schema` (`schema?: undefined`), which is what stops
 * a schema-bearing call from silently falling through to this overload after
 * failing the one above — the mismatch would otherwise be accepted with an
 * untyped input.
 */
export function createServerFunction<
  TInput extends FormData | JsonValue = JsonValue,
  TResult extends JsonValue | void = JsonValue,
>(
  name: string,
  handler: ServerFunctionInit<TInput, TResult>,
  fnOptions?: CreateServerFunctionOptions & { schema?: undefined },
): ClientFunction<TInput, TResult> & NoArgClientFunction<TResult>;

export function createServerFunction<
  TInput extends FormData | JsonValue = JsonValue,
  TResult extends JsonValue | void = JsonValue,
>(
  name: string,
  handler: ServerFunctionInit<TInput, TResult>,
  fnOptions: CreateServerFunctionOptions = {},
): ClientFunctionWithOptions<TInput, TResult> {
  const options = Object.assign({}, defaultServerFnOptions, fnOptions);
  // const rpcPrefix = fnOptions.rpcPrefix || getGlobalPrefix() || defaultPrefix;
  const rpcPrefix = resolveRPCPrefix(fnOptions.rpcPrefix);

  const wrappedFunction: ClientFunctionWithOptions<TInput, TResult> = (
    input: TInput,
  ) => {
    const controller = new AbortController();
    const cancel = (reason: string) => controller.abort(reason);

    const fetcher = async () => {
      if (controller.signal.aborted) {
        throw new Error(OPERATION_ABORTED);
      }

      // The `schema` is enforced here as well as in each adapter's dispatch,
      // because this function is also callable **directly** — which is exactly
      // what SSR, a server-to-server call and a test all do. Without this the
      // same call is validated over HTTP and silently unchecked in-process, and
      // the schema's transforms never run on this path at all:
      //
      //     add({ a: 1, b: "x" })     over HTTP -> 422; directly -> "1x"
      //   add({ a: "2", b: "40" })  over HTTP -> 42;  directly -> "240"
      //
      // The second is the sharper one: `a` and `b` arrive as strings, because
      // only the schema's output ever replaced the raw argument.
      const schema = options.schema;
      if (schema) {
        const checked = await runValidation(schema, input, {
          hints: options.hints,
          // A per-function hint leads, then rpc's own pointer to the docs —
          // the same composition the adapters use, so both paths report alike.
          hint: options.hint
            ? `${options.hint} — ${VALIDATION_HINT}`
            : VALIDATION_HINT,
        });
        if (!checked.ok) throw checked.error;
        // The widened tuple is the same shape the adapter's dispatch calls the
        // handler with, so the two paths cannot diverge in what reaches it.
        return await handler(
          controller.signal,
          checked.value as TInput,
        );
      }

      return await handler(controller.signal, input);
    };

    return {
      data: fetcher(),
      cancel,
    };
  };

  Object.defineProperties(wrappedFunction, {
    name: { value: name, enumerable: true, configurable: false },
    options: { value: options, enumerable: true, configurable: false },
  });

  // Register to prefix-scoped map
  const prefixMap = getFunctionsForPrefix(rpcPrefix);
  prefixMap.set(name, {
    name,
    handler: wrappedFunction as never,
    options,
  });

  return wrappedFunction;
}
