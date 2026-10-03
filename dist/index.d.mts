import { Connect, Plugin, ResolvedConfig } from "vite";
import { AdapterName as AdapterName$1, MiddlewareOptions as MiddlewareOptions$1 } from "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { NextFunction, Request, Response as Response$1 } from "express";
import { MiddlewareHandler } from "hono";
import "@hono/node-server";
import "hono/utils/http-status";
import "hono/factory";
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import "fastify-plugin";
import { Context, Next } from "koa";
import { Middleware } from "h3";
//#region src/express/types.d.ts
/**
 * Express-specific middleware options, constrained to the `"express"` adapter.
 */
type ExpressMiddlewareOptions = MiddlewareOptions$1<"express">;
/**
 * Express middleware factory: takes optional initial options and returns
 * the Express/Connect-compatible handler.
 */
type ExpressMiddlewareFn = <A extends AdapterName$1 = "express">(initialOptions?: Partial<ExpressMiddlewareOptions>) => ExpressMiddlewareHooks["handler"];
/**
 * Express/Connect middleware handler signature used by the RPC middleware.
 */
interface ExpressMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Node or Express request object
   * @param res - Node or Express response object
   * @param next - Connect or Express next function
   */
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response$1, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
//#endregion
//#region src/hono/types.d.ts
/**
 * Hono middleware handler signature used by the RPC middleware.
 */
interface HonoMiddlewareHooks {
  /** Hono middleware handler */
  handler: MiddlewareHandler;
}
/**
 * Hono middleware factory: takes optional initial options and returns
 * the Hono-compatible handler.
 */
type HonoMiddlewareFn = <A extends AdapterName$1 = "hono">(initialOptions?: Partial<MiddlewareOptions$1<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/fastify/types.d.ts
/**
 * Fastify-specific middleware options, constrained to the `"fastify"` adapter.
 */
type FastifyMiddlewareOptions = MiddlewareOptions$1<"fastify">;
/**
 * Fastify middleware factory: takes optional initial options and returns
 * the Fastify-compatible handler.
 */
type FastifyMiddlewareFn = <A extends AdapterName$1 = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
/**
 * Fastify middleware handler signature used by the RPC middleware.
 */
interface FastifyMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Fastify request object
   * @param res - Fastify reply object
   * @param done - Fastify hook completion callback
   */
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
//#endregion
//#region src/koa/types.d.ts
/**
 * Koa-specific middleware options, constrained to the `"koa"` adapter.
 */
type KoaMiddlewareOptions = MiddlewareOptions$1<"koa">;
/**
 * Koa middleware handler signature used by the RPC middleware.
 */
interface KoaMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param ctx - Koa context object
   * @param next - Koa next function
   */
  handler: (ctx: Context, next: Next) => Promise<void>;
}
/**
 * Koa middleware factory: takes optional initial options and returns
 * the Koa-compatible handler.
 */
type KoaMiddlewareFn = <A extends AdapterName$1 = "koa">(initialOptions?: Partial<KoaMiddlewareOptions>) => KoaMiddlewareHooks["handler"];
//#endregion
//#region src/h3/types.d.ts
/**
 * h3-specific middleware options, constrained to the `"h3"` adapter.
 */
type H3MiddlewareOptions = MiddlewareOptions$1<"h3">;
/**
 * h3 middleware handler signature used by the RPC middleware.
 */
interface H3MiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param event - h3 event object
   * @param next - h3 next function
   */
  handler: Middleware;
}
/**
 * h3 middleware factory: takes optional initial options and returns
 * the h3-compatible handler.
 */
type H3MiddlewareFn = <A extends AdapterName$1 = "h3">(initialOptions?: Partial<H3MiddlewareOptions>) => H3MiddlewareHooks["handler"];
//#endregion
//#region src/types.d.ts
/**
 * Every framework adapter rpc ships a middleware for.
 *
 * This is the key type for {@link FrameworkHooks}, so `MiddlewareOptions<A>`
 * can type each adapter's `handler` signature. It is a *type* only — the
 * adapter you get is the one you import (`@thednp/rpc/express`,
 * `@thednp/rpc/hono`, …). There is deliberately no config option that selects
 * it: a runtime value could only ever disagree with the subpath actually
 * mounted, and nothing read it.
 */
type AdapterName = "express" | "hono" | "h3" | "fastify" | "koa";
/**
 * Maps each supported framework adapter to its middleware hooks (handler signatures).
 * Used to keep the middleware options type-safe per adapter.
 */
interface FrameworkHooks {
  /** Express/Connect middleware handler signature */
  express: ExpressMiddlewareHooks;
  /** Hono middleware handler signature */
  hono: HonoMiddlewareHooks;
  /** Fastify middleware handler signature */
  fastify: FastifyMiddlewareHooks;
  /** Koa middleware handler signature */
  koa: KoaMiddlewareHooks;
  /** h3 middleware handler signature */
  h3: H3MiddlewareHooks;
}
/**
 * Maps each supported framework adapter to its middleware factory function type.
 */
interface FrameworkMiddlewareFn {
  /** Express/Connect middleware factory */
  express: ExpressMiddlewareFn;
  /** Hono middleware factory */
  hono: HonoMiddlewareFn;
  /** Fastify middleware factory */
  fastify: FastifyMiddlewareFn;
  /** Koa middleware factory */
  koa: KoaMiddlewareFn;
  /** h3 middleware factory */
  h3: H3MiddlewareFn;
}
/**
 * Content types the RPC middleware accepts when reading request bodies.
 */
type SupportableContentType = "application/x-www-form-urlencoded" | "multipart/form-data" | "application/json" | "text/plain" | "application/octet-stream";
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
/**
 * Extracts a schema's output type, so the type flows into the handler.
 */
type InferOutput<S> = S extends StandardSchemaV1<infer _I, infer O> ? O : never;
/** Extracts a schema's declared input type. */
type InferInput<S> = S extends StandardSchemaV1<infer I, unknown> ? I : never;
/** Extracts the object shape described by a schema built from a field map. */
type InferShape<S extends Record<string, StandardSchemaV1<unknown, unknown>>> = { [K in keyof S]: InferOutput<S[K]>; };
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
/**
 * The JSON error body for a rejected input, sent as `422`.
 *
 * Development carries each issue's `message`; production carries `path` and
 * `hint` only, with `error` sourced from the fixed status table. The difference
 * is the single rule: production keeps what rpc or the author wrote, and drops
 * what the validator library wrote.
 */
interface ValidationErrorBody {
  readonly error: string;
  readonly code: "VALIDATION";
  readonly data: {
    readonly issues: readonly ValidationIssue[];
  };
  readonly hint?: string;
}
type ContentType = "application/json" | "text/plain" | "application/x-www-form-urlencoded" | "multipart/form-data";
/**
 * Fetch `credentials` policy used by the generated client modules.
 */
type Credentials = "same-origin" | "include" | "omit";
/**
 * Origin policy for the RPC endpoint.
 *
 * - `"self"` — only the server's own host and port, compared against `Host`
 *   with default ports normalised, so scheme-agnostic TLS termination needs no
 *   action.
 * - `string` / `string[]` — a literal allowlist, matched exactly. An allowlist
 *   **widens** `"self"` rather than replacing it, so the operator's own domain
 *   is never accidentally locked out.
 */
type OriginOption = "self" | string | string[];
/**
 * Parsed request body result discriminated by content type.
 */
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
} | {
  contentType: "application/x-www-form-urlencoded";
  data: Record<string, unknown>;
} | {
  contentType: "multipart/form-data";
  data: Record<string, unknown>;
};
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
// Keep these as a refference
// Date strings are common in APIs
// export type ISODateString = string; // for dates in ISO format
// Special types that might be useful
// export type Base64String = string; // for binary data encoded as base64
// export type URLString = string; // for URLs
// export type EmailString = string; // for email addresses
// export type RPCValue =
//   | JsonValue
//   | Date // will be serialized as ISOString
//   | Uint8Array // will be serialized as base64
//   | File // for file uploads
//   | Blob // for binary data
//   | URLSearchParams; // for query parameters
// export type ServerFnArgs = [JsonObject | JsonPrimitive, ...JsonArray];
/**
 * Arguments passed to a server function, spread as a JSON array.
 */
type ServerFnArgs = [...JsonArray];
/**
 * Server-side handler signature: receives the `AbortSignal` first,
 * followed by a single serializable input.
 */
type ServerFunction<TInput extends FormData | JsonValue = JsonValue, TResult = JsonValue> = (signal: AbortSignal, input: TInput) => Promise<TResult>;
/**
 * Server function initialization signature, identical to `ServerFunction`.
 * Used when registering a function with `createServerFunction`.
 */
type ServerFunctionInit<TInput extends FormData | JsonValue = JsonValue, TResult extends JsonValue | void = JsonValue> = (signal: AbortSignal, input: TInput) => Promise<TResult>;
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
 * A client function augmented with its registered export name and
 * per-function options (content type, credentials).
 */
type ClientFunctionWithOptions<TInput extends FormData | JsonValue = JsonValue, TResult = JsonValue> = ClientFunction<TInput, TResult> & {
  /** Registered export name of the server function */
  name: string;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
};
/**
 * Internal plugin options accepted by `getClientModules`.
 *
 * Only the prefix: the generated stubs are adapter-agnostic, since they are
 * plain `fetch` calls.
 */
interface RpcPluginOptionsInternal {
  /** RPC endpoint prefix (e.g. "__rpc") */
  rpcPrefix: string;
}
/**
 * Partial Vite config used when scanning server files outside a running dev server.
 */
interface ScanConfig extends Pick<ResolvedConfig, "base"> {
  root?: string;
  server?: Partial<ResolvedConfig["server"]>;
  serverFiles?: "exact" | "glob";
  scanRoot?: string;
  /** Default rpcPrefix to register scanned functions under when a function does not declare its own. Defaults to `__rpc` for backward compatibility. */
  rpcPrefix?: string;
}
/**
 * Entry in the server functions map: registered name, client handler,
 * optional per-function options, and the original export name.
 */
interface ServerFnEntry {
  /** Registered RPC function name (used in the URL path) */
  name: string;
  /** Client-side handler stub for this function */
  handler: ClientFunctionWithOptions;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
  /** Original export name from the server module */
  exportName?: string;
}
/**
 * ### @thednp/rpc
 * The plugin configuration allows for granular control of your
 * application RPC calls. The default settings are optimized for development
 * environments while providing a secure foundation for production use.
 */
interface RpcPluginOptions {
  // RPC Middleware Options
  /**
   * RPC prefix without leading slash (e.g. "__rpc")
   * Leading slash will be added automatically by the middleware.
   * This prefix defines the base path for all RPC endpoints.
   * @default "__rpc"
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix: "__rpc" | string;
  /**
   * Root directory from which the plugin scans for server files.
   * Defaults to `<root>/src/api`. Use this in monorepos where server files
   * live in a shared package outside the current project root.
   * @default undefined (resolves to src/api relative to the Vite root)
   */
  scanRoot?: string;
  /**
   * Server file matching mode. Use `"exact"` (default) for the classic
   * `server.ts|js|mjs|mts` names, or `"glob"` to match `**\/*.server.{ts,js,mjs,mts}`
   * inside the scan root.
   * @default "exact"
   */
  serverFiles?: "exact" | "glob";
  /**
   * Suppress the "no RPC config found" warning when no config file is
   * discovered. Useful when the plugin is wrapped by another tool that
   * provides configuration externally (e.g. a meta-framework adapter).
   * @default false
   */
  silent?: boolean;
}
/* ─── Execution context ───────────────────────────────────────────────────
 * The types for `onDispatch` live here rather than beside the implementation in
 * `execution-log.ts`, so the dependency runs one way: `types.d.ts` never imports
 * the module that implements them.
 */
/** How a dispatch ended. */
type DispatchOutcome = "ok" | "client-error" | "server-error";
/** The error a dispatch failed with, as far as a record may describe it. */
interface DispatchErrorRecord {
  /** The constructor name, e.g. `"NotFoundError"`. */
  name: string;
  /** The message. Present only when `includeMessages` is on. */
  message?: string;
  /** The `RPCError` code, when the failure was an `RPCError`. */
  code?: string;
  /** Whether the failure was an `RPCError` rather than an unexpected throw. */
  isRPCError: boolean;
  /** The stack, development only. */
  stack?: string;
}
/**
 * One dispatch, as handed to `onDispatch`.
 *
 * Every field is either a value the library already knows, or a **shape**. Args
 * are described rather than carried: see {@link argShape}.
 */
interface DispatchContext {
  /** The correlation id, also carried on failure responses when a hook is set. */
  id: string;
  /** The resolved prefix this dispatch ran under. */
  prefix: string;
  /** The function name matched from the path, or `""` when none matched. */
  functionName: string;
  /** The names registered under {@link DispatchContext.prefix}, for "did you mean" questions. */
  registeredNames: readonly string[];
  /** Which tier of the cross-origin rule decided the request. */
  originTier: OriginTier;
  /** The request method. */
  method: string;
  /** The function's declared method, when one was matched. */
  declaredMethod?: string;
  /** The function's declared `contentType`. */
  declaredContentType?: string;
  /** The `Content-Type` the client actually sent. */
  actualContentType?: string;
  /** Whether the declared and actual content types matched. */
  contentTypeMatched?: boolean;
  /** The argument list, described by shape. Never the values, by default. */
  argShape: string;
  /** The HTTP status answered. */
  status: number;
  /** How the dispatch ended. */
  outcome: DispatchOutcome;
  /** The failure, when there was one. */
  error?: DispatchErrorRecord;
  /** How long the dispatch took, in milliseconds. */
  durationMs: number;
}
/** The `onDispatch` hook's signature. */
type OnDispatch = (ctx: DispatchContext) => void | Promise<void>;
/**
 * The raw facts an adapter collected, before normalisation. Adapters supply what
 * they know; {@link createDispatcher} turns that into a {@link DispatchContext}
 * so the five adapters cannot drift in what they report.
 */
interface DispatchFacts {
  /**
   * The correlation id. rpc mints one when it is omitted, but an adapter that
   * already put an id on the response body passes the same value here so the
   * record and the body agree.
   */
  id?: string;
  /** The resolved prefix. */
  prefix: string;
  /** The matched function name, or `""`. */
  functionName?: string;
  /** Every name registered under the prefix. */
  registeredNames?: readonly string[];
  /** Which tier decided the cross-origin outcome. */
  originTier: OriginTier;
  /** The request method. */
  method: string;
  /** The matched function's declared method. */
  declaredMethod?: string;
  /** The matched function's declared content type. */
  declaredContentType?: string;
  /** The `Content-Type` header the client sent. */
  actualContentType?: string;
  /** Whether declared and actual matched, when both are known. */
  contentTypeMatched?: boolean;
  /** The received arguments. Shaped, never stored. */
  args?: readonly unknown[];
  /** The status answered. */
  status: number;
  /** The failure, when there was one. */
  error?: unknown;
  /**
   * When the dispatch started, as `Date.now()`. rpc derives the duration from
   * it, so the five adapters do not each re-implement the same timing.
   */
  startedAt: number;
}
/** Emits one record. Returned by {@link createDispatcher}. */
type EmitDispatch = (facts: DispatchFacts) => void;
interface MiddlewareOptions<A extends AdapterName = "express"> {
  /**
   * Name for the middleware (used for identification in Express stack)
   */
  name?: string;
  /**
   * Path pattern to match for middleware execution.
   * Accepts string or RegExp to filter requests based on URL path.
   *
   * @example
   * // String path
   * path: "/api/v1"
   *
   * // RegExp pattern
   * path: /^\/api\/v[0-9]+/
   */
  path?: string | RegExp;
  /**
   * RPC prefix without leading slash (e.g. "__rpc")
   * Leading slash will be added automatically by the middleware.
   * This prefix defines the base path for all RPC endpoints.
   * @default undefined — resolved with `resolveRPCPrefix()` to explicit, global, then `"__rpc"`
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix?: string;
  /**
   * Which origins may call the RPC endpoint.
   *
   * Defaults to `"self"`, so **cross-origin protection is on without any
   * configuration** — a request whose `Origin` is not the server's own host is
   * rejected with `403 Forbidden`. A missing option is the secure state, not an
   * unchecked one.
   *
   * - `"self"` — only the server's own host, compared host-only so TLS
   *   termination needs no action.
   * - `string` / `string[]` — a literal allowlist, matched exactly. An allowlist
   *   **widens** `"self"`, it never replaces it: your own domain stays allowed,
   *   so adding a sibling subdomain cannot silently break your own site.
   *
   * The comparison is host-and-port and never consults `X-Forwarded-Host`,
   * `X-Forwarded-Proto`, or any other forwarded header — a header an attacker
   * may influence must not decide "which host am I?". If an ingress rewrites
   * `Host` to a different name than the browser used, the honest fix is an
   * explicit `origin` entry naming the public origin.
   *
   * Rejection ladder, first signal with meaning wins:
   *
   * 1. `Origin` present → the allowlist (or `"self"`) decides. `Origin: null`
   *    (sandboxed iframes, `file://`, extensions) never equals a real origin, so
   *    it is rejected.
   * 2. `Origin` absent, `Sec-Fetch-Site` present → only `same-origin` and `none`
   *    pass. Browsers never strip `Origin` themselves, so reaching this tier
   *    means a proxy or CDN removed it — and with the precise signal gone, the
   *    check fails closed rather than becoming a no-op.
   * 3. Neither header present → **rejected** unless {@link allowHeaderless} is
   *    enabled. This is the curl/native-client case, and it is opt-in because a
   *    headerless POST is exactly what a CSRF request from a stripped context
   *    looks like.
   *
   * @see `isOriginRequestAllowed` in `@thednp/rpc/server` for the exact rule.
   */
  origin?: OriginOption;
  /**
   * Allow requests that send **neither** `Origin` nor `Sec-Fetch-Site`.
   *
   * These come from non-browser clients — `curl`, most runtimes' `fetch`, and
   * server-to-server calls. Rejecting them by default is deliberate: a request with no
   * browser provenance headers is indistinguishable from a cross-site form post
   * that had its headers stripped, so the secure default is to refuse and make
   * the operator opt in. A browser's native `<form>` navigation supplies `Origin`,
   * so the built-in no-JS fallback is checked normally.
   *
   * This only affects tier 3 of the ladder. A request that *does* carry an
   * `Origin` is still checked against the allowlist, so enabling this does not
   * weaken browser-facing protection.
   *
   * @default false
   * @example
   * // Trusted server-to-server client, no browser exposure at all
   * createRPCMiddleware({ allowHeaderless: true });
   */
  allowHeaderless?: boolean;
  /**
   * Maximum request body size, in bytes, on the paths where rpc reads the body
   * itself.
   *
   * Default `10 * 1024 * 1024` (10 MiB). A host framework's own limit does
   * **not** cover these paths: `express.json({ limit })` only applies to the
   * content types that parser claims, and declines urlencoded and multipart
   * requests, leaving them on the stream for rpc to read uncapped.
   *
   * Where a host framework parses the body first, its limit applies instead and
   * this option is not consulted. On Web-`Request` bodies this option streams
   * under the configured byte cap whenever the stream is still available; the
   * only uncapped inputs are bodies a host has already buffered, where that
   * host's limit is the operative one. See [Body size limits](./security.md#body-size-limits).
   *
   * Set to `0` to disable the cap and rely entirely on the host.
   * @default 10485760
   * @example
   * // accept larger uploads
   * app.use(createRPCMiddleware({ bodyLimit: 50 * 1024 * 1024 }));
   */
  bodyLimit?: number;
  /**
   * Called once per dispatch, after the response is settled, with a bounded and
   * redacted record of what happened.
   *
   * The library **retains nothing** — this is the whole point. There is no
   * built-in buffer, no ring and no TTL: a host that does not want request data
   * in memory does not get it, and a host with a logging pipeline needs nothing
   * from us. Whatever you pass it to is the storage. An earlier draft shipped a
   * bounded `createExecutionLog()` ring and it was cut, precisely because
   * holding request data in the library is the risk this hook exists to avoid.
   *
   * What arrives: the resolved prefix, the matched function name and the names
   * registered beside it, which tier of the cross-origin rule decided the
   * request, the declared vs actual content type and method, the **shape** of
   * the args, the status, the outcome, and how long it took. Args are
   * described by shape, never carried — values routinely include passwords, so
   * a record of a record leaks.
   *
   * A hook that throws (or rejects) is ignored: a logging facility that takes
   * down the request it is describing is worse than one that loses a record.
   *
   * Registering a hook also puts a correlation `id` on failure responses, so a
   * caller can be handed something to quote. With no hook there is no id and the
   * error body is byte-for-byte what it was.
   *
   * @example
   * const seen: DispatchContext[] = [];
   * app.use(createRPCMiddleware({ onDispatch: (ctx) => seen.push(ctx) }));
   */
  onDispatch?: (ctx: DispatchContext) => void | Promise<void>;
  /**
   * Server file matching mode. Use `"exact"` for `server.ts|js|mjs|mts`
   * names, or `"glob"` to match `**\/*.server.{ts,js,mjs,mts}` inside the
   * scan root. Only used for the lazy production scan when the middleware
   * populates its prefix map on first request.
   * @default "exact"
   */
  serverFiles?: "exact" | "glob";
  /**
   * Root directory for scanning server files. Defaults to `<root>/src/api`.
   * Only used for the lazy production scan.
   */
  scanRoot?: string;
  /**
   * Async handler for request processing.
   * Core middleware function that processes incoming requests.
   *
   * @param req - The incoming request object
   * @param res - The server response object
   * @param next - Function to pass control to the next middleware
   *
   * @example
   * handler: async (req, res, next) => {
   *   // Process request
   *   const data = await processRequest(req);
   *
   *   // Send response
   *   sendResponse(res, { data }, 200);
   * }
   */
  handler?: FrameworkHooks[A]["handler"];
}
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
//#region src/index.d.ts
/**
 * Loads the RPC configuration by searching for config files in the project root.
 * Searches in order: `rpc.config.ts`, `rpc.config.js`, `rpc.config.mjs`, `rpc.config.mts`,
 * `.rpcrc.ts`, `.rpcrc.js`. Falls back to defaults if none found.
 * @param configFile - Optional explicit config file path; skips file search when provided
 * @param opts - Optional settings; `silent` suppresses the "no config found" warning
 * @returns Resolved RPC plugin options
 */
declare const loadRPCConfig: (configFile?: string | {
  silent?: boolean;
}, opts?: {
  silent?: boolean;
}) => Promise<RpcPluginOptions>;
/**
 * Vite plugin that enables automatic RPC generation.
 * Transforms server function imports into fetch-based client stubs during development and production builds.
 * In dev mode, attaches the RPC middleware to Vite's Connect server.
 * @param devOptions - Development-only overrides (merged on top of config file values)
 * @returns A Vite plugin object
 */
declare function rpcPlugin(devOptions?: Partial<RpcPluginOptions>): Plugin;
//#endregion
export { type AdapterName, type BodyResult, type ClientFunction, type ClientFunctionWithOptions, type ContentType, type Credentials, type DispatchContext, type DispatchErrorRecord, type DispatchFacts, type DispatchOutcome, type EmitDispatch, type FormFallbackOptions, type FormFallbackOutcome, type FrameworkHooks, type FrameworkMiddlewareFn, type InferInput, type InferOutput, type InferShape, type InnerModReturn, type JsonArray, type JsonObject, type JsonPrimitive, type JsonValue, type MiddlewareOptions, type NoArgClientFunction, type OnDispatch, type OriginOption, type RpcPluginOptions, type RpcPluginOptionsInternal, type ScanConfig, type ServerFnArgs, type ServerFnEntry, type ServerFunction, type ServerFunctionInit, type ServerFunctionOptions, type StandardSchemaIssue, type StandardSchemaResult, type StandardSchemaV1, type StandardSchemaValidateOptions, type StubOptions, type SupportableContentType, type ValidationErrorBody, type ValidationIssue, rpcPlugin as default, loadRPCConfig };
//# sourceMappingURL=index.d.mts.map