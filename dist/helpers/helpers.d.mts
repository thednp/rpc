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
 * Content types the RPC client modules send with each request.
 */
type ContentType = "application/json" | "text/plain" | "application/x-www-form-urlencoded" | "multipart/form-data";
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
 * Client-side stub signature generated for each server function.
 * Returns a promise-backed `data` handle plus a `cancel` function
 * that aborts the underlying fetch request.
 */
type ClientFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (...args: TArgs) => {
  /** Promise resolving to the server response data */
  data: Promise<TResult>;
  /** Aborts the in-flight request with the given reason */
  cancel: (reason: string) => void;
};
/**
 * Options for a manual client stub created via `getClientStub`.
 * Mirrors `ServerFunctionOptions` but client-only.
 */
interface StubOptions {
  /**
   * HTTP method for the stub.
   * @default "POST"
   */
  method: "GET" | "POST";
  /**
   * Fetch credentials policy.
   * @default "same-origin"
   */
  credentials: Credentials;
  /**
   * Content type for the request body. Only `"application/json"` is used for
   * most stubs; other values are for `text/plain`, `application/x-www-form-urlencoded`,
   * and `multipart/form-data` handlers.
   * @default "application/json"
   */
  contentType: ContentType;
}
/**
 * Return shape of `innerModule`: a promise of the response data plus
 * a `cancel` function to abort the underlying fetch request.
 */
type InnerModReturn<T extends JsonValue> = {
  /** Promise resolving to the server response data */
  data: Promise<T | void>;
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
declare const handleResponse: <R extends JsonValue>(response: Response) => Promise<R | void>;
/**
 * Creates a typed client stub for any prefix — the manual counterpart to the
 * auto-generated `public:rpc` stubs. Useful for privileged prefixes like
 * `admin:rpc` that are not emitted in the public bundle.
 * The stub has the same `{data,cancel}` shape and cancellation/error handling
 * as generated stubs, and is code-splittable: `const adminGetUser = getClientStub("admin:rpc","get-user")`
 * should be `await import`-ed only inside `/admin` routes so the `admin:rpc`
 * literal never appears in the public chunk.
 * @param prefix - RPC prefix (e.g. "admin:rpc")
 * @param name - Registered function name
 * @param options - Optional `method`, `credentials`, `contentType`
 * @returns Client stub `(...args) => {data,cancel}`
 * @example
 * import { getClientStub } from "@thednp/rpc/helpers";
 * const adminGetUser = getClientStub("admin:rpc","get-user");
 * const {data,cancel} = adminGetUser("123");
 * @example
 * const adminStats = getClientStub("admin:rpc","stats", { method: "GET" });
 */
declare function getClientStub<T extends JsonArray, R extends JsonValue>(prefix: string, name: string, options?: Partial<StubOptions>): ClientFunction<T, R>;
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
declare const innerModule: <R extends JsonValue>(body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string, method?: "GET" | "POST") => InnerModReturn<R>;
//#endregion
export { getClientStub, handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map