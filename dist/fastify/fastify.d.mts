import fp from "fastify-plugin";
import { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "koa";
//#region src/fastify/types.d.ts
/**
 * Fastify RPC plugin signature: registers the middleware as a preHandler hook.
 */
type FastifyRPCPlugin = (fastify: FastifyInstance, initialOptions: Partial<MiddlewareOptions<"fastify">>, done: () => void) => void;
/**
 * `fastify-plugin` function type, used to type the wrapped export.
 */
type FastifyPlugin = typeof fp;
/**
 * Return type of `fastify-plugin` wrapping, matching the final plugin export.
 */
type RegisteredFastifyRPCPlugin = ReturnType<FastifyPlugin>;
/**
 * Options accepted by the Fastify RPC plugin (`fp()`-wrapped registration).
 */
type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  /** Whether this is an RPC plugin registration */
  isRPC: boolean;
};
/**
 * Fastify-specific middleware options, constrained to the `"fastify"` adapter.
 */
type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;
/**
 * Fastify middleware factory: takes optional initial options and returns
 * the Fastify-compatible handler.
 */
type FastifyMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
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
/**
 * Parsed request body result discriminated by content type.
 */
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
};
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
type JsonArray = JsonValue[];
/**
 * Any JSON-serializable value: primitive, array, or object.
 */
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
export { type FastifyMiddlewareFn, type FastifyMiddlewareHooks, type FastifyMiddlewareOptions, type FastifyPlugin, type FastifyRPCPlugin, type RegisteredFastifyRPCPlugin, type RpcFastifyPluginOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };
//# sourceMappingURL=fastify.d.mts.map