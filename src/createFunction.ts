/** @module Server function creation and registration. */
import type {
  ClientFunction,
  JsonArray,
  JsonValue,
  ServerFunctionInit,
  ServerFunctionOptions,
} from "./types.d.ts";
import { getFunctionsForPrefix } from "./functionsMap.ts";
import {
  defaultPrefix,
  defaultServerFnOptions,
  getGlobalPrefix,
} from "./options.ts";
import { OPERATION_ABORTED } from "./constants.ts";

/**
 * Extended options for createServerFunction, including rpcPrefix for multi-instance support.
 */
export interface CreateServerFunctionOptions
  extends Partial<ServerFunctionOptions> {
  /**
   * RPC prefix for this function. Enables multiple RPC instances with different prefixes.
   * When using multi-prefix setup, functions with the same name but different prefixes
   * can coexist without collision.
   * @default "__rpc"
   * @example
   * // v1 API
   * export const login = createServerFunction(
   *   "login",
   *   async (signal, email, password) => ({...}),
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
export function createServerFunction<
  TArgs extends JsonArray = JsonArray,
  TResult extends JsonValue = JsonValue,
>(
  name: string,
  handler: ServerFunctionInit<TArgs, TResult>,
  fnOptions: CreateServerFunctionOptions = {},
): ClientFunction<TArgs, TResult> {
  const options = Object.assign({}, defaultServerFnOptions, fnOptions);
  const rpcPrefix = fnOptions.rpcPrefix || getGlobalPrefix() || defaultPrefix;

  const wrappedFunction: ClientFunction<TArgs, TResult> = (...args: TArgs) => {
    const controller = new AbortController();
    const cancel = (reason: string) => controller.abort(reason);

    const fetcher = async () => {
      if (controller.signal.aborted) {
        throw new Error(OPERATION_ABORTED);
      }

      return await handler(controller.signal, ...args);
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
