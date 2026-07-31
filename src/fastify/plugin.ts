/** @module Fastify plugin. Exports the RPC plugin wrapped with `fastify-plugin` for lifecycle-compatible registration. */
// inspired by https://github.com/royalswe/vike-fastify-boilerplate/blob/main/server/index.ts
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { MiddlewareOptions } from "../types.d.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";

export type { MiddlewareOptions };

/**
 * Fastify RPC plugin signature: registers the middleware as a preHandler hook.
 */
type FastifyRPCPlugin = (
  fastify: FastifyInstance,
  initialOptions: Partial<MiddlewareOptions<"fastify">>,
  done: () => void,
) => void;

/**
 * Fastify plugin factory that registers the RPC middleware as a preHandler hook.
 * @param fastify - Fastify instance
 * @param initialOptions - Middleware options including rpcPrefix
 * @param done - Callback to signal plugin registration completion
 */
const RpcPlugin: FastifyRPCPlugin = (
  fastify,
  initialOptions,
  done,
) => {
  // Register RPC middleware as preHandler hook
  const rpcMiddleware = createRPCMiddleware(initialOptions);
  fastify.addHook("preHandler", async (request, reply) => {
    const next = () =>
      new Promise((resolve) => {
        rpcMiddleware(request, reply, resolve);
      });
    await next();
  });

  done();
};

/**
 * `fastify-plugin` function type, used to type the wrapped export.
 */
type FastifyPlugin = typeof fp;

/**
 * Return type of `fastify-plugin` wrapping, matching the final plugin export.
 */
type RegisteredFastifyRPCPlugin = ReturnType<FastifyPlugin>;

// Export the plugin wrapped with fastify-plugin
const rpcPlugin = fp(RpcPlugin, {
  name: "uni-rpc-fastify-plugin",
}) as RegisteredFastifyRPCPlugin;

export { rpcPlugin as default };
