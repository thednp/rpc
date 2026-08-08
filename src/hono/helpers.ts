// src/hono/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { ViteDevServer } from "vite";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { BodyResult } from "../types.d.ts";
import type { IncomingWithBody } from "./types.d.ts";
import { createMiddleware } from "hono/factory";
import { createRPCMiddleware } from "./createMiddleware.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to a Hono app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - Hono application instance
 */
export async function attachRPC(app: Hono) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();

  app.use(createRPCMiddleware(options));
}

/**
 * Attaches Vite's dev server middlewares to a Hono app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into Hono.
 * @param app - Hono application instance
 * @param vite - Running Vite dev server
 */
export const attachVite = (app: Hono, vite: ViteDevServer): void => {
  app.use(viteMiddleware(vite));
};

/**
 * Creates a Hono-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to Hono's context-based request/response model.
 * Supports both Node.js and Bun runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns A Hono middleware function
 * @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
 */
export const viteMiddleware = (
  vite: ViteDevServer,
): ReturnType<typeof createMiddleware<{ Bindings: HttpBindings }>> => {
  return createMiddleware<{ Bindings: HttpBindings }>((c, next) => {
    return new Promise((resolve) => {
      // Node.js
      // @ts-expect-error - NodeJS is different
      // istanbul ignore if
      if (typeof Bun === "undefined") {
        vite.middlewares(c.env.incoming, c.env.outgoing, () => resolve(next()));
        return;
      }

      /* istanbul ignore next */ {
        // Bun
        let sent = false;
        const headers = new Headers();
        // Polyfill the node:http IncommingMessage and ServerResponse
        vite.middlewares(
          {
            url: new URL(c.req.path, "http://localhost").pathname,
            method: c.req.raw.method,
            headers: Object.fromEntries(c.req.raw.headers),
          } as IncomingMessage,
          {
            setHeader(name, value: string) {
              headers.set(name, value);
              return this;
            },
            end(body) {
              sent = true;
              resolve(
                // @ts-expect-error - weird
                c.body(body, c.res.status as ContentfulStatusCode, headers),
              );
            },
          } as ServerResponse,
          () => sent || resolve(next()),
        );
      }
    });
  });
};

/**
 * Reads and parses the HTTP request body from a Hono context.
 * Supports JSON and text content types, with pre-parsed body detection for server-side environments.
 * @param c - Hono request context
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = async (
  c: Context,
): Promise<BodyResult> => {
  const contentType = c.req.header("content-type")?.toLowerCase() || "";
  const isJSON = contentType.includes("json");
  const isMultipart = contentType.includes("multipart/form-data");
  const isUrlEncoded = contentType.includes("urlencoded");
  const incoming = (c.env as HttpBindings).incoming as
    | IncomingWithBody
    | undefined;
  if (incoming?.body !== undefined) {
    const reqBody = incoming.body;
    return {
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
    } as BodyResult;
  }
  if (isJSON) {
    const data = await c.req.json();
    return {
      contentType: "application/json",
      data,
    };
  }

  const text = await c.req.text();
  return {
    contentType: isMultipart
      ? "multipart/form-data"
      : isUrlEncoded
      ? "application/x-www-form-urlencoded"
      : "text/plain",
    data: isMultipart
      ? ({ raw: text } as Record<string, unknown>)
      : isUrlEncoded
      ? Object.fromEntries(new URLSearchParams(text))
      : String(text),
  } as BodyResult;
};
