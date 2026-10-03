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
/**
 * The Standard Schema V1 runtime surface.
 *
 * Per [standardschema.dev](https://standardschema.dev), a validator exposes one
 * property, one function, and one result. Consuming it structurally is what lets
 * a zod schema, a valibot schema, an arktype schema, an effect Schema, and a
 * hand-rolled check all satisfy the same `schema` option with no adapter.
 */
/** The result of a validation: either a value, or issues. */
type StandardSchemaResult<Output> = {
  readonly value: Output;
  readonly issues?: undefined;
} | {
  readonly issues: readonly StandardSchemaIssue[];
};
/**
 * One issue as a validator reports it.
 *
 * `path` is optional and a segment is either a plain key or a `{ key }` wrapper
 * (`PathSegment` in the spec); both occur in the wild, so both are accepted.
 */
interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | {
    readonly key: PropertyKey;
  }>;
}
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    /**
     * The inferred types, when the vendor provides them. Optional at runtime and
     * type-only, so rpc does not require it; the generics below are what it
     * infers from.
     */
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    } | undefined;
    /**
     * Validates unknown input.
     *
     * The spec allows a `Promise`, and **rpc awaits it**. That is not optional
     * politeness: an async validator (a `z.refine` hitting a database, an effect
     * `Schema` with an async refinement) returns a Promise, and a consumer that
     * treats the result synchronously sees `issues === undefined` on the
     * Promise object, concludes the input was valid, and hands the handler
     * `undefined` — silently skipping validation entirely.
     */
    readonly validate: (value: unknown, options?: StandardSchemaValidateOptions) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  };
}
/** Options passed through to a validator's `validate`. */
interface StandardSchemaValidateOptions {
  /** Vendor-specific parameters, forwarded verbatim. */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}
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
/**
 * Options for a single server function, controlling how the generated
 * client module serializes the request body and sends credentials.
 */
interface ServerFunctionOptions {
  /**
   * Content type used for the request body.
   * @default "application/json"
   */
  contentType: ContentType;
  /**
   * Fetch credentials policy.
   * @default "same-origin"
   */
  credentials?: Credentials;
  /**
   * HTTP method used for the RPC request.
   * GET requests send arguments as an `?args=` JSON query parameter
   * (a fetch request body is not allowed on GET).
   * @default "POST"
   */
  method?: "GET" | "POST";
  /**
   * RPC endpoint prefix. The actual fallback chain is explicit argument →
   * `getGlobalPrefix()` → `"__rpc"`, implemented once by `resolveRPCPrefix`.
   * @default undefined — resolved with `resolveRPCPrefix()` to `"__rpc"` when no other prefix is set
   */
  rpcPrefix?: string;
  /**
   * A [Standard Schema](https://standardschema.dev) describing this function's
   * input — the first argument after the `AbortSignal`.
   *
   * Any conforming validator works unchanged: a zod schema, a valibot schema,
   * an arktype schema, an effect Schema, or a schema built with rpc's own
   * `schema()` / `field` helpers. The whole runtime surface is one
   * `~standard.validate` call, so there is no adapter and no second validation
   * dialect.
   *
   * Validation runs after the body is read and **before** the handler is
   * entered. A rejected input answers `422`. In development the response carries
   * the rendered issue paths, any hints, and a `code`/`data` payload; production
   * keeps each issue's `path` and any author-written `hint`, and drops only the
   * validator library's own `message`.
   *
   * A validated payload must be a single object: an array root is rejected
   * because positional issues cannot be mapped to named inputs downstream.
   *
   * The handler receives the **validated output**, so the type flows from the
   * schema into the handler without a cast.
   * @example
   * import { z } from "zod";
   *
   * export const register = createServerFunction(
   *   "register",
   *   async (signal, input: { email: string }) => save(input.email),
   *   { schema: z.object({ email: z.string() }) },
   * );
   */
  schema?: StandardSchemaV1<unknown, unknown>;
  /**
   * Per-path teaching hints for validation failures, keyed by the rendered path
   * (`"email"`, `"items[0].name"`). Dev-only.
   *
   * A hint has to be supplied by the author, because a validator's own message
   * is accurate but not actionable — `expected a string` says what broke, not
   * what to do about it. Paths match exactly first, then by leaf name, so one
   * `email` hint covers both a top-level `email` and a nested `profile.email`.
   *
   * Hints declared on an rpc builder schema take effect automatically; this
   * option is for validators from other libraries, which cannot carry them.
   * @example
   * { schema: z.object({ email: z.string() }),
   *   hints: { email: "use .optional() if the address is optional" } }
   */
  hints?: Record<string, string>;
  /**
   * A single function-wide hint for validation failures, dev-only.
   *
   * Preferred over {@link ServerFunctionOptions.hints} when the same advice
   * applies to every field — it avoids repeating one string per key, which is
   * how a hint map drifts out of step with the schema. Appended to rpc's own
   * pointer at the wiki, so the documentation link is never lost.
   *
   * @example
   * { schema: AddSchema, hint: "a and b are numbers; the form sends strings" }
   */
  hint?: string;
  /**
   * Enables the no-JS `<form>` flow for this function: a native form
   * submission is answered with a Post/Redirect/Get `303` carrying the failure
   * as a flash, instead of a JSON body a browser would render as raw text.
   *
   * Absent by default, and required for the flow — nothing changes for a
   * function that does not set it, and a `fetch` from the generated stub is
   * unaffected, because a browser navigation is a document request and a
   * `fetch` is not.
   *
   * Only meaningful for a form-declared function. A JSON-declared function
   * still answers `415` for a form body, because content-type strictness is
   * one-directional and deliberate.
   *
   * @example
   * // simplest: one path for both outcomes
   * fallback: "/?#contact"
   *
   * @example
   * // replay named fields so a rejected submission does not clear them
   * fallback: { to: "/?#contact", replay: ["email", "message"] }
   */
  fallback?: string | FormFallbackOptions;
}
/**
 * The outcome of a native form submission, as seen by {@link FormFallbackOptions.to}.
 *
 * Derived from what already happened rather than being a new return type: a
 * handler that returned produced `ok`, and one that threw an `RPCError` (or a
 * typed subclass) produced `error` with that error's author-written advice and
 * any per-field issues. An unexpected throw is **not** an outcome — it stays a
 * `500`, because a genuine fault must not be laundered into a friendly
 * redirect.
 */
interface FormFallbackOutcome {
  /** `error` when the handler threw a client-facing error. */
  readonly status: "ok" | "error";
  /** Field-level messages, keyed by rendered path (`email`, `address.city`). */
  readonly errors?: Record<string, string[]>;
  /** A general, author-written message — the error's `hint`. */
  readonly message?: string;
}
/** Where a native form submission redirects to, and what it may replay. */
interface FormFallbackOptions {
  /**
   * The redirect target, or a function choosing one per outcome.
   *
   * Treated as **untrusted**: it goes through `sanitizeRedirect`, so a value
   * that came from a field or a `Referer` cannot turn this into an open
   * redirect. Give it a root-relative path.
   */
  readonly to: string | ((outcome: FormFallbackOutcome) => string);
  /**
   * Field names permitted in the redirect URL. **Empty by default**, so nothing
   * is replayed unless named.
   *
   * A URL is a poor home for user data — it reaches browser history, the
   * `Referer` of the next navigation, and every access log in between — and
   * rpc cannot know which of your fields are secrets. Naming them is a
   * sentence you have to write, which is the point.
   */
  readonly replay?: readonly string[];
}
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
type ClientFunction<TInput extends FormData | JsonValue = JsonValue, TResult = JsonValue> = (input: TInput) => {
  /** Promise resolving to the server response data */
  data: Promise<TResult>;
  /** Aborts the in-flight request with the given reason */
  cancel: (reason: string) => void;
};
/**
 * Client-side stub for a function taking no input. Callable with zero
 * arguments — the pre-0.4.2 `(...args: [])` inference, spelled out, so
 * zero-argument functions stay callable as `fn()`.
 */
type NoArgClientFunction<TResult = JsonValue> = {
  (): {
    /** Promise resolving to the server response data */
    data: Promise<TResult>;
    /** Aborts the in-flight request with the given reason */
    cancel: (reason: string) => void;
  };
  /** Registered export name of the server function */
  name: string;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
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
 *
 * `T` is unconstrained like the rest of the client result chain — see
 * `handleResponse`. The server side still constrains what it produces.
 */
type InnerModReturn<T> = {
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
 *
 * `R` is deliberately unconstrained: the client only *asserts* the response
 * shape (interfaces included — they have no implicit index signature and can
 * never satisfy `JsonValue`), while the serializability requirement is
 * enforced where values are produced, on the factory's `TResult`. The cast
 * below is the single point where the assertion meets the wire.
 */
export declare const handleResponse: <R>(response: Response) => Promise<R | void>;
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
 * @returns Client stub `(input) => {data,cancel}`
 * @example
 * import { getClientStub } from "@thednp/rpc/helpers";
 * const adminGetUser = getClientStub("admin:rpc","get-user");
 * const {data,cancel} = adminGetUser("123");
 * @example
 * const adminStats = getClientStub("admin:rpc","stats", { method: "GET" });
 */
export declare function getClientStub<TInput extends FormData | JsonValue = JsonValue, R = JsonValue>(prefix: string, name: string, options?: Partial<StubOptions>): ClientFunction<TInput, R> & NoArgClientFunction<R>;
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
export declare const innerModule: <R>(body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string, method?: "GET" | "POST") => InnerModReturn<R>;
//#endregion
//# sourceMappingURL=helpers.d.mts.map