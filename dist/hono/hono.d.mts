import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { Context, Hono, MiddlewareHandler } from "hono";
import { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { HttpBindings } from "@hono/node-server";
import { ViteDevServer } from "vite";
import "express";
import "fastify";
import "koa";
//#region src/hono/types.d.ts
type HonoMiddlewareOptions = MiddlewareOptions<"hono">;
interface HonoMiddlewareHooks {
  handler: MiddlewareHandler;
}
type HonoMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "hono">(initialOptions?: Partial<MiddlewareOptions<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/hono/createMiddleware.d.ts
/**
 * Creates a Hono middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * Uses Hono's factory `createMiddleware` to wrap the handler.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Hono middleware function
 */
declare const createMiddleware: HonoMiddlewareFn;
/**
 * Creates the Hono RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Hono middleware function
 */
declare const createRPCMiddleware: HonoMiddlewareFn;
//#endregion
//#region src/types.d.ts
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
};
// primitives and their compositions
type JsonPrimitive = string | number | boolean | null | undefined;
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
//#endregion
//#region src/hono/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to a Hono app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Hono application instance
 */
declare function attachRPC(app: Hono): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to a Hono app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into Hono.
 * @param app - Hono application instance
 * @param vite - Running Vite dev server
 */
declare const attachVite: (app: Hono, vite: ViteDevServer) => void;
/**
 * Creates a Hono-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to Hono's context-based request/response model.
 * Supports both Node.js and Bun runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns A Hono middleware function
 * @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
 */
declare const viteMiddleware: (vite: ViteDevServer) => ReturnType<typeof createMiddleware$1<{
  Bindings: HttpBindings;
}>>;
/**
 * Reads and parses the HTTP request body from a Hono context.
 * Supports JSON and text content types, with pre-parsed body detection for server-side environments.
 * @param c - Hono request context
 * @returns A promise resolving to the parsed body with its content type
 */
declare const readBody: (c: Context) => Promise<BodyResult>;
//#endregion
export { type HonoMiddlewareFn, type HonoMiddlewareHooks, type HonoMiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, viteMiddleware };
//# sourceMappingURL=hono.d.mts.map