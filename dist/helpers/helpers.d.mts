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
/** A single rendered issue, as it appears in a validation error body. */
interface ValidationIssue {
  /** Dotted/indexed path, e.g. `"email"` or `"items[0].name"`. */
  readonly path: string;
  /**
   * The validator's own message for this path.
   *
   * **Development only.** Some libraries interpolate the value that failed into
   * their default message — measured, going through `~standard.validate`:
   * valibot returns `"Invalid type: Expected string but received 12345"` for a
   * failed `name: 12345`, where zod returns `"Invalid input: expected string,
   * received number"` and arktype `"name must be a string (was a number)"`. So
   * whether a message is safe to send depends on which library the author chose.
   * The production body therefore omits it, which is why this is optional rather
   * than required — an issue that carries only a `path` and a `hint` is a
   * legitimate production shape, not a malformed one.
   */
  readonly message?: string;
  /** A teaching hint for this path, when one is available. Sent in both. */
  readonly hint?: string;
}
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
type ClientFunction<TArgs extends JsonArray = JsonArray, TResult = JsonValue> = (...args: TArgs) => {
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
 * A non-2xx RPC response, with the server's body attached.
 *
 * Carrying the body matters because the server sends its most useful errors
 * *in* it. A `400` from a schema violation carries the rendered issue paths and
 * the per-field `hint`; discarding that and throwing only `statusText` would
 * leave the browser unable to tell the caller *which field* was wrong, which is
 * the whole point of the teaching-error work. The previous behaviour — throw
 * `FETCH_ERROR_PREFIX + statusText` without reading the body — is preserved in
 * `message` for anyone matching on it.
 */
export declare class RPCResponseError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The parsed response body, when it was JSON. */
  readonly body?: unknown;
  constructor(status: number, statusText: string, body?: unknown);
  /**
   * The validation issues from a `422` body, when the server sent them.
   *
   * Returns `undefined` for any other status or an unrecognised body, so a
   * caller can branch without inspecting the shape itself.
   */
  get issues(): ValidationIssue[] | undefined;
  /** The general `hint` from a `422` body, when the server sent one. */
  get hint(): string | undefined;
}
/**
 * Processes an HTTP fetch response from the RPC server.
 *
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On any other error status, throws an {@link RPCResponseError} carrying the
 * status and the parsed body when there is one.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 */
export declare const handleResponse: <R extends JsonValue>(response: Response) => Promise<R | void>;
/**
 * Field errors from a rejected call, keyed by the path that failed.
 *
 * The server normalises **every** validator's issues into the same
 * `{ path, message, hint? }` shape, so this is validator-agnostic: a zod
 * rejection and an arktype rejection arrive identically, and neither needs the
 * app to know which library produced it. That is what removes the usual
 * per-app helper — a hand-rolled `isValiError` guard plus a
 * `getError(error, field)` formatter, both tied to one library's flattened
 * output and silently wrong for the other three.
 *
 * Paths are the rendered strings rpc already produces, so a nested failure keys
 * on `"profile.email"`. An empty path — a top-level scalar — keys on `""`.
 *
 * ```ts
 * import { fieldErrors } from "@thednp/rpc/helpers";
 *
 * for (const [path, messages] of Object.entries(fieldErrors(err))) {
 *   showError(path, messages.join(" "));
 * }
 * ```
 *
 * Works in production as well as development. A production rejection carries
 * each issue's `path` and `hint` but not the validator library's `message`, so
 * the message falls back to the hint; an issue carrying neither is skipped
 * rather than rendered as an empty string, which would put a stray `""` into
 * every "show errors" loop.
 *
 * Returns an empty object for anything that is not a validation failure.
 */
export declare const fieldErrors: (err: unknown) => Record<string, string[]>;
/**
 * One field's messages, ready to render — the exact replacement for a
 * hand-written `getError(error, field)`.
 *
 * Returns `""` when the field did not fail, so it drops straight into an
 * element's `textContent` with no guard:
 *
 * ```ts
 * emailError.textContent = fieldErrorText(err, "email");
 * ```
 */
export declare const fieldErrorText: (err: unknown, field: string) => string;
/**
 * The `hint` for a field's failure, or `""`.
 *
 * Prefers the field's own hint — from `hints: { email: "…" }` or from a builder
 * schema's `field.string({ hint })` — and falls back to the function-wide
 * `hint`, which is the more common form and would otherwise be unreachable from
 * a per-field lookup. Several issues can share a path; the first hint wins,
 * because a field with two hints is better served by one than by none.
 *
 * Sent in production as well as development. A hint is authored in
 * `ServerFunctionOptions`, so disclosing it was deliberate — which is exactly
 * why it is the one part of an issue that survives into a production body.
 * That makes it the right thing to put in a `title` or tooltip beside the
 * field, whether or not there is a visible message to pair it with.
 */
export declare const fieldErrorHint: (err: unknown, field: string) => string;
/**
 * Unwraps the `{ data }` envelope from a parsed RPC response body.
 *
 * Error handling matches `handleResponse` so both helpers in this module agree
 * on the contract: a **top-level** `error` key (including `400`/`403`/`404`/`405`/`409`/`413`/`415`/`422`/`500`) throws, while a `{ data: { error } }` body resolves
 * normally — that shape is the documented "validation-as-data" contract where a
 * 200 carries the validation outcome as its result.
 *
 * Discriminating on `error` present **and** `data` absent is what keeps those
 * two cases apart. Checking `res.ok` first is still recommended, since this
 * helper is status-code agnostic by design, so still check `res.ok` before
 * passing it a body.
 * @param json - Parsed JSON response body
 * @returns The unwrapped response data
 * @throws When the body carries a top-level `error` and no `data`
 * @example
 * ```ts
 * const response = await fetch("/__rpc/greet", { method: "POST", ... });
 * const body = await response.json();
 * const greeting = unwrapEnvelope<string>(body); // "Hello, world!"
 * ```
 */
export declare const unwrapEnvelope: <T>(json: unknown) => T;
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
export declare function getClientStub<T extends JsonArray, R extends JsonValue>(prefix: string, name: string, options?: Partial<StubOptions>): ClientFunction<T, R>;
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
export declare const innerModule: <R extends JsonValue>(body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string, method?: "GET" | "POST") => InnerModReturn<R>;
//#endregion
//# sourceMappingURL=helpers.d.mts.map