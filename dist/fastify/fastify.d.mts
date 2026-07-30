import { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "koa";
//#region src/fastify/types.d.ts
type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;
type FastifyMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
interface FastifyMiddlewareHooks {
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
// Define the plugin function
type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  isRPC: boolean;
};
//#endregion
//#region src/fastify/createMiddleware.d.ts
/**
 * Creates a Fastify preHandler hook with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Fastify preHandler hook function
 */
declare const createMiddleware: FastifyMiddlewareFn;
/**
 * Creates the Fastify RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sends the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Fastify preHandler hook function
 */
declare const createRPCMiddleware: FastifyMiddlewareFn;
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
//#region src/fastify/helpers.d.ts
/**
 * Convenience function to load RPC config and register the RPC plugin to a Fastify instance.
 * Dynamically imports loadRPCConfig and registers the fastify-rpc plugin.
 * @param app - Fastify instance
 */
declare function attachRPC(app: FastifyInstance): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to a Fastify instance for development mode.
 * Uses an `onRequest` hook to delegate to Vite's connect-compatible middleware stack.
 * @param app - Fastify instance
 * @param vite - Running Vite dev server
 */
declare function attachVite(app: FastifyInstance, vite: ViteDevServer): void;
/**
 * Reads and parses the HTTP request body from a Fastify request.
 * If Fastify's body parser already consumed the stream, uses the pre-parsed body from `req.body`.
 * @param req - Fastify request object
 * @returns A promise resolving to the parsed body with its content type
 */
declare const readBody: (req: FastifyRequest) => Promise<BodyResult>;
//#endregion
export { type FastifyMiddlewareFn, type FastifyMiddlewareHooks, type FastifyMiddlewareOptions, type RpcFastifyPluginOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };
//# sourceMappingURL=fastify.d.mts.map