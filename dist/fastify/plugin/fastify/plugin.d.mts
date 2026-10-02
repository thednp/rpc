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
//#region src/fastify/plugin.d.ts
declare const rpcPlugin: RegisteredFastifyRPCPlugin;
//#endregion
export { type MiddlewareOptions, rpcPlugin as default };
//# sourceMappingURL=plugin.d.mts.map