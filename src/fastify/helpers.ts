// @thednp/rpc/src/fastify/helpers.ts
import type { FastifyRequest } from "fastify";
import type { ViteDevServer } from "vite";
import type { FastifyInstance } from "fastify";
import type { Buffer } from "node:buffer";
import type { BodyResult, JsonValue } from "../types.d.ts";
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
  const { adapter: _adapter, ...options } = await loadRPCConfig();
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
 * Reads and parses the HTTP request body from a Fastify request.
 * If Fastify's body parser already consumed the stream, uses the pre-parsed body from `req.body`.
 * @param req - Fastify request object
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = (
  req: FastifyRequest,
): Promise<BodyResult> => {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"]?.toLowerCase() || "";
    const reqBody = req.body as JsonValue;

    if (reqBody !== undefined) {
      const isJSON = contentType.includes("json");
      const isMultipart = contentType.includes("multipart/form-data");
      const isUrlEncoded = contentType.includes("urlencoded");
      resolve({
        contentType: isMultipart
          ? "multipart/form-data"
          : isJSON
          ? "application/json"
          : isUrlEncoded
          ? "application/x-www-form-urlencoded"
          : "text/plain",
        data: isMultipart
          ? (reqBody as Record<string, unknown>)
          : isJSON
          ? reqBody
          : isUrlEncoded
          ? (reqBody as Record<string, unknown>)
          : String(reqBody),
      } as BodyResult);
      return;
    }

    const toggleListeners = (add?: boolean) => {
      const method = add ? "on" : "off";
      req.raw[method]("data", onData);
      req.raw[method]("end", onEnd);
      req.raw[method]("error", onError);
    };

    let body = "";

    const onData = (chunk: Buffer) => {
      body += chunk.toString();
    };

    const onEnd = () => {
      toggleListeners();
      const isJSON = contentType.includes("json");
      const isMultipart = contentType.includes("multipart/form-data");
      const isUrlEncoded = contentType.includes("urlencoded");
      try {
        const data = isMultipart
          ? { raw: body }
          : isUrlEncoded
          ? Object.fromEntries(new URLSearchParams(body))
          : JSON.parse(body);
        resolve({
          contentType: isMultipart
            ? "multipart/form-data"
            : isJSON
            ? "application/json"
            : isUrlEncoded
            ? "application/x-www-form-urlencoded"
            : "text/plain",
          data: isMultipart ? (data as Record<string, unknown>) : data,
        } as BodyResult);
      } catch (_e) {
        resolve({ contentType: "text/plain", data: String(body) });
      }
    };
    const onError = (err: Error) => {
      toggleListeners();
      reject(err);
    };

    toggleListeners(true);
  });
};
