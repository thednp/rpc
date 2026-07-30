// @thednp/rpc/src/fastify/helpers.ts
import type { FastifyRequest } from "fastify";
import type { ViteDevServer } from "vite";
import type { FastifyInstance } from "fastify";
import type { Buffer } from "node:buffer";
import fastifyRpcPlugin from "./plugin.ts";
import type { BodyResult, JsonValue } from "../types.d.ts";

export async function attachRPC(app: FastifyInstance) {
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();
  await app.register(fastifyRpcPlugin, options);
}

export function attachVite(app: FastifyInstance, vite: ViteDevServer) {
  app.addHook("onRequest", async (request, reply) => {
    const next = () =>
      new Promise((resolve) => {
        vite.middlewares(request.raw, reply.raw, resolve);
      });
    await next();
  });
}

export const readBody = (
  req: FastifyRequest,
): Promise<BodyResult> => {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"]?.toLowerCase() || "";
    const reqBody = req.body as JsonValue;

    if (reqBody !== undefined) {
      const isJSON = contentType.includes("json");
      resolve({
        contentType: isJSON ? "application/json" : "text/plain",
        data: isJSON ? reqBody : String(reqBody),
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
      try {
        const data = JSON.parse(body);
        resolve({
          contentType: isJSON ? "application/json" : "text/plain",
          data,
        });
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
