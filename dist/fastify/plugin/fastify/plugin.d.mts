import fp from "fastify-plugin";
import { Connect } from "vite";
import "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { NextFunction, Request, Response as Response$1 } from "express";
import { MiddlewareHandler } from "hono";
import "@hono/node-server";
import "hono/utils/http-status";
import "hono/factory";
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
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
 * `fastify-plugin` function type, used to type the wrapped export.
 */
type FastifyPlugin = typeof fp;
/**
 * Return type of `fastify-plugin` wrapping, matching the final plugin export.
 */
type RegisteredFastifyRPCPlugin = ReturnType<FastifyPlugin>;
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
   * @default string
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix?: string;
  /**
   * Allowed request origin(s) — a single origin string or an allowlist of them
   * (e.g. `"https://example.com"` or
   * `["https://example.com", "https://admin.example.com"]`).
   *
   * Setting this option is the opt-in for origin validation. When set, a request
   * is rejected with `403 Forbidden` according to four tiers:
   *
   * 1. `Origin` present → the allowlist decides. It must match one of the
   *    entries exactly; `Origin: null` (sandboxed iframes, `file://`, browser
   *    extensions) never equals a real origin, so it is rejected.
   * 2. `Origin` absent but `Sec-Fetch-Site` present → allow only `same-origin`
   *    and `none`. Anything else, including an unrecognised value, is rejected.
   *    Browsers never strip `Origin` themselves, so reaching this tier means
   *    something in the chain (a proxy, a sanitising middleware, a CDN) removed
   *    it — at which point the check fails closed rather than silently becoming
   *    a no-op.
   * 3. Both headers absent → the request passes. This is the deliberate
   *    curl/native-client hole: non-browser clients send neither header.
   *
   * When unset (default), no origin validation is performed at all.
   *
   * @see `isOriginRequestAllowed` in `@thednp/rpc/server` for the exact rule.
   */
  origin?: string | string[];
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
//#region src/fastify/plugin.d.ts
declare const rpcPlugin: RegisteredFastifyRPCPlugin;
//#endregion
export { type MiddlewareOptions, rpcPlugin as default };
//# sourceMappingURL=plugin.d.mts.map