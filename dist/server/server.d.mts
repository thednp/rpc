import { Connect, ResolvedConfig, ViteDevServer } from "vite";
import "@thednp/rpc";
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
//#endregion
//#region src/fastify/types.d.ts
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
//#endregion
//#region src/h3/types.d.ts
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
 * Server function initialization signature, identical to `ServerFunction`.
 * Used when registering a function with `createServerFunction`.
 */
type ServerFunctionInit<TArgs extends FormData | JsonArray = JsonArray, TResult = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
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
 * A client function augmented with its registered export name and
 * per-function options (content type, credentials).
 */
type ClientFunctionWithOptions<T extends JsonArray = JsonArray, A extends JsonValue = JsonValue> = ClientFunction<T, A> & {
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
//#endregion
//#region src/functionsMap.d.ts
/**
 * Map of rpcPrefix -> Map of function names -> ServerFnEntry
 * Enables multiple RPC instances with different prefixes to coexist
 * without name collisions.
 */
export declare const serverFunctionsByPrefix: Map<string, Map<string, ServerFnEntry>>;
/**
 * Gets or creates the function map for a specific prefix.
 * @param prefix - The RPC prefix (e.g., "__rpc", "v1:rpc", "admin:rpc")
 * @returns Map of function names to ServerFnEntry for that prefix
 */
export declare const getFunctionsForPrefix: (prefix: string) => Map<string, ServerFnEntry>;
/**
 * Backward compatibility: default map for the default prefix.
 * Legacy code can still use serverFunctionsMap.set(name, entry).
 */
export declare const serverFunctionsMap: Map<string, ServerFnEntry>;
//#endregion
//#region src/scanForServerFiles.d.ts
/** Absolute ids (normalized) of the scanned server function files. */
export declare const scannedServerFiles: Set<string>;
/**
 * Scans `src/api/` (or an explicit `scanRoot`) for server function files
 * and populates the server functions map (scoped by rpcPrefix) with their exported functions.
 * Uses Vite's SSR module loading to resolve and execute each file.
 *
 * Supports two matching modes via `config.serverFiles`:
 *   `"exact"` — classic `server.ts|js|mjs|mts` names in the api directory
 *   `"glob"` — recursively walking `scanRoot` to match `*.server.{ts,js,mjs,mts}`
 * @param initialCfg - Optional Vite config overrides (root, base, server, serverFiles, scanRoot)
 * @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
 */
export declare const scanForServerFiles: (initialCfg?: ScanConfig, devServer?: ViteDevServer) => Promise<void>;
//#endregion
//#region src/createFunction.d.ts
/**
 * Extended options for createServerFunction, including rpcPrefix for multi-instance support.
 */
export interface CreateServerFunctionOptions extends Partial<ServerFunctionOptions> {
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
export declare function createServerFunction<TSchema extends StandardSchemaV1<unknown, unknown>, TResult extends JsonValue = JsonValue>(name: string, handler: (signal: AbortSignal, input: InferOutput<TSchema>, ...rest: JsonValue[]) => Promise<TResult>, fnOptions: CreateServerFunctionOptions & {
  schema: TSchema;
}): ClientFunction<[InferInput<TSchema> & JsonValue, ...JsonValue[]], TResult>;
/**
 * Creates a server function with no input schema.
 *
 * The options type forbids `schema` (`schema?: undefined`), which is what stops
 * a schema-bearing call from silently falling through to this overload after
 * failing the one above — the mismatch would otherwise be accepted with an
 * untyped input.
 */
export declare function createServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue>(name: string, handler: ServerFunctionInit<TArgs, TResult>, fnOptions?: CreateServerFunctionOptions & {
  schema?: undefined;
}): ClientFunction<TArgs, TResult>;
//#endregion
//#region src/getClientModules.d.ts
/**
 * Generates the complete client-side module bundle by iterating all registered server functions
 * for a specific prefix and producing fetch-based stubs for each. The result is transformed by Vite
 * (or Oxc) during the dev server or production build.
 *
 * The generated stubs are plain `fetch` calls, so they are adapter-agnostic —
 * only the prefix is needed.
 * @param initialOptions - Plugin options containing the rpcPrefix
 * @returns A string of JavaScript code with all client RPC modules and their import dependencies
 */
export declare const getClientModules: (initialOptions: RpcPluginOptionsInternal) => string;
//#endregion
//#region src/server-helpers.d.ts
/**
 * Recursively walks `dir` and collects absolute paths to files whose
 * basename matches the `*.server.{ts,js,mjs,mts}` glob pattern.
 */
export declare const walkGlobFiles: (dir: string) => Promise<string[]>;
/** Registered brand carried by every {@link RPCError}, across bundle copies. */
export declare const RPC_ERROR_BRAND: unique symbol;
/**
 * Recognises an {@link RPCError} without `instanceof`, so the check holds
 * across tsdown's per-entry copies of the class.
 */
export declare const isRPCError: (err: unknown) => err is RPCError;
/**
 * A typed error thrown from server functions.
 *
 * `formatError` decides what crosses the wire. Unexpected exceptions always
 * answer `{ error: "Internal Server Error" }`; typed errors keep the status
 * reason plus the semantics `formatError` documents.
 */
export declare class RPCError extends Error {
  /**
   * A cross-bundle brand, so `instanceof` is not the only way to recognise one.
   *
   * Each tsdown entry bundles its own copy of this class, so a `ValidationError`
   * raised by `runValidation` inside `dist/server/server.mjs` is **not** an
   * `instanceof` the `RPCError` in `dist/express/express.mjs` — the check
   * silently answers false across entries. `Symbol.for` is registry-global
   * across bundles and realms, so this brand survives the duplication. The same
   * reason `setGlobalPrefix` stores its value under a registered symbol.
   */
  readonly [RPC_ERROR_BRAND] = true;
  /** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
  code: string;
  /** Optional diagnostic payload */
  data?: JsonValue;
  /**
   * Developer-facing advice about how to fix the failure, dev-only.
   *
   * A message says what went wrong; a hint says what to do about it.
   * `formatError` decides what crosses the wire: a `ValidationError` keeps
   * author-written paths and hints while dropping the validator library's
   * `message`; the other typed errors keep the status reason phrase in
   * production. See {@link NotFoundError} and siblings for the typed forms.
   */
  hint?: string;
  constructor(message: string, code?: string, data?: JsonValue, hint?: string);
}
/**
 * A `404` that teaches. The `hint` is **required**, deliberately: an error class
 * whose whole purpose is to explain a failure should not be constructible
 * without the explanation. It is still stripped in production.
 */
export declare class NotFoundError extends RPCError {
  /** The client-error status, so adapters answer `404` and not `500`. */
  readonly status = 404;
  constructor(message: string, hint: string, data?: JsonValue);
}
/** A `403` that teaches. See {@link NotFoundError} for why `hint` is required. */
export declare class ForbiddenError extends RPCError {
  /** The client-error status, so adapters answer `403` and not `500`. */
  readonly status = 403;
  constructor(message: string, hint: string, data?: JsonValue);
}
/** A `409` that teaches. See {@link NotFoundError} for why `hint` is required. */
export declare class ConflictError extends RPCError {
  /** The client-error status, so adapters answer `409` and not `500`. */
  readonly status = 409;
  constructor(message: string, hint: string, data?: JsonValue);
}
/**
 * A rejected input: a `422` that carries structured issues.
 *
 * Lives here rather than in `schema.ts` so the error types and the builder have a
 * single direction between them — `schema.ts` imports this, not the reverse.
 */
export declare class ValidationError extends RPCError {
  /**
   * The client-error status, so adapters answer `422` and not `500`.
   *
   * `422` rather than `400` on purpose: the body parsed and the *fields* are
   * wrong, which is a different thing from a request that could not be parsed
   * at all. Sharing `400` left a client unable to tell a malformed body from a
   * rejected input without reading the prose.
   */
  readonly status = 422;
  /** The rendered issues, one per rejected field. */
  readonly issues: readonly ValidationIssue[];
  /**
   * @param issues - The rendered issues, one per rejected field.
   * @param hint - A general hint about how to fix the failure, inherited from
   *   {@link RPCError.hint} and dev-only like it.
   */
  constructor(issues: readonly ValidationIssue[], hint?: string);
}
/** Options for {@link validationErrorBody}. */
export interface ValidationBodyOptions {
  /**
   * Include each issue's vendor `message`.
   *
   * Defaults to `true`; `formatError` passes `false` for production responses.
   * The reason is measured rather than assumed: the default messages of some
   * libraries interpolate the value that failed. Going
   * through `~standard.validate` with `name: 12345`, valibot returns
   * `"Invalid type: Expected string but received 12345"`, while zod returns
   * `"Invalid input: expected string, received number"` and arktype
   * `"name must be a string (was a number)"`. So whether a message is safe
   * depends on which library the author picked, which is the worst shape for a
   * rule — it cannot be reasoned about portably, so it has to be structural.
   *
   * `path` and `hint` are not withheld by this flag because they are not
   * library-written: a `path` names a field the caller itself supplied and can
   * already see, and a `hint` is author-written in `ServerFunctionOptions`, so
   * sending it was a deliberate act. A vendor `message` is neither, and depending
   * on one also couples a project's error text to that library's release cycle.
   */
  includeMessages?: boolean;
}
/** Builds the JSON body for a rejected input. */
export declare const validationErrorBody: (err: ValidationError, options?: ValidationBodyOptions) => ValidationErrorBody;
/**
 * Formats an error for the RPC middleware response. See {@link ValidationError} for the rejected-input contract.
 *
 * In development the full `RPCError` payload is included so developers
 * can quickly identify issues. Unexpected exceptions never expose their
 * message — only the generic "Internal Server Error" is sent, preventing
 * information disclosure; server-side diagnostics are preserved via the
 * middleware's `console.error` logging.
 * @param err - The caught error
 * @param isProduction - Whether the response uses the production body contract
 * @returns The response body for the dispatch
 */
export declare const formatError: (err: unknown, isProduction: boolean) => JsonObject;
/**
 * An error carrying an HTTP status, so the dispatch can answer that status
 * instead of flattening every failure to a `500`.
 */
export interface ClientHttpError extends Error {
  status?: number;
  statusCode?: number;
}
/**
 * Tags an error with an HTTP status for the dispatch to surface.
 *
 * Used where a malformed *request* is the fault — a body that does not parse
 * under a declared JSON `Content-Type`, a GET `?args=` value that is not valid
 * JSON. Every host framework rpc supports answers `400` for these (Express
 * `entity.parse.failed`, Fastify `FST_ERR_CTP_INVALID_JSON_BODY`, koa-bodyparser,
 * and h3's own `readBody`), and treating one as a server fault both misreports
 * the fault and turns a trivial client mistake into a log entry.
 * @param status - The HTTP status to answer with
 * @param message - Internal diagnostic message; never sent to the client
 * @returns An `Error` carrying `status`
 */
export declare const httpError: (status: number, message: string) => ClientHttpError;
/**
 * Recognises an error that should produce a `4xx` response rather than a `500`.
 * Matches the `status` / `statusCode` convention used by h3's `HTTPError`, the
 * `http-errors` objects Express's `body-parser` throws, and anything else
 * carrying a numeric 4xx. Shared by all five adapters so a host-framework
 * signal and an rpc-raised one are handled by the same rule.
 * @param err - The caught error
 * @returns True when the error denotes a client (4xx) fault
 */
export declare const isClientHttpError: (err: unknown) => boolean;
/**
 * Reads the status to answer for a client error. Defaults to `400` rather than
 * `500` so an unrecognised 4xx is never reported as a server fault.
 * @param err - The caught error
 * @returns The 4xx status to answer with
 */
export declare const clientErrorStatus: (err: unknown) => number;
export declare const clientErrorMessage: (status: number) => string;
/**
 * Checks whether a content type maps to a form encoding
 * (`multipart/form-data` or `application/x-www-form-urlencoded`).
 * Form-declared functions accept either encoding so native browser
 * submissions (urlencoded) keep working without JavaScript.
 */
export declare const isFormContentType: (contentType: string) => boolean;
/**
 * Detects whether an incoming request's `Content-Type` header conflicts
 * with the function's declared content type. JSON and text functions are
 * enforced strictly (exact match wins), while form functions accept both
 * form encodings because the nojs fallback submits urlencoded forms to
 * multipart-declared endpoints. Requests without a `Content-Type` header
 * (curl, GET, legacy clients) are exempt from enforcement.
 * @param declared - The declared `contentType` from the server function options
 * @param rawHeader - The raw `Content-Type` request header, if present
 */
export declare const hasContentTypeMismatch: (declared: ContentType, rawHeader: string | undefined) => boolean;
/**
 * Inputs for {@link isOriginRequestAllowed}. Passed as an object rather than
 * positionally so that a call site cannot silently swap `site` for `host` — in a
 * function whose job is to decide whether a request is a forgery, argument
 * confusion is the wrong failure mode.
 */
export interface OriginCheck {
  /** The configured `origin` policy. `undefined` resolves to the secure default. */
  allowed?: OriginOption;
  /** The raw `Origin` request header, if present. */
  origin?: string;
  /** The raw `Sec-Fetch-Site` request header, if present. */
  site?: string;
  /** The `Host` request header, used only for the host-only `"self"` comparison. */
  host?: string;
  /** Whether requests carrying neither header are permitted. */
  allowHeaderless?: boolean;
}
/**
 * Which tier of the cross-origin rule decided a request, and whether it passed.
 *
 * `"blocked"` means the rule refused — either `Sec-Fetch-Site` was present and
 * untrusted, or neither header was sent and `allowHeaderless` was off. The three
 * passing tiers are `"origin"`, `"sec-fetch-site"` and `"headerless"`, and the
 * distinction is the point: "allowed because the Origin matched" and "allowed
 * because nothing was sent" are very different facts about a request.
 */
type OriginTier$1 = "origin" | "sec-fetch-site" | "headerless" | "blocked";
/** The outcome of {@link describeOriginRequest}. */
export interface OriginDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The tier that decided it. */
  tier: OriginTier$1;
}
/**
 * Decides whether a request may proceed, given the configured origin policy and
 * the headers a browser can be made to reveal.
 *
 * The default policy is `"self"`, so this is **on by default**: a request from
 * another origin is rejected unless the operator opted in. Rejection ladder,
 * first signal with meaning wins:
 *
 * 1. `Origin` present → the policy decides.
 * 2. `Origin` absent, `Sec-Fetch-Site` present → only `same-origin` and `none`.
 * 3. Neither present → only if `allowHeaderless`.
 *
 * **Tier 1 must short-circuit ahead of tier 2.** `Sec-Fetch-Site` is a coarse
 * four-value enum that cannot name a host, so on its own it would reject a
 * legitimate request from an allowlisted sibling subdomain (`same-site`). The
 * allowlist exists precisely to admit that case, and it can only do so while
 * `Origin` survives. `Sec-Fetch-Site` earns a vote only once the precise signal
 * has been stripped away by something in the chain — at which point there is
 * nothing left to trust, so it fails closed.
 *
 * **Comparison is host-and-port.** The scheme is never compared, so TLS termination
 * needs no action and no `X-Forwarded-Proto` trust. Default ports are normalised,
 * but a non-default port must match both sides. Forwarded headers are never
 * consulted at all: `X-Forwarded-Host` is attacker-influenceable, and letting a
 * header answer "which host am I?" would hand the decision to the request. An
 * ingress that rewrites `Host` is handled by naming the public origin explicitly.
 *
 * An empty (or whitespace-only) header value counts as **absent**, not as an
 * unrecognised signal. No browser emits an empty `Sec-Fetch-Site`, and adapters
 * disagree on what their header accessor returns for a missing header (Node's
 * `req.headers` yields `undefined`, Hono's `c.req.header()` may yield `""`).
 * Normalising here keeps all five adapters behaving identically.
 * @param check - The configured policy and the request's raw headers
 * @returns `true` when the request may proceed
 */
export declare const isOriginRequestAllowed: (check: OriginCheck) => boolean;
/**
 * The same decision as {@link isOriginRequestAllowed}, plus **which tier made
 * it** — so an execution-context record can answer "why was this allowed?"
 * rather than only "was it?".
 *
 * The rule lives here once and `isOriginRequestAllowed` is a projection of it.
 * A second copy of the tier order in the recorder would be exactly the
 * copy-paste divergence `AGENTS.md` warns about for the adapters: the two would
 * agree until someone edited one.
 */
export declare const describeOriginRequest: ({ allowed, origin, site, host, allowHeaderless }: OriginCheck) => OriginDecision;
/**
 * Whether an `Origin` header denotes the server's own host and port.
 *
 * Compares lowercased `host[:port]`, with default ports normalised by the URL
 * parser (`https://app.example.com:443` matches `Host: app.example.com`), while
 * a mismatched non-default port fails. The scheme is ignored so that a
 * TLS-terminating proxy needs no configuration, and a mismatched scheme is not a
 * forgery signal. If the `Host` header is missing the comparison cannot be made,
 * so it fails closed.
 * @param origin - The raw `Origin` header value
 * @param host - The raw `Host` header value
 * @returns `true` when the origin's lowercased `host[:port]` matches the `Host` header
 */
export declare const isSelfOrigin: (origin: string, host?: string) => boolean;
/**
 * Escapes special regex metacharacters in a string.
 * Used to safely embed user-configurable values (like rpcPrefix) into regular expressions,
 * preventing ReDoS and regex injection attacks.
 * @param s - The raw string to escape
 * @returns The escaped string safe for use in new RegExp()
 */
export declare function escapeRegExp(s: string): string;
/**
 * Decides whether a request's `Origin` header is allowed by the configured
 * allowlist. Shared by all five adapters so the rule lives in exactly one place.
 *
 * This is the **literal-match primitive**, not the whole policy. It has no
 * concept of `"self"`, of host-only comparison, or of headerless requests — those
 * live in {@link isOriginRequestAllowed}, which delegates here for the literal
 * half of tier 1. Kept separate so the exact-match behaviour stays a small,
 * independently testable piece with its original signature.
 *
 * - No `allowed` value (option unset) → everything passes: no validation.
 * - No `requestOrigin` header → passes, preserving curl/native-client access.
 * - Otherwise the header must match one of the entries exactly.
 *
 * A single string and a one-element array behave identically, so widening
 * `origin` to `string | string[]` is backward compatible.
 *
 * `Origin: null` (sandboxed iframes, `file://`, extension pages) is rejected
 * whenever an allowlist is set, because it never equals a real origin.
 *
 * This is the literal-match primitive only. It takes absent policy or header as
 * "no signal", so do not use it directly for gating — call
 * {@link isOriginRequestAllowed}, which applies `"self"` and the fail-closed
 * headerless rule.
 * @param allowed - The configured `origin` option, if any
 * @param requestOrigin - The raw `Origin` request header, if present
 * @returns `true` when the request may proceed
 */
export declare const isOriginAllowed: (allowed: string | string[] | undefined, requestOrigin: string | undefined) => boolean;
/**
 * Parses a raw request URL against a fixed base without ever throwing.
 * Malformed request-targets (e.g. `/\`, `//`, `/\/`) make the WHATWG URL
 * parser throw `TypeError: Invalid URL`; the adapters call this while
 * building the per-request URL **before** their dispatch `try` block, so an
 * unhandled rejection there crashes raw `node:http` hosts (and Express 4).
 * On failure we fall back to the base root: the resulting pathname never
 * matches the RPC prefix, so the request is treated as non-RPC and falls
 * through to `next()` / 404 instead of crashing the process.
 * @param rawUrl - Raw request URL (path + optional query string)
 * @param base - Optional base URL, defaults to a fixed localhost origin
 * @returns A URL object; never throws
 */
export declare const safeURL: (rawUrl: string, base?: string) => URL;
/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
export declare const getGlobalPrefix: () => string | undefined;
/**
 * Publishes the global RPC prefix, consulted by `resolveRPCPrefix` whenever no
 * explicit prefix is supplied. `loadRPCConfig` calls this on every return path
 * so a loaded config is the fallback for later registrations and dispatches.
 *
 * Stored on a `Symbol.for` key on `globalThis` so it stays instance-stable
 * across the bundled entry copies (`server.mjs`, `express.mjs`, ...) and dev
 * server hot reloads — the same technique as the request-context storage.
 * @param prefix - The prefix to publish, or `undefined` to clear it
 */
export declare const setGlobalPrefix: (prefix: string | undefined) => void;
/**
 * Resolves the effective RPC prefix: the explicit one when given, otherwise
 * the global prefix set by `setGlobalPrefix` / `loadRPCConfig`, otherwise the
 * built-in default.
 *
 * Every adapter resolves its prefix through this single function — in both the
 * outer `createMiddleware` gate and the `createRPCMiddleware` dispatch — so the
 * two halves of a request can never disagree, and so a prefix registered by
 * `createServerFunction` (which resolves the same way) is always the prefix the
 * middleware looks up. Resolving the two sides independently is what allowed
 * h3 to drift from the other four adapters, and what left the documented
 * global-prefix flow returning 404 on all of them.
 * @param rpcPrefix - Explicit prefix from config or middleware options
 * @returns The prefix to gate on, look up in, and strip from the request path
 */
export declare const resolveRPCPrefix: (rpcPrefix?: string) => string;
//#endregion
//#region src/context.d.ts
/**
 * A per-request context established by the framework adapters around
 * server-function dispatch, mirroring Solid Start's `FetchEvent`. Any code
 * running in the async tree of a dispatch can read the current context through
 * {@link getRequestContext} instead of threading `req`/`res` (or the framework
 * `Context` object) through every nested call. This module is server-only and
 * must never be imported by client code.
 *
 * Each adapter extends this with framework-specific request/response accessors:
 * - Express: `req`/`res` plus `nativeEvent = { req, res }`
 * - Fastify: `request`/`reply` plus `nativeEvent = request`
 * - Koa: `ctx` plus `nativeEvent = ctx`
 * - Hono: `c` (the Hono `Context`) plus `nativeEvent = c`
 * - h3: `event` (the h3 `H3Event`) plus `nativeEvent = event`
 */
export interface RequestEvent {
  /** Adapter-specific native event kept for deep framework access */
  nativeEvent?: unknown;
  /** Adapter request object */
  request: unknown;
  /** Adapter response object */
  response: unknown;
  /**
   * Bound adapter-native redirect. Performing a redirect sets `redirected`
   * so the middleware can skip the JSON `{ data }` send.
   * @param location - The URL to redirect to
   * @param status - HTTP status code, defaults to `303 See Other`
   */
  redirect: (location: string, status?: number) => void;
  /**
   * Set by `redirect` once a redirect has been issued. The middleware checks
   * this after `await`ing the server function to avoid double-responding.
   */
  redirected?: {
    location: string;
    status: number;
  };
  /**
   * Bound adapter-native response short-circuit. Writes the given status and
   * JSON body (plus optional headers) directly, bypassing the standard
   * `{ data }` response. Setting `sent` makes the middleware skip the JSON
   * `{ data }` send, mirroring `redirect`/`redirected`.
   * @param status - HTTP status code (e.g. 401, 413, 429)
   * @param body - JSON-serializable response body
   * @param headers - Optional response headers (e.g. `{ "Retry-After": "60" }`)
   */
  send: (status: number, body: JsonValue, headers?: Record<string, string>) => void;
  /**
   * Set by `send` once a response has been issued. The middleware checks this
   * after `await`ing the server function to avoid double-responding.
   */
  sent?: {
    status: number;
    body: JsonValue;
    headers?: Record<string, string>;
  };
  /**
   * The matched RPC function name for the current request, when available.
   * Useful for per-function rate limiting or auditing inside middleware.
   */
  functionName?: string;
  /** Per-request app data shared across the async tree of the dispatch */
  locals: Record<string, unknown>;
  [prop: string]: unknown;
}
/**
 * Runs `cb` with `init` as the current request context. Use inside the
 * adapters around server-function dispatch (the async tree under `cb` can then
 * read the context via {@link getRequestContext}).
 * @param init - The request context for the duration of `cb`
 * @param cb - The work that needs access to the request context
 */
export declare const provideRequestContext: <T>(init: RequestEvent, cb: () => T) => T;
/**
 * Returns the current request context, or throws when called outside of a
 * request (e.g. module scope or a background task).
 * @throws When no request context is established
 */
export declare const getRequestContext: () => RequestEvent;
/**
 * Redirects the current request to `location`. Reads the adapter-bound
 * `redirect` from the current request context — callable from anywhere inside
 * a server-function tree (no `res` threading needed).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to `303 See Other`
 * @throws When called outside of a request
 */
export declare const redirect: (location: string, status?: number) => void;
/**
 * Sends a raw JSON response for the current request, bypassing the standard
 * `{ data }` shape. Reads the adapter-bound `send` from the current request
 * context — callable from anywhere inside a server-function tree. Any code in
 * the async tree of a dispatch can call this (e.g. custom middleware) to
 * short-circuit with a specific status code (401, 413, 429, ...).
 * @param status - HTTP status code
 * @param body - JSON-serializable response body
 * @param headers - Optional response headers
 * @throws When called outside of a request
 */
export declare const sendResponse: (status: number, body: JsonValue, headers?: Record<string, string>) => void;
/**
 * Normalized, adapter-agnostic view of the current request. Reads the request
 * object off the current request context and normalizes it across the five
 * adapter request shapes (Express `req`, Fastify `req`, Koa `ctx.req`,
 * Hono `c.req`, h3 `event.req`) so middleware can be written once.
 */
export interface RequestMeta {
  /** HTTP method, upper-cased (e.g. "GET", "POST") */
  method: string;
  /** URL pathname (e.g. "/__rpc/greet") */
  pathname: string;
  /** Raw search string including the leading "?", or "" when absent */
  search: string;
  /** Parsed search params */
  searchParams: URLSearchParams;
  /** Request headers, lower-cased */
  headers: Record<string, string | string[] | undefined>;
  /** Host header value (e.g. "localhost:5173"), when present */
  host?: string;
  /** Client IP when the framework exposes it (e.g. Fastify `req.ip`) */
  ip?: string;
  /** Request protocol ("http" or "https"), when determinable */
  protocol?: string;
}
/**
 * Reads normalized, adapter-agnostic request metadata from the current request
 * context. Works with Express `req`, Fastify `req`, Koa `ctx.req`,
 * Hono `c.req` and h3 `event.req` by feature-detecting the request shape
 * (`originalUrl`/`url`/`path`, raw `headers` map vs `Headers`-like API).
 * @param event - The request context to read, typically the result of
 *   {@link getRequestContext}
 */
export declare const getRequestMeta: (event: RequestEvent) => RequestMeta;
//#endregion
//#region src/options.d.ts
/**
 * Defaults applied to a server function that declares no `method`,
 * `credentials`, or `contentType` of its own.
 */
export declare const defaultServerFnOptions: ServerFunctionOptions;
/**
 * The built-in RPC endpoint prefix, used when neither an explicit prefix nor a
 * global one (`getGlobalPrefix`) is supplied. Kept for backward compatibility
 * with pre-multi-prefix setups, where every function lived under this one map.
 */
export declare const defaultPrefix = "__rpc";
/**
 * Baseline plugin options. `defineConfig` merges a user's partial config over
 * these, and `loadRPCConfig` merges a loaded config file over them, so every
 * option has a defined value even when a config file omits it.
 */
export declare const defaultRPCOptions: RpcPluginOptions;
/**
 * Baseline middleware options. Note `rpcPrefix` is `undefined` rather than
 * `defaultPrefix` on purpose: leaving it unset lets `resolveRPCPrefix` fall
 * through to the global prefix, which is what makes a published global prefix
 * reach the middleware.
 *
 * `origin` is the opposite case, and deliberately so: it defaults to the secure
 * `"self"` policy rather than to "no check", so an RPC endpoint created with no
 * options at all is cross-origin protected. `allowHeaderless` defaults to
 * `false` for the same reason — headerless clients are opt-in.
 *
 * Neither default is a bypass. `Object.assign(defaults, options)` copies an
 * explicit `origin: undefined` over the default, so `isOriginRequestAllowed`
 * also resolves an absent policy to `"self"` itself. Two independent guards,
 * because a security default that one merge call can erase is not a default.
 */
export declare const defaultMiddlewareOptions: MiddlewareOptions;
//#endregion
//#region src/schema.d.ts
/** Options accepted by every builder entry point. */
export interface BuildOptions {
  /** A teaching hint for this field or schema. Dev-only in the response. */
  readonly hint?: string;
}
/**
 * A schema this module built, which may additionally carry the hints attached to
 * its own fields.
 *
 * The hints live *beside* `~standard` rather than inside it, so a builder schema
 * stays a valid Standard Schema and a foreign schema (zod, valibot) remains
 * interchangeable with one. A foreign schema has no `hints`, which is why hints
 * can also be supplied at the call site.
 */
export type HintedSchema<S> = S & {
  /** Per-path teaching hints, keyed by the rendered path (`"a.b[0].c"`). */
  hints?: Record<string, string>;
};
/**
 * A schema built by this module, carrying its own hints and output type.
 *
 * Parameterised on `Output` deliberately: a builder that erased it to `unknown`
 * would make `schema({ a: field.number() })` infer `{ a: unknown }`, and the
 * whole point of the type flowing into the handler is lost.
 */
export type BuilderSchema<Output> = StandardSchemaV1<unknown, Output> & {
  hints?: Record<string, string>;
  /**
   * Hints about this schema's **value**, keyed by a path relative to that value.
   *
   * Kept separate from `hints` so a value hint can never be applied to the
   * container's own issue: without the split, `tags: expected an array` would
   * carry "one tag per entry".
   *
   * Relative rather than absolute because a container's keys are not knowable
   * at declaration time — a record produces `map.k.b` and an array
   * `tags[1]`, so a hint written for the value's `b` cannot be stored at an
   * absolute path. Lookup strips the field's own key and matches the remainder.
   */
  valueHints?: Record<string, string>;
  /**
   * Only on the root schema `schema()` returns: `valueHints` for every field,
   * grouped by that field's key. Kept separate from `valueHints` because the
   * two have different shapes — one is relative to a single value, the other
   * maps a field name to such a map.
   */
  valueHintsByField?: Record<string, Record<string, string>>;
  /** Identifies builder schemas, for nesting and debugging. */
  kind?: string;
};
/** A builder schema of unknown output. */
export type AnySchema = BuilderSchema<unknown>;
/** The leaf validators: primitive checks, or a validator you supply. */
export interface FieldHelpers {
  /** Requires a `string`. */
  string(opts?: BuildOptions): BuilderSchema<string>;
  /** Requires a finite `number`; `NaN` and `Infinity` are rejected. */
  number(opts?: BuildOptions): BuilderSchema<number>;
  /** Requires a `boolean`. */
  boolean(opts?: BuildOptions): BuilderSchema<boolean>;
  /**
   * Wraps any Standard Schema as a leaf.
   *
   * This is what stops the builder becoming a second dialect: a leaf can be a
   * zod schema, a valibot schema, or a predicate, and it composes inside our
   * structure unchanged. Its own issue paths are rebased like any other child.
   */
  custom<Output>(inner: StandardSchemaV1<unknown, Output>, opts?: BuildOptions): AnySchema;
}
/** A leaf validator: one of the primitive checks, or a validator you supply. */
export declare const field: FieldHelpers;
/** Allows `undefined`; `null` is still rejected. */
export declare const optional: <T>(inner: StandardSchemaV1<unknown, T>) => BuilderSchema<T | undefined>;
/** Allows `null`; `undefined` is still rejected. */
export declare const nullable: <T>(inner: StandardSchemaV1<unknown, T>) => BuilderSchema<T | null>;
/**
 * An array whose every element matches `inner`.
 *
 * Element hints are kept index-agnostic: a hint written for the inner field
 * applies to every element, and the lookup strips `[n]` before matching, so
 * `array(field.string({ hint }))` teaches the right thing for `tags[7]`.
 */
export declare const array: <T>(inner: StandardSchemaV1<unknown, T>) => BuilderSchema<T[]>;
/** An object with arbitrary keys whose values all match `inner`. */
export declare const record: <T>(inner: StandardSchemaV1<unknown, T>) => BuilderSchema<Record<string, T>>;
/**
 * Normalises a vendor schema into an inference boundary, for use with
 * `createServerFunction`.
 *
 * **It validates nothing and converts nothing** — the same object comes back,
 * and every decision about what counts as valid still belongs to the library.
 * What it changes is where TypeScript does the work.
 *
 * `createServerFunction` infers a handler's parameter and a client stub's
 * argument with `InferOutput<TSchema>` / `InferInput<TSchema>`, which are
 * *structural* matches against the schema's own type. For a heavy vendor type
 * that graph can exceed the instantiation budget an older compiler allows, and
 * the call fails with TS2589 — "Type instantiation is excessively deep and
 * possibly infinite" — on code that is perfectly correct and that a newer
 * compiler accepts. Measured with arktype's `.narrow()`, whose morph-bearing
 * `Type` is the worst case found:
 *
 * ```ts
 * const s = schema.from(type("string <= 64").narrow(nonEmpty));
 * createServerFunction("f", handler, { schema: s }); // TS 5.9: clean
 * createServerFunction("f", handler, { schema: narrow }); // TS 5.9: TS2589
 * ```
 *
 * The budget is per inference site, so this splits one expensive inference into
 * two cheap ones: the deep match happens here, and `createServerFunction` only
 * ever sees the small `StandardSchemaV1<I, O>`. It is also why doing the same
 * narrowing *inside* `createServerFunction` cannot help — that inference happens
 * at the call site, before the body runs.
 *
 * It is a boundary, not a guarantee: a pathological type could still exhaust
 * the budget *here*. For that case annotate explicitly instead —
 * `const s: StandardSchemaV1<string, string> = narrow` — which costs nothing at
 * runtime and pins the types.
 *
 * Use it for any vendor schema; you do not need it for rpc's own builder, whose
 * types are already small.
 * @param vendor - Any Standard Schema — zod, valibot, arktype, effect, or ours
 * @returns The same object, typed as the plain spec interface
 */
declare const from: <I, O>(vendor: StandardSchemaV1<I, O>) => StandardSchemaV1<I, O>;
/**
 * Build a schema from rpc's own primitives, or normalise a vendor one with
 * `schema.from(...)`.
 *
 * ```ts
 * // no dependency
 * schema({ email: field.string(), name: optional(field.string()) })
 *
 * // any Standard Schema, across an inference boundary
 * schema.from(z.object({ email: z.string() }))
 * ```
 * @param shape - The field map
 * @param opts - Schema-wide options
 * @returns A Standard Schema whose output type is the inferred shape
 */
export declare const schema: (<S extends Record<string, StandardSchemaV1<unknown, unknown>>>(shape: S, opts?: BuildOptions) => HintedSchema<StandardSchemaV1<unknown, InferShape<S>>>) & {
  /**
   * Normalise a vendor schema across an inference boundary. See the
   * documentation on this function — it is transparent, and exists purely so
   * TypeScript does not have to walk a heavy vendor type at the
   * `createServerFunction` call.
   */
  from: typeof from;
};
/** Options for {@link runValidation}. */
export interface RunValidationOptions {
  /** Per-path hints, merged over any the schema itself carries. */
  hints?: Record<string, string>;
  /** Vendor-specific parameters forwarded to the validator's `validate`. */
  libraryOptions?: Record<string, unknown>;
  /**
   * Hints about a field's *value*, grouped by that field's key and keyed
   * relative to the value. Supplied here for validators from other libraries,
   * which cannot carry hints on the schema itself.
   */
  valueHints?: Record<string, Record<string, string>>;
  /** A function-wide hint appended to the error. */
  hint?: string;
}
/**
 * Runs a Standard Schema and converts the result into either a validated value
 * or a {@link ValidationError} to throw.
 *
 * Hints resolve per issue path: an exact match first, then the path's leaf name.
 * That ordering lets a single `hints: { email: "..." }` cover both a top-level
 * `email` and a nested `profile.email`, and lets a hint written for a field inside
 * an array apply to every index.
 * @param schema - The schema to validate against
 * @param value - The untrusted input
 * @param options - Per-path hints and a function-wide hint
 * @returns The validated value, or a `ValidationError` to throw
 */
export declare const runValidation: <Input, Output>(schema: StandardSchemaV1<Input, Output>, value: unknown, options?: RunValidationOptions) => Promise<{
  ok: true;
  value: Output;
} | {
  ok: false;
  error: ValidationError;
}>;
//#endregion
//#region src/execution-log.d.ts
/**
 * Describes a value's **shape** without revealing it.
 *
 * Args cross this boundary on every dispatch and routinely contain passwords,
 * API keys and personal data, so the default is to record only what kind of
 * thing arrived — enough to answer "was this an object or a bare string?" and
 * "which fields were present?", which is what a mismatch actually looks like.
 *
 * Bounded in depth and key count, and cycle-safe: a caller cannot make this
 * allocate without bound.
 */
export declare const argShape: (value: unknown, depth?: number, seen?: WeakSet<object>) => string;
/** Describes the argument list of a dispatch. */
export declare const argsShape: (args: readonly unknown[]) => string;
/**
 * Describes a caught error for a record, under the caller's redaction policy.
 *
 * `includeMessages` and `includeStacks` are the two switches that decide
 * whether the record can quote the failure or only classify it.
 */
export declare const describeError: (err: unknown, opts?: {
  includeMessages?: boolean;
  includeStacks?: boolean;
}) => DispatchErrorRecord;
/**
 * Mints a correlation id. `crypto.randomUUID` is global from Node 19 and in
 * every edge runtime; it is truncated to 16 hex characters because the id goes
 * in a header and a log line, not in something a human has to read.
 */
export declare const newDispatchId: () => string;
/** Derives the outcome from a status, so the two cannot disagree. */
export declare const outcomeForStatus: (status: number) => DispatchOutcome;
/**
 * Builds the emitter an adapter calls at the end of a dispatch.
 *
 * With no `onDispatch` this returns `undefined` and the adapter skips the whole
 * thing — which is also why the correlation id appears on failure responses
 * *only* when a hook is registered: with nobody collecting, a new field in the
 * error body would be a change to the wire contract for no benefit.
 *
 * A throwing hook is swallowed. A logging facility that takes down the request
 * it is describing would be a strictly worse system than one that loses a
 * record.
 */
export declare const createDispatcher: (onDispatch?: OnDispatch) => EmitDispatch | undefined;
/** The mutable accumulator an adapter body writes into during a dispatch. */
export interface SeenDispatch {
  status: number;
  error?: unknown;
  functionName?: string;
  registered?: readonly string[];
  declaredMethod?: string;
  declaredContentType?: string;
  actualContentType?: string;
  contentTypeMatched?: boolean;
  args?: readonly unknown[];
  originTier: OriginTier$1;
}
/** How an adapter wraps its dispatch body to emit one record. */
export interface DispatchWrapOptions<T> {
  /** The emitter, or `undefined` when no hook is registered. */
  emit: EmitDispatch | undefined;
  /** The resolved prefix this middleware dispatches under. */
  prefix: string;
  /**
   * The request method. Supplied rather than read centrally because each adapter
   * spells it differently — `event.req.method`, `ctx.method`, `c.req.method` —
   * and a record that says `method: ""` is worse than no record.
   */
  method: () => string;
  /**
   * Reads the status the dispatch settled on. Adapters differ here — hono puts
   * it on the returned `Response`, koa on `ctx.status`, fastify on
   * `reply.statusCode` — which is why it is passed in rather than read centrally.
   *
   * It receives the result because that is where the status most reliably is:
   * hono's `c.json(body, 404)` returns a `Response` without setting `c.res`
   * inside the handler, so reading the context there would report 200 for every
   * failure.
   */
  readStatus: (result: T) => number;
  /**
   * Rewrites a failure result to carry the correlation id. Only called for a
   * `4xx`/`5xx`, and only when a hook is registered.
   *
   * Defaults to merging the id into a plain object, which is what every adapter
   * needs and none of them should be repeating: an adapter-specific copy of this
   * predicate is a copy nobody reads.
   *
   * May be async: hono returns a `Response`, whose body can only be read to be
   * rewritten, so its adapter has to clone and re-serialise.
   */
  withId?: (result: T, id: string) => T | Promise<T>;
  /**
   * Called with the correlation id **before** the body runs, for adapters that
   * have to know the id before the response is written — fastify sends through
   * `reply.send()`, so the body is already gone by the time `withId` would run.
   */
  onStart?: (id: string) => void;
  /** The dispatch body, unchanged, writing what it learns into `seen`. */
  run: (seen: SeenDispatch) => Promise<T> | T;
}
/**
 * Wraps an adapter's dispatch body so every exit path is observed.
 *
 * The reason this is a helper rather than a pattern copied four times: the four
 * adapters report through three different mechanisms, and a rule duplicated
 * across them is a rule that agrees with itself until someone edits one. The
 * facts are supplied, the record is assembled in one place, and an adapter only
 * has to say how to read its own status.
 *
 * With no `emit` this is close to a pass-through, which is what keeps the
 * correlation id — and the whole feature — off the default path.
 */
export declare const dispatchRequest: <T>({ emit, prefix, method, readStatus, withId, onStart, run }: DispatchWrapOptions<T>) => Promise<T>;
/**
 * Merges the correlation id into a `Response` body.
 *
 * Only hono needs this: it returns a `Response` rather than writing the body
 * anywhere the adapter owns, so by the time the id is known the body is already
 * serialised. Extracted here so the rules — never read a body twice, never
 * re-serialise a non-JSON or non-object one — are asserted once instead of
 * living inside an adapter closure.
 */
export declare const tagResponseId: <T>(result: T, id: string) => Promise<T>;
/**
 * The status a `Response`-returning dispatch settled on.
 *
 * hono is the only adapter that needs this — it returns a `Response` rather than
 * writing the body anywhere the adapter owns — and the fallback covers the one
 * path that returns nothing at all: the prefix gate, which the outer
 * `createMiddleware` has already rejected by the time it is reached.
 */
export declare const responseStatus: (result: unknown) => number;
/**
 * Merges the correlation id into a failure **body** an adapter owns — koa's
 * `ctx.body` and fastify's `reply.send()` argument, neither of which comes back
 * as the handler's return value.
 *
 * Arrays and scalars are returned untouched: `{ ...[1, 2] }` is
 * `{ 0: 1, 1: 2 }`, so spreading one would replace a JSON array failure body
 * with an object wearing its indices. Every adapter's failure body is a plain
 * object today, so the guard is there for the day one is not.
 */
export declare const tagBodyId: <T>(body: T, id: string) => T;
//#endregion
//#region src/form-flash.d.ts
/**
 * @module The flash codec, in a form both a server and a browser can import.
 *
 * A no-JS form fallback has to be readable in **two** places: the server, which
 * renders the page after the Post/Redirect/Get, and the client, which rehydrates
 * the form and refills it. So the codec cannot live behind a server-only entry
 * point — the sibling `form-fallback.ts` is server-only because it pulls in
 * `bodyKind` and `isRPCError`, which are, and this module does not.
 *
 * The split is by dependency rather than by convenience: everything here is pure
 * and touches nothing but `JSON`. Import it from `@thednp/rpc/flash` on either
 * side of the wire.
 */
/**
 * The outcome of a native form submission, as it travels in the redirect URL.
 */
interface FormFlash {
  /**
   * Field-level messages, keyed by rendered path (`email`, `address.city`), so
   * the re-rendered form can mark each input without re-deriving anything.
   */
  readonly errors?: Record<string, string[]>;
  /**
   * Submitted values to replay back into the form, so a rejected submission does
   * not clear what the user typed.
   *
   * Only ever what the author explicitly allowed — see `pickReplayable` in
   * `@thednp/rpc/server`. A password is a secret with a lifetime, and a redirect
   * URL is not a place to put one: it reaches browser history, the `Referer` of
   * the next navigation, and every access log in between.
   */
  readonly values?: Record<string, unknown>;
  /**
   * A general, author-written message. Taken from an `RPCError`'s `hint` when it
   * has one, because a hint is written knowing it will be read.
   */
  readonly message?: string;
}
/**
 * The query parameter the flash rides in.
 *
 * Double-underscored so it cannot collide with a field the author submitted.
 */
export declare const FLASH_PARAM = "__flash";
/**
 * The largest serialized flash rpc will put in a URL: 4 KiB.
 *
 * A bound on size, not on confidentiality — the confidentiality rule is
 * structural, in `pickReplayable`. Past this the flash is dropped rather than
 * truncated, so the redirect still happens and the form re-renders empty instead
 * of the user receiving a URL nothing will tolerate.
 *
 * 4 KiB rather than 8 because the flash URL is then **requested by the browser**,
 * so it lands in a request line. nginx's default `large_client_header_buffers 4 8k`
 * requires the request line to fit in a single 8 KiB buffer, so a flash at 8 KiB
 * plus a base path and query exceeds it and the user gets a `414` instead of
 * their form. Half that leaves headroom under the common proxy ceiling.
 *
 * The realistic case is far smaller — a message and a few field paths is a few
 * hundred bytes, and twenty fields with generous hints is around 2 KiB — so this
 * costs nothing in practice.
 */
export declare const FLASH_LIMIT = 4096;
/**
 * Serialises a flash for the query string.
 *
 * @param flash - The flash to serialise
 * @returns The JSON payload, or `null` when it exceeds {@link FLASH_LIMIT}
 */
export declare const encodeFormFlash: (flash: FormFlash) => string | null;
/**
 * Parses a flash back out of a query string, for SSR to replay it and for the
 * client to rehydrate from.
 *
 * Total by design: anything unparseable is `null` rather than a throw, because
 * this runs during a page render and a malformed query parameter is not a good
 * reason a page fails to render. A parsed object is also checked for the flash's
 * container shapes before it is trusted as a `FormFlash`.
 *
 * That check is structural, not a substitute for treating URL input as untrusted:
 * callers must still whitelist the fields they render and escape the strings
 * they emit.
 *
 * @param raw - The raw parameter value, or `undefined` when absent
 * @returns The flash, or `null` when absent, malformed, or structurally invalid
 */
export declare const decodeFormFlash: (raw: string | null | undefined) => FormFlash | null;
//#endregion
//#region src/form-fallback.d.ts
/**
 * The subset of a request the navigation test needs.
 *
 * Structural rather than a framework type, so an Express `req`, a Hono context,
 * a Web `Request` and any other host's shape all satisfy it by passing the five
 * fields.
 */
export interface FormNavigationRequest {
  /** HTTP method. Compared case-insensitively. */
  readonly method?: string | undefined;
  /** Raw `Content-Type` request header, if present. */
  readonly contentType?: string | undefined;
  /** Raw `Accept` request header, if present. */
  readonly accept?: string | undefined;
  /**
   * Raw `Sec-Fetch-Dest`, when the client sends fetch metadata.
   *
   * Optional because not every client sends it — `curl` does not, and neither
   * does a browser predating fetch metadata. Where it *is* present it is a much
   * better navigation signal than `Accept` alone.
   */
  readonly secFetchDest?: string | undefined;
  /** Raw `Sec-Fetch-Mode`, when the client sends fetch metadata. */
  readonly secFetchMode?: string | undefined;
}
/**
 * Whether a request is a native form submission rather than an RPC call.
 *
 * **The discriminator is the navigation, not the content type.** A form-declared
 * function is called by two different clients that both send a form content
 * type: a native `<form>` posts `application/x-www-form-urlencoded`, and the
 * generated client stub posts `multipart/form-data` via `fetch`. Keying on
 * content type alone cannot tell them apart, and a fallback that did would hand
 * every browser-side caller a `303` where it expected a rejection — breaking
 * `data` promise rejection, `fieldErrors`, and the stub's error handling for any
 * form-declared function.
 *
 * So the rule is: `POST`, plus a form content type — which keeps an
 * `Accept: text/html` fetch out of the form path — and then, where fetch
 * metadata is present, `Sec-Fetch-Dest`/`Sec-Fetch-Mode` decide: a navigation is
 * a document request and a `fetch` is not, whatever `Accept` claims. Only when
 * both metadata headers are absent does `Accept` decide, by requiring
 * `text/html`. A browser navigation sends `text/html`; `fetch` does not by
 * default, and its wildcard `Accept` is not enough.
 *
 * Unlike the reference implementation in `bart-js`, `multipart/form-data` *is*
 * accepted here, because a native `<form enctype="multipart/form-data">` is a
 * real navigation and the file-upload case is the reason that content type
 * exists. The navigation gate is what keeps `fetch` out, and it does not depend
 * on which form encoding arrived.
 *
 * @param request - Method, raw content-type/accept headers, and optional fetch-metadata headers
 * @returns `true` when this is a native form submission
 */
export declare const isNativeFormNavigation: (request: FormNavigationRequest) => boolean;
/**
 * Makes a redirect target safe to send a browser to.
 *
 * Post/Redirect/Get needs somewhere to go, and the two obvious sources are both
 * attacker-influenceable: a hidden `__redirect` field, which whoever renders the
 * form chooses, and the `Referer` header, which is stripped from native form
 * POSTs often enough that projects reach for it anyway. Redirecting to either
 * unchecked is an open redirect — `//evil.test` and `javascript:` being the
 * payloads that matter.
 *
 * The policy is an **allowlist of shape**, not a denylist of schemes: a target
 * must be an absolute, root-relative path, which rejects `javascript:`,
 * `data:`, `vbscript:`, protocol-relative `//host` and absolute `http://host` in
 * one step. Denylists lose to obfuscation (`java&#9;script:`) more often than an
 * allowlist loses to a missing case, so the scheme is never parsed as a scheme.
 * The origin check afterwards is then belt-and-braces rather than the defence.
 *
 * The fragment is preserved — it never reaches the server, and dropping it loses
 * the scroll position the author was aiming at. The query is preserved because it
 * is where a flash payload rides.
 *
 * @param target - The raw redirect target, from wherever the caller obtained it
 * @param base - The absolute URL of the current request, used to resolve and to
 *   compare origins
 * @returns A same-origin path, or `/` when the target cannot be trusted
 */
export declare const sanitizeRedirect: (target: string | null | undefined, base: string) => string;
/**
 * The outcome of a native form submission, as carried in the redirect URL.
 *
 * **This is the contract, and rpc owns it.** The outcome is not a new return
 * type: it is derived from what already happened, which is what keeps the whole
 * feature from touching the library's most load-bearing typing.
 *
 * | what the handler did | outcome |
 * | --- | --- |
 * | returned normally | success; the declared redirect target, no flash |
 * | threw an `RPCError` (or a typed subclass) | failure; `message` from its `hint`, `errors` from `ValidationError.issues` |
 * | threw anything else | **not a flash** — a genuine `500`, because an unexpected error must not be laundered into a friendly redirect, and must not put its message in a URL |
 *
 * Reusing the error model rather than introducing a parallel result union is the
 * whole reason this composes with what already ships: `schema` failures,
 * `NotFoundError`, and hand-thrown `RPCError`s all already carry the two things a
 * form needs — author-written advice and per-field issues.
 */
/**
 * A {@link FormFallbackOptions} reduced to one shape, so the dispatch reads one
 * thing instead of re-deriving sugar at request time.
 */
export interface ResolvedFallback {
  readonly to: string | ((outcome: FormFallbackOutcome) => string);
  /**
   * Always present, and empty unless the author named fields — the default is
   * replay nothing.
   */
  readonly replay: readonly string[];
}
/**
 * Normalises the authored `fallback` option: `undefined` stays `undefined`, a
 * bare string is shorthand for "this path, replay nothing", and an object is
 * taken apart.
 *
 * The `replay` array is **copied and frozen**. It is consulted at dispatch time,
 * on every request, from the author's object — so without the copy a caller that
 * pushed to the array after registration would silently change the replay policy
 * of a function that is already serving traffic. Freezing the copy also makes an
 * accidental later write fail loudly instead of being ignored.
 */
export declare function resolveFallback(fallback: string | FormFallbackOptions | undefined): ResolvedFallback | undefined;
/**
 * Reduces a thrown value to a flash, or `null` when it must not become one.
 *
 * `null` for anything that is not an `RPCError`, and that is the important case:
 * an unexpected exception is a server fault and stays a `500`. Flashifying one
 * would both hide it and write its message into a URL, which is the opposite of
 * what an author wants when something genuinely broke.
 *
 * Cross-bundle safe: the test is {@link isRPCError}'s registered-symbol brand,
 * not `instanceof`, because each tsdown entry carries its own copy of the class.
 *
 * @param err - The value the handler threw
 * @returns A flash, or `null` when the value must not be redirected past
 */
export declare const flashFromError: (err: unknown) => FormFlash | null;
/**
 * Selects the submitted fields that may be replayed into the redirect URL.
 *
 * An explicit allowlist, defaulting to nothing. "Replay everything except the
 * obvious secrets" is not implementable — rpc cannot know which of your fields
 * are tokens, and a field named `note` is as likely to be one as a field named
 * `password`. Naming the fields is a sentence the author has to write, which is
 * the point.
 *
 * @param fields - The submitted fields
 * @param allowed - Field names permitted in the redirect URL; empty means none
 * @returns Only the permitted fields, and only ones that are primitive
 */
export declare const pickReplayable: (fields: unknown, allowed?: readonly string[]) => Record<string, unknown>;
/**
 * Builds the Post/Redirect/Get target for a failed native form submission.
 *
 * The target is sanitized, so a caller that passes a field-controlled value
 * cannot turn this into an open redirect. A flash that will not fit is dropped
 * rather than truncated — see {@link FLASH_LIMIT}.
 *
 * @param target - Where to send the browser; treated as untrusted
 * @param flash - The outcome to carry, or `null` to redirect without one
 * @param base - Absolute resolution base, defaulting to the inert localhost origin. A request URL is not needed because the emitted target is same-origin `pathname + search`.
 * @returns A same-origin URL, safe to put in a `Location` header
 */
export declare const flashRedirectUrl: (target: string, flash: FormFlash | null, base: string) => string;
/**
 * The `Location` for a native form submission that **failed**, or `undefined`
 * when this request is not one.
 *
 * `undefined` is the important return, and it covers four distinct reasons, each
 * of which must fall through to the adapter's normal handling rather than being
 * redirected:
 *
 * - the function has no `fallback` configured — the feature is opt-in;
 * - the request is not a native form navigation — including every `fetch` from
 *   the generated stub, which must keep getting its JSON;
 * - the error is not client-facing, so it is a genuine fault and stays a `500`.
 *   A stack trace must never be laundered into a friendly redirect;
 * - the author's `to` threw or returned a non-string.
 *
 * A target that is merely *unsafe* is not in this list: it still redirects, to
 * the sanitiser's same-origin fallback. See {@link redirectFor}.
 *
 * Adapters call this **ahead of** their client-error branch. That is the whole
 * point of it living here rather than at the validation call site: a
 * `ValidationError` is a *client-facing* error, so the branch that renders it as
 * a `422` JSON body would otherwise claim it first, and a rejected submission —
 * the case the entire feature exists for — would reach the browser as raw JSON.
 */
export declare const formFallbackLocation: (err: unknown, fallback: string | FormFallbackOptions | undefined, submitted: unknown, request: FormNavigationRequest, base?: string) => string | undefined;
/**
 * The `Location` for a native form submission that **succeeded**, or
 * `undefined` when this request is not one.
 *
 * Success carries no flash — there is no failure to report — so the redirect is
 * just the author's target. `replay` still applies, because an author who wants
 * to show what was submitted ("we emailed bob@example.com") can name it, and
 * naming is the whole consent mechanism.
 */
export declare const formSuccessLocation: (fallback: string | FormFallbackOptions | undefined, submitted: unknown, request: FormNavigationRequest, base?: string) => string | undefined;
//#endregion
export { type FormFlash, type InferInput, type InferOutput, type InferShape, OriginTier$1 as OriginTier, type StandardSchemaIssue, type StandardSchemaResult, type StandardSchemaV1, type ValidationIssue };
//# sourceMappingURL=server.d.mts.map