// @thednp/rpc/src/fastify/helpers.ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ViteDevServer } from "vite";
import type { FastifyInstance } from "fastify";
import type { Buffer } from "node:buffer";
import type { BodyResult, JsonValue } from "../types.d.ts";
import fastifyRpcPlugin from "./plugin.ts";
import { httpError } from "../server-helpers.ts";

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
/**
 * Parses a body leniently: JSON when it parses, otherwise the raw string.
 * Used for bodies that did not declare JSON — notably a request with no
 * `Content-Type` header, which must still arrive parsed if it carries JSON.
 * @param body - The raw body text
 * @returns The parsed JSON value, or the original string
 */
const parseJsonOrRawText = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

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
        // Only a *declared* JSON body is parsed strictly; everything else keeps
        // the lenient sniff. Previously all three fell through to a single
        // `JSON.parse(body)`, so a malformed JSON body and a legitimate text
        // body produced the same exception and were indistinguishable — the
        // catch "recovered" both into a text/plain string, which silently
        // handed a JSON-declared function a string and answered 200.
        //
        // The lenient branch is deliberate and must stay: a request with no
        // `Content-Type` at all (curl, and the nojs form fallback) that
        // happens to carry JSON still has to arrive parsed.
        const data = isMultipart
          ? { raw: body }
          : isUrlEncoded
          ? Object.fromEntries(new URLSearchParams(body))
          : isJSON
          ? JSON.parse(body)
          : parseJsonOrRawText(body);
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
        // A body that does not parse under a declared JSON Content-Type is a
        // client error. It used to resolve as `text/plain` with the raw string,
        // which silently handed a JSON-declared function a string and answered
        // 200 — failing open on malformed input. Every host framework rpc
        // supports answers 400 here (Express `entity.parse.failed`, Fastify
        // `FST_ERR_CTP_INVALID_JSON_BODY`, koa-bodyparser, h3's own readBody).
        reject(httpError(400, "Invalid JSON body"));
      }
    };
    const onError = (err: Error) => {
      toggleListeners();
      reject(err);
    };

    toggleListeners(true);
  });
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
