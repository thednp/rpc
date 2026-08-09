import { H3, H3Event, HTTPResponse, Middleware } from "h3";
import { BodyResult, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
//#region src/h3/types.d.ts
/**
 * h3-specific middleware options, constrained to the `"h3"` adapter.
 */
type H3MiddlewareOptions = MiddlewareOptions<"h3">;
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
type H3MiddlewareFn = <A extends RpcPluginOptions["adapter"] = "h3">(initialOptions?: Partial<H3MiddlewareOptions>) => H3MiddlewareHooks["handler"];
/**
 * h3 application reference used by helpers that attach middleware to an app.
 */
type H3App = H3;
/**
 * h3 event extended with an optional pre-parsed body.
 */
type H3EventWithBody = H3Event & {
  body?: unknown;
};
//#endregion
//#region src/h3/createMiddleware.d.ts
/**
 * Creates an h3 middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * h3 URL is normalized via `event.url` (query strings are not part of the pathname).
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns An h3 middleware function
 */
declare const createMiddleware: H3MiddlewareFn;
/**
 * Creates the h3 RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns An h3 middleware function
 */
declare const createRPCMiddleware: H3MiddlewareFn;
//#endregion
//#region src/h3/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to an h3 app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - h3 application instance
 */
declare function attachRPC(app: H3App): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to an h3 app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into h3.
 * @param app - h3 application instance
 * @param vite - Running Vite dev server
 */
declare const attachVite: (app: H3App, vite: ViteDevServer) => void;
/**
 * Creates an h3-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to h3's event-based request/response model.
 * Supports both Node.js and web runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns An h3 middleware function
 */
declare const viteMiddleware: (vite: ViteDevServer) => Middleware;
/**
 * Reads and parses the HTTP request body from an h3 event.
 * Supports JSON, text, urlencoded, and multipart content types.
 * @param event - h3 event object
 * @returns A promise resolving to the parsed body with its content type
 */
declare const readBody: (event: H3Event) => Promise<BodyResult>;
/**
 * Issues an HTTP redirect. h3's `redirect()` returns an `HTTPResponse`
 * object that the handler must return (it never writes directly). Defaults
 * to `303 See Other` for convention (Post/Redirect/Get).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 * @returns An h3 `HTTPResponse` to return from the handler
 */
declare const redirect: (location: string, status?: number) => HTTPResponse;
//#endregion
export { type H3App, type H3EventWithBody, type H3MiddlewareFn, type H3MiddlewareHooks, type H3MiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect, viteMiddleware };
//# sourceMappingURL=h3.d.mts.map