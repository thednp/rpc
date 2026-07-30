import "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "fastify";
import "koa";
//#region src/types.d.ts
type Credentials = "same-origin" | "include" | "omit";
// primitives and their compositions
type JsonPrimitive = string | number | boolean | null | undefined;
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
//#endregion
//#region src/helpers.d.ts
/**
 * Processes an HTTP fetch response from the RPC server.
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On other error statuses, throws a Fetch error.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 */
declare const handleResponse: (response: Response) => Promise<JsonValue | void>;
type InnerModReturn = {
  data: Promise<JsonValue | void>;
  cancel: (reason: string) => void;
};
/**
 * Creates an AbortController-bound fetch call for a single RPC function.
 * Used by the auto-generated client modules to issue POST requests with cancellation support.
 * @param body - Serialized request body
 * @param headers - HTTP headers (Content-Type, etc.)
 * @param credentials - Fetch credentials policy ("same-origin", "include", or "omit")
 * @param prefix - RPC endpoint prefix (e.g. "__rpc")
 * @param name - Registered server function name
 * @returns An object with `data` (promise resolving to the server response) and `cancel` (abort function)
 */
declare const innerModule: (body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string) => InnerModReturn;
//#endregion
export { handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map