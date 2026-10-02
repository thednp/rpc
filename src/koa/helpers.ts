// src/koa/helpers.ts
import type { ViteDevServer } from "vite";
import type { BodyResult, MiddlewareOptions } from "@thednp/rpc";
import type { Koa, KoaContext } from "./types.d.ts";
import { preParsedBody, readStream } from "../body.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to a Koa app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Koa application instance
 */
export async function attachRPC(
  app: Koa,
  overrides?: MiddlewareOptions<"koa">,
) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");

  const options = await loadRPCConfig();
  // Explicit arguments win over the config file, so a host can adjust one
  // option without discarding everything `rpc.config.ts` declared.
  app.use(createRPCMiddleware({ ...options, ...overrides }));
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
  limit?: number,
): Promise<BodyResult> => {
  const declared = ctx.request.headers["content-type"];

  // koa-bodyparser (or any equivalent) has already decoded the body.
  if (ctx.request.body !== undefined) {
    return Promise.resolve(preParsedBody(ctx.request.body, declared));
  }

  return readStream(ctx.req, ctx.request.headers["content-type"], { limit });
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
