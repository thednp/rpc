// @thednp/rpc/src/fastify/helpers.ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ViteDevServer } from "vite";
import type { FastifyInstance } from "fastify";
import type { BodyResult } from "../types.d.ts";
import { preParsedBody, readStream } from "../body.ts";
import fastifyRpcPlugin from "./plugin.ts";

/**
 * Convenience function to load RPC config and register the RPC plugin to a Fastify instance.
 * Dynamically imports loadRPCConfig and registers the fastify-rpc plugin.
 * @param app - Fastify instance
 */
export async function attachRPC(app: FastifyInstance) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");
  const options = await loadRPCConfig();
  await app.register(fastifyRpcPlugin, options);
}

/**
 * Attaches Vite's dev server middlewares to a Fastify instance for development mode.
 * Uses an `onRequest` hook to delegate to Vite's connect-compatible middleware stack.
 * @param app - Fastify instance
 * @param vite - Running Vite dev server
 */
export function attachVite(app: FastifyInstance, vite: ViteDevServer) {
  app.addHook("onRequest", async (request, reply) => {
    const next = () =>
      new Promise((resolve) => {
        vite.middlewares(request.raw, reply.raw, resolve);
      });
    await next();
  });
}

/**
 * Creates a Fastify `onRequest` hook handler that delegates to Vite's
 * connect-compatible middleware stack. Use with `app.addHook("onRequest", ...)`.
 *
 * @example
 * ```ts
 * import Fastify from "fastify";
 * import { createServer } from "vite";
 * import { viteMiddleware } from "@thednp/rpc/fastify";
 *
 * const app = Fastify();
 * const vite = await createServer({ server: { middlewareMode: true } });
 * app.addHook("onRequest", viteMiddleware(vite));
 * ```
 * @param vite - Running Vite dev server
 * @returns A Fastify `onRequest` hook handler
 */
export function viteMiddleware(
  vite: ViteDevServer,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    reply.hijack();
    await new Promise<void>((resolve, reject) => {
      const next = (err?: unknown) => (err ? reject(err) : resolve());
      vite.middlewares(request.raw, reply.raw, next);
    });
  };
}

/**
 * Reads and parses the HTTP request body from a Fastify request.
 * If Fastify's body parser already consumed the stream, uses the pre-parsed body from `req.body`.
 * @param req - Fastify request object
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = (
  req: FastifyRequest,
  limit?: number,
): Promise<BodyResult> => {
  const declared = req.headers["content-type"];

  // Fastify's own content-type parser has already decoded the body.
  if (req.body !== undefined) {
    return Promise.resolve(preParsedBody(req.body, declared));
  }

  return readStream(req.raw, req.headers["content-type"], { limit });
};

/**
 * Issues an HTTP redirect on a Fastify reply using the native
 * `reply.redirect(location, status)` API (Fastify v5 signature: destination
 * URL first, status code optional). Defaults to `303 See Other` for
 * convention (Post/Redirect/Get).
 * @param reply - Fastify reply object
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 */
export const redirect = (
  reply: FastifyReply,
  location: string,
  status = 303,
): void => {
  reply.redirect(location, status);
};
