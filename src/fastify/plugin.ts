/** @module Fastify plugin. Exports the RPC plugin wrapped with `fastify-plugin` for lifecycle-compatible registration. */
// inspired by https://github.com/royalswe/vike-fastify-boilerplate/blob/main/server/index.ts
import fp from "fastify-plugin";
import type { MiddlewareOptions } from "../types.d.ts";
import type {
  FastifyRPCPlugin,
  RegisteredFastifyRPCPlugin,
} from "./types.d.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";

export type { MiddlewareOptions };

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

// Export the plugin wrapped with fastify-plugin
const rpcPlugin = fp(RpcPlugin, {
  name: "uni-rpc-fastify-plugin",
}) as RegisteredFastifyRPCPlugin;

export { rpcPlugin as default };
