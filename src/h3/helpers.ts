// src/h3/helpers.ts
import type { H3Event, Middleware } from "h3";
import { HTTPResponse, redirect as h3Redirect } from "h3";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { BodyResult } from "@thednp/rpc";
import type { H3App } from "./types.d.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to an h3 app.
 * Dynamically imports loadRPCConfig and registers the middleware.
 * @param app - h3 application instance
 */
export async function attachRPC(app: H3App) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();

  app.use(createRPCMiddleware(options));
}

/**
 * Attaches Vite's dev server middlewares to an h3 app for development mode.
 * Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into h3.
 * @param app - h3 application instance
 * @param vite - Running Vite dev server
 */
export const attachVite = (app: H3App, vite: ViteDevServer): void => {
  app.use(viteMiddleware(vite));
};

/**
 * Creates an h3-compatible middleware from a Vite dev server middleware stack.
 * Bridges the Connect/Express middleware interface to h3's event-based request/response model.
 * Supports both Node.js and web runtimes with separate polyfill paths.
 * @param vite - Running Vite dev server
 * @returns An h3 middleware function
 */
export const viteMiddleware = (vite: ViteDevServer): Middleware => {
  return (event, next) =>
    new Promise((resolve) => {
      const node = event.runtime?.node;
      if (node?.req && node?.res) {
        const nodeReq = node.req;
        const nodeRes = node.res;
        // ─── Node.js runtime ─────────────────────────────────────────────
        // Forward to the real node req/res: if the Vite/Connect stack writes
        // the response, the socket is already flushed (dev-mode asset serving,
        // HMR). Connect never calls the final callback once a middleware has
        // written the response, so also settle on the response lifecycle
        // events. Stop the chain with an empty response once the socket is
        // used; the runtime's write guard prevents a second write. When the
        // stack passes through, continue to the next middleware.
        let settled = false;
        const settle = (value: unknown) => {
          // istanbul ignore if
          if (settled) return;
          settled = true;
          resolve(value);
        };
        nodeRes.once("close", () => settle(new Response(null)));
        nodeRes.once("finish", () => settle(new Response(null)));
        vite.middlewares(
          nodeReq as IncomingMessage,
          nodeRes as ServerResponse,
          () => {
            if (nodeRes.writableEnded || nodeRes.headersSent) {
              settle(new Response(null));
            } else {
              settle(next());
            }
          },
        );
        return;
      }

      // ─── Web runtime fallback ──────────────────────────────────────────
      let sent = false;
      const headers = new Headers();
      const req = {
        url: event.url.pathname + event.url.search,
        method: event.req.method,
        headers: Object.fromEntries(event.req.headers),
      } as IncomingMessage;
      const res = {
        setHeader(name: string, value: unknown) {
          headers.set(name, String(value));
          return this;
        },
        writeHead(status: number) {
          void status;
          return this;
        },
        end(body?: unknown) {
          sent = true;
          resolve(
            new HTTPResponse(body == null ? "" : (body as BodyInit), {
              headers,
            }),
          );
          return this;
        },
      } as ServerResponse;
      vite.middlewares(req, res, () => {
        if (!sent) resolve(next());
      });
    });
};

/**
 * Reads and parses the HTTP request body from an h3 event.
 * Supports JSON, text, urlencoded, and multipart content types.
 * @param event - h3 event object
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = async (event: H3Event): Promise<BodyResult> => {
  const contentType = event.req.headers.get("content-type")?.toLowerCase() ||
    "";
  const isJSON = contentType.includes("json");
  const isMultipart = contentType.includes("multipart/form-data");
  const isUrlEncoded = contentType.includes("urlencoded");
  const text = await event.req.text();
  if (isJSON) {
    return {
      contentType: "application/json",
      data: JSON.parse(text),
    } as BodyResult;
  }
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

/**
 * Issues an HTTP redirect. h3's `redirect()` returns an `HTTPResponse`
 * object that the handler must return (it never writes directly). Defaults
 * to `303 See Other` for convention (Post/Redirect/Get).
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 * @returns An h3 `HTTPResponse` to return from the handler
 */
export const redirect = (
  location: string,
  status = 303,
): HTTPResponse => {
  return h3Redirect(
    location,
    status,
    status === 303 ? "See Other" : undefined,
  );
};
