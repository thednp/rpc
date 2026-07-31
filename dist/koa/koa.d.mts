import Koa, { Context, Next } from "koa";
import { BodyResult, JsonValue, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
//#region src/koa/types.d.ts
/**
 * Koa-specific middleware options, constrained to the `"koa"` adapter.
 */
type KoaMiddlewareOptions = MiddlewareOptions<"koa">;
/**
 * Koa context extended with an optional parsed request body.
 */
interface KoaContext extends Context {
  /** Koa request with an optional parsed JSON/plain-text body */
  request: Context["request"] & {
    body?: string | JsonValue;
  };
}
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
type KoaMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "koa">(initialOptions?: Partial<KoaMiddlewareOptions>) => KoaMiddlewareHooks["handler"];
//#endregion
//#region src/koa/createMiddleware.d.ts
/**
 * Creates a Koa middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * Koa URL is normalized via `new URL()` to strip query strings before matching.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Koa middleware function
 */
declare const createMiddleware: KoaMiddlewareFn;
/**
 * Creates the Koa RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sets the JSON-serialized result on ctx.body.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Koa middleware function
 */
declare const createRPCMiddleware: KoaMiddlewareFn;
//#endregion
//#region src/koa/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to a Koa app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Koa application instance
 */
declare function attachRPC(app: Koa): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to a Koa app for development mode.
 * Bridges Koa's context-based middleware to Vite's Connect-compatible middleware stack
 * by forwarding Koa body, wrapping res.end, and delegating back to Koa on 404 or unhandled routes.
 * @param app - Koa application instance
 * @param vite - Running Vite dev server
 */
declare function attachVite(app: Koa, vite: ViteDevServer): void;
/**
 * Reads and parses the HTTP request body from a Koa context.
 * If koa-body or another body parser already consumed the stream,
 * uses the pre-parsed body from `ctx.request.body`.
 * @param ctx - Koa context
 * @returns A promise resolving to the parsed body with its content type
 */
declare const readBody: (ctx: KoaContext) => Promise<BodyResult>;
//#endregion
export { type Koa, type KoaContext, type KoaMiddlewareFn, type KoaMiddlewareHooks, type KoaMiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };
//# sourceMappingURL=koa.d.mts.map