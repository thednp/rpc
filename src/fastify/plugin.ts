// src/fastify/plugin.ts
// inspired by https://github.com/royalswe/vike-fastify-boilerplate/blob/main/server/index.ts
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { MiddlewareOptions } from "../types.d.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";

export type { MiddlewareOptions };

// Define the plugin factory
const RpcPlugin = (
  fastify: FastifyInstance,
  initialOptions: Partial<MiddlewareOptions<"fastify">>,
  done: () => void,
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
});

export { rpcPlugin as default };
