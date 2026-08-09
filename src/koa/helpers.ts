// src/koa/helpers.ts
import type { Buffer } from "node:buffer";
import type { ViteDevServer } from "vite";
import { createRPCMiddleware } from "./createMiddleware.ts";
import type { BodyResult } from "@thednp/rpc";
import type { Koa } from "./index.ts";
import type { KoaContext } from "./types.d.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to a Koa app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Koa application instance
 */
export async function attachRPC(app: Koa) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");

  const config = await loadRPCConfig();
  const { adapter: _adapter, ...options } = config;
  app.use(createRPCMiddleware(options));
}

/**
 * Attaches Vite's dev server middlewares to a Koa app for development mode.
 * Bridges Koa's context-based middleware to Vite's Connect-compatible middleware stack
 * by forwarding Koa body, wrapping res.end, and delegating back to Koa on 404 or unhandled routes.
 * @param app - Koa application instance
 * @param vite - Running Vite dev server
 */
export function attachVite(app: Koa, vite: ViteDevServer): void {
  app.use(async (ctx: KoaContext, next) => {
    const req = ctx.req;
    const res = ctx.res;

    // Forward Koa body to req.body for Express/RPC middleware compatibility
    const requestBody = ctx.request?.body;
    if (requestBody !== undefined) {
      Object.assign(req, { body: requestBody });
    }

    const originalEnd = res.end.bind(res);
    let viteHandled = false;
    // @ts-ignore - Koa res.end type mismatch with Node's
    res.end = function (...args: unknown[]) {
      viteHandled = true;
      return originalEnd(args[0]);
    };

    await new Promise<void>((resolve) => {
      vite.middlewares(req, res, () => resolve(undefined));
    });

    // @ts-ignore - Koa res.end type mismatch with Node's
    res.end = originalEnd;

    if (!viteHandled || res.statusCode === 404) {
      await next();
    }
  });
}

/**
 * Reads and parses the HTTP request body from a Koa context.
 * If koa-body or another body parser already consumed the stream,
 * uses the pre-parsed body from `ctx.request.body`.
 * @param ctx - Koa context
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = (
  ctx: KoaContext,
): Promise<BodyResult> => {
  const contentType = ctx.request.headers["content-type"]?.toLowerCase() || "";

  return new Promise((resolve, reject) => {
    // If an koa-body already consumed the stream
    // via app.use(koaBody()), use ctx.request.body directly
    const isJSON = contentType.includes("json");
    const isMultipart = contentType.includes("multipart/form-data");
    const isUrlEncoded = contentType.includes("urlencoded");
    const reqBody = ctx.request.body;
    if (reqBody !== undefined) {
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

    // OR read the body normally
    let body = "";

    const toggleListeners = (add?: boolean) => {
      const method = add ? "on" : "off";
      ctx.req[method]("data", onData);
      ctx.req[method]("end", onEnd);
      ctx.req[method]("error", onError);
    };

    const onData = (chunk: Buffer) => {
      // chunks.push(chunk);
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
      } catch (_er) {
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

/**
 * Issues an HTTP redirect on a Koa context. Koa's `ctx.redirect(location)`
 * defaults to `302` and sets the `Location` header; the status code must be
 * overridden *after* the call (setting it before is ignored, see
 * koajs/koa#857). Defaults to `303 See Other` for convention
 * (Post/Redirect/Get).
 * @param ctx - Koa context
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 */
export const redirect = (
  ctx: KoaContext,
  location: string,
  status = 303,
): void => {
  ctx.redirect(location);
  ctx.status = status;
};
