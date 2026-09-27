import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { Context, Context as HonoContext, Hono, Hono as Hono$1, Hono as HonoApp, HonoRequest, MiddlewareHandler, MiddlewareHandler as HonoMiddlewareHandler, Next as HonoNext, Response as HonoResponse } from "hono";
import { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { AdapterName, BodyResult, MiddlewareOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
import "express";
import "fastify";
import "fastify-plugin";
import "koa";
import "h3";
import { HttpBindings } from "@hono/node-server";
import { RedirectStatusCode } from "hono/utils/http-status";
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
//#region src/hono/types.d.ts
/**
 * Node incoming message with an optional pre-parsed body.
 */
type IncomingWithBody = IncomingMessage & {
  body?: unknown;
};
/**
 * Hono-specific middleware options, constrained to the `"hono"` adapter.
 */
type HonoMiddlewareOptions = MiddlewareOptions<"hono">;
/**
 * Hono middleware handler signature used by the RPC middleware.
 */
interface HonoMiddlewareHooks {
  /** Hono middleware handler */
  handler: MiddlewareHandler;
}
/**
 * Hono middleware factory: takes optional initial options and returns
 * the Hono-compatible handler.
 */
type HonoMiddlewareFn = <A extends AdapterName = "hono">(initialOptions?: Partial<MiddlewareOptions<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/hono/createMiddleware.d.ts
/**
 * Creates a Hono middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * Uses Hono's factory `createMiddleware` to wrap the handler.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Hono middleware function
 */
export declare const createMiddleware: HonoMiddlewareFn;
/**
 * Creates the Hono RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Hono middleware function
 */
export declare const createRPCMiddleware: HonoMiddlewareFn;
//#endregion
//#region src/hono/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to a Hono app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Hono application instance
 */
export declare function attachRPC(app: Hono$1): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to a Hono app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into Hono.
 * @param app - Hono application instance
 * @param vite - Running Vite dev server
 */
export declare const attachVite: (app: Hono$1, vite: ViteDevServer) => void;
/**
 * Creates a Hono-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to Hono's context-based request/response model.
 * Supports both Node.js and Bun runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns A Hono middleware function
 * @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
 */
export declare const viteMiddleware: (vite: ViteDevServer) => ReturnType<typeof createMiddleware$1<{
  Bindings: HttpBindings;
}>>;
/**
 * Reads and parses the HTTP request body from a Hono context.
 * Supports JSON and text content types, with pre-parsed body detection for server-side environments.
 * @param c - Hono request context
 * @returns A promise resolving to the parsed body with its content type
 */
export declare const readBody: (c: Context) => Promise<BodyResult>;
/**
 * Issues an HTTP redirect on a Hono context. Hono's `c.redirect(location,
 * status)` returns a `Response` object that the handler must return (it never
 * writes directly). Defaults to `303 See Other` for convention
 * (Post/Redirect/Get).
 * @param c - Hono context
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 * @returns A Hono `Response` to return from the handler
 */
export declare const redirect: (c: Context, location: string, status?: RedirectStatusCode) => Response;
//#endregion
export type { Hono, HonoApp, HonoContext, HonoMiddlewareFn, HonoMiddlewareHandler, HonoMiddlewareHooks, HonoMiddlewareOptions, HonoNext, HonoRequest, HonoResponse, IncomingWithBody, RequestDetails, ResponseDetails };
//# sourceMappingURL=hono.d.mts.map