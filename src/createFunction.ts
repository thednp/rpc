// /@thednp/rpc/src/createFn.ts
import type {
  ClientFunction,
  JsonArray,
  JsonValue,
  ServerFunctionInit,
  ServerFunctionOptions,
} from "./types.d.ts";
import { serverFunctionsMap } from "./functionsMap.ts";
import { defaultServerFnOptions } from "./options.ts";
import { OPERATION_ABORTED } from "./constants.ts";

/**
 * Creates a server-side RPC function.
 * Registers the function in the server functions map and returns a client-compatible
 * wrapper that exposes `data` (Promise) and `cancel` (function) for request lifecycle control.
 * @param name - Unique identifier used by the RPC router to dispatch requests
 * @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
 * @param fnOptions - Optional contentType and credentials settings
 * @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
 */
export function createServerFunction<
  TArgs extends JsonArray = JsonArray,
  TResult extends JsonValue = JsonValue,
>(
  name: string,
  handler: ServerFunctionInit<TArgs, TResult>,
  fnOptions: Partial<ServerFunctionOptions> = {},
): ClientFunction<TArgs, TResult> {
  const options = Object.assign({}, defaultServerFnOptions, fnOptions);

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
    name: { value: name, enumerable: true, configurable: true },
    options: { value: options, enumerable: true, configurable: true },
  });

  serverFunctionsMap.set(
    name,
    {
      name,
      handler: wrappedFunction as never,
      options,
    },
  );

  return wrappedFunction;
}
