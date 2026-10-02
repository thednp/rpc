import { EventHandler as H3Next, H3, H3 as H3$1, H3Event, H3Event as H3Event$1, H3Event as H3Request, H3Response, HTTPResponse, Middleware, Middleware as H3Middleware } from "h3";
import { AdapterName, BodyResult, MiddlewareOptions } from "@thednp/rpc";
import { IncomingHttpHeaders } from "node:http";
import { ViteDevServer } from "vite";
import "express";
import "hono";
import "@hono/node-server";
import "hono/utils/http-status";
import "hono/factory";
import "fastify";
import "fastify-plugin";
import "koa";
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
  sendResponse: (code: number, output: JsonValue) => void;
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
type H3MiddlewareFn = <A extends AdapterName = "h3">(initialOptions?: Partial<H3MiddlewareOptions>) => H3MiddlewareHooks["handler"];
/**
 * h3 application reference used by helpers that attach middleware to an app.
 */
type H3App = H3$1;
/**
 * h3 event extended with an optional pre-parsed body.
 */
type H3EventWithBody = H3Event$1 & {
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
export declare const createMiddleware: H3MiddlewareFn;
/**
 * Creates the h3 RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns An h3 middleware function
 */
export declare const createRPCMiddleware: H3MiddlewareFn;
//#endregion
//#region src/h3/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to an h3 app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - h3 application instance
 */
export declare function attachRPC(app: H3App): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to an h3 app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into h3.
 * @param app - h3 application instance
 * @param vite - Running Vite dev server
 */
export declare const attachVite: (app: H3App, vite: ViteDevServer) => void;
/**
 * Creates an h3-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to h3's event-based request/response model.
 * Supports both Node.js and web runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns An h3 middleware function
 */
export declare const viteMiddleware: (vite: ViteDevServer) => Middleware;
/**
 * Reads and parses the HTTP request body from an h3 event.
 * Supports JSON, text, urlencoded, and multipart content types.
 * @param event - h3 event object
 * @returns A promise resolving to the parsed body with its content type
 */
export declare const readBody: (event: H3Event$1, limit?: number) => Promise<BodyResult>;
/**
 * Issues an HTTP redirect. h3's `redirect()` returns an `HTTPResponse`
 * object that the handler must return (it never writes directly). Defaults
 * to `303 See Other` for convention (Post/Redirect/Get).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 * @returns An h3 `HTTPResponse` to return from the handler
 */
export declare const redirect: (location: string, status?: number) => HTTPResponse;
//#endregion
export type { H3, H3App, H3Event, H3EventWithBody, H3Middleware, H3MiddlewareFn, H3MiddlewareHooks, H3MiddlewareOptions, H3Next, H3Request, H3Response, RequestDetails, ResponseDetails };
//# sourceMappingURL=h3.d.mts.map