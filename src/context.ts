/** @module Server-side request context. Exports the `RequestEvent` shape, `provideRequestContext` to establish it around a dispatch, `getRequestContext` to read it from anywhere inside the async tree, `redirect` and `sendResponse` for framework-level short-circuits, and `getRequestMeta` for normalized request access. Never import this module in client code — it is server-only. */

// @thednp/rpc/src/context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "./types.d.ts";
import { safeURL } from "./server-helpers.ts";

/**
 * Global symbol under which the shared `AsyncLocalStorage` instance is stored
 * on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
 * across module copies and dev-server hot reloads, mirroring
 * `solid-js/web`'s own request-context storage.
 */
const requestContextSymbol = Symbol.for("thednp.rpc.requestContext");

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
  redirected?: { location: string; status: number };
  /**
   * Bound adapter-native response short-circuit. Writes the given status and
   * JSON body (plus optional headers) directly, bypassing the standard
   * `{ data }` response. Setting `sent` makes the middleware skip the JSON
   * `{ data }` send, mirroring `redirect`/`redirected`.
   * @param status - HTTP status code (e.g. 401, 413, 429)
   * @param body - JSON-serializable response body
   * @param headers - Optional response headers (e.g. `{ "Retry-After": "60" }`)
   */
  send: (
    status: number,
    body: JsonValue,
    headers?: Record<string, string>,
  ) => void;
  /**
   * Set by `send` once a response has been issued. The middleware checks this
   * after `await`ing the server function to avoid double-responding.
   */
  sent?: { status: number; body: JsonValue; headers?: Record<string, string> };
  /**
   * The matched RPC function name for the current request, when available.
   * Useful for per-function rate limiting or auditing inside middleware.
   */
  functionName?: string;
  /** Per-request app data shared across the async tree of the dispatch */
  locals: Record<string, unknown>;
  [prop: string]: unknown;
}

// Instance-stable across module copies and dev-server hot reloads, exactly like
// `solid-js/web`'s `provideRequestEvent` (which stores on a globalThis symbol).
const requestContextStorage: AsyncLocalStorage<RequestEvent> =
  ((globalThis as Record<symbol, AsyncLocalStorage<RequestEvent>>)[
    requestContextSymbol
  ] ??= new AsyncLocalStorage<RequestEvent>());

/**
 * Runs `cb` with `init` as the current request context. Use inside the
 * adapters around server-function dispatch (the async tree under `cb` can then
 * read the context via {@link getRequestContext}).
 * @param init - The request context for the duration of `cb`
 * @param cb - The work that needs access to the request context
 */
export const provideRequestContext = <T>(
  init: RequestEvent,
  cb: () => T,
): T => requestContextStorage.run(init, cb);

/**
 * Returns the current request context, or throws when called outside of a
 * request (e.g. module scope or a background task).
 * @throws When no request context is established
 */
export const getRequestContext = (): RequestEvent => {
  const ctx = requestContextStorage.getStore();
  if (!ctx) {
    throw new Error("RequestEvent is not available outside of a request");
  }
  return ctx;
};

/**
 * Redirects the current request to `location`. Reads the adapter-bound
 * `redirect` from the current request context — callable from anywhere inside
 * a server-function tree (no `res` threading needed).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to `303 See Other`
 * @throws When called outside of a request
 */
export const redirect = (location: string, status = 303): void => {
  getRequestContext().redirect(location, status);
};

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
export const sendResponse = (
  status: number,
  body: JsonValue,
  headers?: Record<string, string>,
): void => {
  getRequestContext().send(status, body, headers);
};

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

const pickHeader = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
};

/** Normalizes any headers shape into a plain lower-cased record. */
const toHeaderRecord = (
  headers: unknown,
): Record<string, string | string[] | undefined> => {
  if (!headers) return {};
  // Headers-like object (h3 Request, Hono c.req.raw.headers, fetch Headers)
  if (typeof (headers as Headers).forEach === "function") {
    const record: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  // Plain map (Express req.headers, Fastify req.headers, Koa ctx.req.headers)
  return headers as Record<string, string | string[] | undefined>;
};

/**
 * Reads normalized, adapter-agnostic request metadata from the current request
 * context. Works with Express `req`, Fastify `req`, Koa `ctx.req`,
 * Hono `c.req` and h3 `event.req` by feature-detecting the request shape
 * (`originalUrl`/`url`/`path`, raw `headers` map vs `Headers`-like API).
 * @param event - The request context to read, typically the result of
 *   {@link getRequestContext}
 */
export const getRequestMeta = (event: RequestEvent): RequestMeta => {
  const req = event.request as {
    method?: string;
    originalUrl?: string;
    url?: string;
    path?: string;
    headers?: unknown;
    header?: (name: string) => string | string[] | undefined;
    ip?: string;
    protocol?: string;
    socket?: { remoteAddress?: string };
  } | undefined;

  const method = (req?.method ?? "GET").toUpperCase();
  const rawUrl = req?.originalUrl ?? req?.url ?? req?.path ?? "";
  const url = safeURL(rawUrl);
  const headers = toHeaderRecord(req?.headers);
  const hostHeader = pickHeader(headers, "host");

  return {
    method,
    pathname: url.pathname,
    search: url.search,
    searchParams: url.searchParams,
    headers,
    host: hostHeader,
    ip: req?.ip ?? req?.socket?.remoteAddress,
    protocol: req?.protocol ?? url.protocol.replace(":", ""),
  };
};
