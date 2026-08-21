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
   * RPC endpoint prefix
   * @default "__rpc"
   */
  rpcPrefix?: string;
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
type ServerFunctionInit<TArgs extends FormData | JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
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
 * A client function augmented with its registered export name and
 * per-function options (content type, credentials).
 */
type ClientFunctionWithOptions = ClientFunction & {
  /** Registered export name of the server function */
  name: string;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
};
/**
 * Internal plugin options accepted by `getClientModules`.
 */
interface RpcPluginOptionsInternal {
  /** RPC endpoint prefix (e.g. "__rpc") */
  rpcPrefix: string;
  /** Framework adapter name */
  adapter?: string | undefined;
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
   * Option to set an adapter for the middleware connection. The default is _express_,
   * which is the most popular and battle tested server app. The _express_ adapter is
   * also compatible with the vite's Connect development server.
   * @default express
   */
  adapter: "express" | "hono" | "h3" | "fastify" | "koa";
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
}
interface MiddlewareOptions<A extends RpcPluginOptions["adapter"] = "express"> {
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
   * @default string
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix?: string | false;
  /**
   * Allowed request origin (e.g. "https://example.com").
   * When set, any request carrying an `Origin` header that does not match
   * is rejected with a 403 Forbidden response. Requests without an `Origin`
   * header (curl, native clients) pass through unchecked.
   * When unset (default), no origin validation is performed.
   */
  origin?: string;
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
declare const serverFunctionsByPrefix: Map<string, Map<string, ServerFnEntry>>;
/**
 * Gets or creates the function map for a specific prefix.
 * @param prefix - The RPC prefix (e.g., "__rpc", "v1:rpc", "admin:rpc")
 * @returns Map of function names to ServerFnEntry for that prefix
 */
declare const getFunctionsForPrefix: (prefix: string) => Map<string, ServerFnEntry>;
/**
 * Backward compatibility: default map for the default prefix.
 * Legacy code can still use serverFunctionsMap.set(name, entry).
 */
declare const serverFunctionsMap: Map<string, ServerFnEntry>;
//#endregion
//#region src/scanForServerFiles.d.ts
/** Absolute ids (normalized) of the scanned server function files. */
declare const scannedServerFiles: Set<string>;
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
declare const scanForServerFiles: (initialCfg?: ScanConfig, devServer?: ViteDevServer) => Promise<void>;
//#endregion
//#region src/createFunction.d.ts
/**
 * Extended options for createServerFunction, including rpcPrefix for multi-instance support.
 */
interface CreateServerFunctionOptions extends Partial<ServerFunctionOptions> {
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
declare function createServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue>(name: string, handler: ServerFunctionInit<TArgs, TResult>, fnOptions?: CreateServerFunctionOptions): ClientFunction<TArgs, TResult>;
//#endregion
//#region src/getClientModules.d.ts
/**
 * Generates the complete client-side module bundle by iterating all registered server functions
 * for a specific prefix and producing fetch-based stubs for each. The result is transformed by Vite
 * (or Oxc) during the dev server or production build.
 * @param initialOptions - Plugin options containing rpcPrefix and optional adapter
 * @returns A string of JavaScript code with all client RPC modules and their import dependencies
 */
declare const getClientModules: (initialOptions: RpcPluginOptionsInternal) => string;
//#endregion
//#region src/server-helpers.d.ts
/**
 * Recursively walks `dir` and collects absolute paths to files whose
 * basename matches the `*.server.{ts,js,mjs,mts}` glob pattern.
 */
declare const walkGlobFiles: (dir: string) => Promise<string[]>;
/**
 * A typed error thrown from server functions.
 * The middleware serializes the `message` and `code` in the response,
 * allowing clients to recognise and handle specific error conditions.
 */
declare class RPCError extends Error {
  /** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
  code: string;
  /** Optional diagnostic payload */
  data?: JsonValue;
  constructor(message: string, code?: string, data?: JsonValue);
}
/**
 * Formats an error for the RPC middleware response.
 * In development the full `RPCError` payload is included so developers
 * can quickly identify issues. Unexpected exceptions never expose their
 * message — only the generic "Internal Server Error" is sent, preventing
 * information disclosure; server-side diagnostics are preserved via the
 * middleware's `console.error` logging.
 */
declare const formatError: (err: unknown, isProduction: boolean) => JsonObject;
/**
 * Checks whether a content type maps to a form encoding
 * (`multipart/form-data` or `application/x-www-form-urlencoded`).
 * Form-declared functions accept either encoding so native browser
 * submissions (urlencoded) keep working without JavaScript.
 */
declare const isFormContentType: (contentType: string) => boolean;
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
declare const hasContentTypeMismatch: (declared: ContentType, rawHeader: string | undefined) => boolean;
/**
 * Escapes special regex metacharacters in a string.
 * Used to safely embed user-configurable values (like rpcPrefix) into regular expressions,
 * preventing ReDoS and regex injection attacks.
 * @param s - The raw string to escape
 * @returns The escaped string safe for use in new RegExp()
 */
declare function escapeRegExp(s: string): string;
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
declare const safeURL: (rawUrl: string, base?: string) => URL;
/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
declare const getGlobalPrefix: () => string | undefined;
declare const setGlobalPrefix: (prefix: string | undefined) => void;
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
interface RequestEvent {
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
declare const provideRequestContext: <T>(init: RequestEvent, cb: () => T) => T;
/**
 * Returns the current request context, or throws when called outside of a
 * request (e.g. module scope or a background task).
 * @throws When no request context is established
 */
declare const getRequestContext: () => RequestEvent;
/**
 * Redirects the current request to `location`. Reads the adapter-bound
 * `redirect` from the current request context — callable from anywhere inside
 * a server-function tree (no `res` threading needed).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to `303 See Other`
 * @throws When called outside of a request
 */
declare const redirect: (location: string, status?: number) => void;
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
declare const sendResponse: (status: number, body: JsonValue, headers?: Record<string, string>) => void;
/**
 * Normalized, adapter-agnostic view of the current request. Reads the request
 * object off the current request context and normalizes it across the five
 * adapter request shapes (Express `req`, Fastify `req`, Koa `ctx.req`,
 * Hono `c.req`, h3 `event.req`) so middleware can be written once.
 */
interface RequestMeta {
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
declare const getRequestMeta: (event: RequestEvent) => RequestMeta;
//#endregion
//#region src/options.d.ts
declare const defaultServerFnOptions: ServerFunctionOptions;
declare const defaultPrefix = "__rpc";
declare const defaultRPCOptions: RpcPluginOptions;
declare const defaultMiddlewareOptions: MiddlewareOptions;
//#endregion
export { CreateServerFunctionOptions, RPCError, RequestEvent, RequestMeta, createServerFunction, defaultMiddlewareOptions, defaultPrefix, defaultRPCOptions, defaultServerFnOptions, escapeRegExp, formatError, getClientModules, getFunctionsForPrefix, getGlobalPrefix, getRequestContext, getRequestMeta, hasContentTypeMismatch, isFormContentType, provideRequestContext, redirect, safeURL, scanForServerFiles, scannedServerFiles, sendResponse, serverFunctionsByPrefix, serverFunctionsMap, setGlobalPrefix, walkGlobFiles };
//# sourceMappingURL=server.d.mts.map