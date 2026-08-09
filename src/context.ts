/** @module Server-side request context. Exports the `RequestEvent` shape, `provideRequestContext` to establish it around a dispatch, `getRequestContext` to read it from anywhere inside the async tree, and `redirect` for framework-level redirects. Never import this module in client code — it is server-only. */

// @thednp/rpc/src/context.ts
import { AsyncLocalStorage } from "node:async_hooks";

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
