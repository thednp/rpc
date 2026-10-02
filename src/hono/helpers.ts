// src/hono/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type { ViteDevServer } from "vite";
import type {
  ContentfulStatusCode,
  RedirectStatusCode,
} from "hono/utils/http-status";
import type { BodyResult } from "@thednp/rpc";
import type { IncomingWithBody } from "./types.d.ts";
import { parseRawBody, preParsedBody, readWebBody } from "../body.ts";
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
  const options = await loadRPCConfig();

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
        // Only a node-style runtime can hand Vite's Connect stack a raw
        // IncomingMessage/ServerResponse. Everywhere else `c.env` is absent,
        // so there is nothing to bridge and we fall through to the Bun path.
        if (!c.env) {
          resolve(next());
          return;
        }
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
 * The keys Hono can cache a request body under, each holding a promise.
 *
 * Structural rather than imported: Hono's `BodyCache` is a local alias in
 * `hono/types` and is not exported, so naming it would couple rpc to an
 * internal. The union is derived from the Web `Body` mixin, which is the spec
 * surface it mirrors.
 */
type BodyCache = Partial<
  Record<
    "text" | "json" | "arrayBuffer" | "blob" | "formData",
    Promise<unknown>
  >
>;

/**
 * Reads and parses the HTTP request body from a Hono context.
 *
 * Two paths, in order. A body some earlier layer has already buffered takes the
 * pre-parsed path; anything still on the wire takes {@link readWebBody}, which is
 * the same capped read h3 uses. JSON is not special-cased — see below.
 *
 * @param c - Hono request context
 * @param limit - byte cap enforced while the body streams
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = async (
  c: Context,
  limit?: number,
): Promise<BodyResult> => {
  const declared = c.req.header("content-type");

  // Under @hono/node-server the Node body parser has already run and left the
  // decoded body on `c.env.incoming`. `c.env` is optional — Workers, Bun, Deno,
  // serverless adapters, and `app.fetch()` all leave it undefined.
  const incoming = (c.env as HttpBindings | undefined)?.incoming as
    | IncomingWithBody
    | undefined;
  if (incoming?.body !== undefined) {
    return preParsedBody(incoming.body, declared);
  }

  // Hono's own body cache, populated when a host middleware has already read
  // the body. Reading `c.req.raw` here would hit a consumed stream, and
  // `c.req.json()`'s cache lookup accepts a body cached under *any* key, so the
  // same union is what it would have found. A cap cannot apply to an
  // already-buffered body, on this path or the one above; the host's own limit
  // is the only thing that can bound it.
  //
  // The cached form depends on which accessor ran, and Hono caches the *raw*
  // body under a body-form key: `c.req.json()` stores the text under `text` and
  // parses it itself afterwards. So `json` holds an already-parsed value and
  // every other key holds raw bytes, and they need different treatment — passing
  // the text to `preParsedBody` would hand the caller a string and silently lose
  // the object.
  const cache = c.req.bodyCache as BodyCache | undefined;
  for (const key of Object.keys(cache ?? {}) as (keyof BodyCache)[]) {
    const cached = await (cache as Record<string, Promise<unknown>>)[key];
    // Dispatch on the cached form, not on the key: `json` is the one key that
    // holds an already-parsed value, while every other form holds raw bytes that
    // still have to be parsed against the declared type. A previous version
    // special-cased `json` before the loop and skipped it inside; both were
    // unreachable, since the early return meant the loop never saw a `json`
    // entry. Hono's own `#cachedBody` accepts whichever form happens to be
    // cached, and so does this.
    if (typeof cached === "string") return parseRawBody(cached, declared);
    return preParsedBody(cached, declared);
  }

  // Everything else, JSON included, goes through the capped read.
  //
  // This used to return early for declared-JSON via `c.req.json()`, on the
  // reasonable-sounding grounds that a 4xx Hono had already classified should
  // keep its status. But `c.req.json()` reads the stream itself, and no cap
  // lives on that path — so `bodyLimit` silently did not apply to JSON on Hono
  // while it applied to every other content type and to the same body on h3.
  // Measured: a body 4x over the limit returned 200 with the payload parsed,
  // where h3 returned 413. The cap is the load-bearing part; the status
  // provenance was cosmetic, and `parseRawBody` answers malformed JSON with
  // the same 400 either way.
  return readWebBody(c.req.raw, declared, { limit });
};

/**
 * Issues an HTTP redirect on a Hono context. Hono's `c.redirect(location,
 * status)` returns a `Response` object that the handler must return (it never
 * writes directly). Defaults to `303 See Other` for convention
 * (Post/Redirect/Get).
 * @param c - Hono context
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 * @returns A Hono `Response` to return from the handler
 */
export const redirect = (
  c: Context,
  location: string,
  status: RedirectStatusCode = 303,
): Response => {
  return c.redirect(location, status);
};
