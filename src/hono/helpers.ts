// src/hono/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { type HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { type ViteDevServer } from "vite";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createRPCMiddleware } from "./createMiddleware.ts";
import type { BodyResult } from "../types.d.ts";

export async function attachRPC(app: Hono) {
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();

  app.use(createRPCMiddleware(options));
}

export function attachVite(app: Hono, vite: ViteDevServer): void {
  app.use(viteMiddleware(vite));
}

/**
 * Creates a hono compatible middleware for a given vite development server.
 * @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
 * @param vite the vite development server
 */
export const viteMiddleware = (vite: ViteDevServer) => {
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

export const readBody = async (
  c: Context,
): Promise<BodyResult> => {
  const contentType = c.req.header("content-type")?.toLowerCase() || "";
  const isJSON = contentType.includes("json");
  type IncomingWithBody = IncomingMessage & { body?: unknown };
  const incoming = (c.env as HttpBindings).incoming as
    | IncomingWithBody
    | undefined;
  if (incoming?.body !== undefined) {
    const reqBody = incoming.body;
    return {
      contentType: isJSON ? "application/json" : "text/plain",
      data: isJSON ? reqBody : String(reqBody),
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
  return { contentType: "text/plain", data: String(text) };
};
