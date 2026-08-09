import "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "hono/utils/http-status";
import "hono/factory";
import "fastify";
import "fastify-plugin";
import "koa";
import "h3";
//#region src/types.d.ts
/**
 * Fetch `credentials` policy used by the generated client modules.
 */
type Credentials = "same-origin" | "include" | "omit";
// primitives and their compositions
/**
 * Primitive JSON values, including `undefined` for optional parameters.
 */
type JsonPrimitive = string | number | boolean | null | undefined;
/**
 * A JSON object whose values are JSON values or arrays.
 */
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
/**
 * A JSON array of JSON values.
 */
type JsonArray = (FormData | JsonValue)[];
/**
 * Any JSON-serializable value: primitive, array, or object.
 */
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
/**
 * Return shape of `innerModule`: a promise of the response data plus
 * a `cancel` function to abort the underlying fetch request.
 */
type InnerModReturn = {
  /** Promise resolving to the server response data */
  data: Promise<JsonValue | void>;
  /** Aborts the in-flight request with the given reason */
  cancel: (reason: string) => void;
};
//#endregion
//#region src/client-helpers.d.ts
/**
 * Processes an HTTP fetch response from the RPC server.
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On other error statuses, throws a Fetch error.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 */
declare const handleResponse: (response: Response) => Promise<JsonValue | void>;
/**
 * Creates an AbortController-bound fetch call for a single RPC function.
 * Used by the auto-generated client modules to issue HTTP requests with cancellation support.
 * GET requests carry arguments as an `?args=` JSON query parameter, since a fetch
 * request body is not allowed on GET.
 * @param body - Serialized request body (JSON string or raw text)
 * @param headers - HTTP headers (Content-Type, etc.)
 * @param credentials - Fetch credentials policy ("same-origin", "include", or "omit")
 * @param prefix - RPC endpoint prefix (e.g. "__rpc")
 * @param name - Registered server function name
 * @param method - HTTP method to use, "POST" by default
 * @returns An object with `data` (promise resolving to the server response) and `cancel` (abort function)
 */
declare const innerModule: (body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string, method?: "GET" | "POST") => InnerModReturn;
//#endregion
export { handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map