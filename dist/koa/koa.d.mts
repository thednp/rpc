import Koa, { Context, Context as KoaRequest, Next, Next as KoaNext } from "koa";
import { BodyResult, JsonValue, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { IncomingHttpHeaders, ServerResponse as KoaResponse } from "node:http";
import { ViteDevServer } from "vite";
import "express";
import "hono";
import "@hono/node-server";
import "hono/utils/http-status";
import "hono/factory";
import "fastify";
import "fastify-plugin";
import "h3";
//#region src/types.d.ts
// primitives and their compositions
/**
 * Primitive JSON values, including `undefined` for optional parameters.
 */
type JsonPrimitive = string | number | boolean | null | undefined;
/**
 * A JSON object whose values are JSON values or arrays.
 */
type JsonObject = {
  [key: string]: JsonValue$1 | JsonArray;
};
/**
 * A JSON array of JSON values.
 */
type JsonArray = (FormData | JsonValue$1)[];
/**
 * Any JSON-serializable value: primitive, array, or object.
 */
type JsonValue$1 = JsonPrimitive | JsonArray | JsonObject;
//#endregion
//#region src/adapter-types.d.ts
/**
 * Wraps a server response to normalize status, header, and send operations
 * across Node `ServerResponse` and framework response objects.
 *
 * Re-exported from every adapter (`@thednp/rpc/express`, `/fastify`, `/hono`,
 * `/koa`, `/h3`) so a consumer can name the shape without importing from the
 * express adapter specifically.
 */
type ResponseDetails = {
  /** Whether the response was already sent */
  isResponseSent: boolean;
  /** Sets a response header */
  setHeader: (name: string, value: string) => void;
  /** Current response status code */
  statusCode: number;
  /** Sets the response status code */
  setStatusCode: (code: number) => void;
  /** Sends a JSON response with the given status code and output */
  sendResponse: (code: number, output: JsonValue$1) => void;
};
/**
 * Normalized view of an incoming request: URL parts, headers, and method.
 *
 * Re-exported from every adapter, for the same reason as {@link ResponseDetails}.
 */
type RequestDetails = {
  /** Full request URL (path + query string) */
  url: string;
  /** Query string including the leading `?` */
  search: string;
  /** Parsed query string parameters */
  searchParams: URLSearchParams;
  /** Raw request headers */
  headers: IncomingHttpHeaders;
  /** HTTP method (GET, POST, etc.) */
  method: string | undefined;
};
//#endregion
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
export declare const createMiddleware: KoaMiddlewareFn;
/**
 * Creates the Koa RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sets the JSON-serialized result on ctx.body.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Koa middleware function
 */
export declare const createRPCMiddleware: KoaMiddlewareFn;
//#endregion
//#region src/koa/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to a Koa app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Koa application instance
 */
export declare function attachRPC(app: Koa): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to a Koa app for development mode.
 * Bridges Koa's context-based middleware to Vite's Connect-compatible middleware stack
 * by forwarding Koa body, wrapping res.end, and delegating back to Koa on 404 or unhandled routes.
 * @param app - Koa application instance
 * @param vite - Running Vite dev server
 */
export declare function attachVite(app: Koa, vite: ViteDevServer): void;
/**
 * Reads and parses the HTTP request body from a Koa context.
 * If koa-body or another body parser already consumed the stream,
 * uses the pre-parsed body from `ctx.request.body`.
 * @param ctx - Koa context
 * @returns A promise resolving to the parsed body with its content type
 */
export declare const readBody: (ctx: KoaContext) => Promise<BodyResult>;
/**
 * Issues an HTTP redirect on a Koa context. Koa's `ctx.redirect(location)`
 * defaults to `302` and sets the `Location` header; the status code must be
 * overridden *after* the call (setting it before is ignored, see
 * koajs/koa#857). Defaults to `303 See Other` for convention
 * (Post/Redirect/Get).
 * @param ctx - Koa context
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 */
export declare const redirect: (ctx: KoaContext, location: string, status?: number) => void;
//#endregion
export type { Koa, Koa as KoaApp, KoaContext, KoaMiddlewareFn, KoaMiddlewareHooks, KoaMiddlewareOptions, KoaNext, KoaRequest, KoaResponse, RequestDetails, ResponseDetails };
//# sourceMappingURL=koa.d.mts.map