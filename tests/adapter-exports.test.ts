import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Export-surface contract.
 *
 * Wrapper libraries must be able to name an app, request, response, `next`
 * function and middleware type for every adapter *without* depending on
 * `express` / `fastify` / `hono` / `koa` / `h3` themselves. This suite is the
 * guard that stops a name from quietly disappearing in a refactor.
 *
 * Why it parses the emitted `dist/<adapter>/<adapter>.d.mts` rather than using
 * `expectTypeOf`: these are **type-only** exports, so they are erased from the
 * emitted `.mjs` and a runtime `in` check cannot see them. Reading the emitted
 * declaration is the only assertion that survives in a plain `vitest run` — and
 * it tests exactly what a consumer resolves, rather than what the source
 * happens to declare. The suite is therefore a *build-output* test: run
 * `pnpm build` first.
 */

const ADAPTERS = {
  express: [
    "ExpressApp",
    "ExpressRequest",
    "ExpressResponse",
    "ExpressNext",
    "ExpressMiddlewareFn",
    "ExpressMiddlewareOptions",
    "ExpressMiddlewareHooks",
    "RequestDetails",
    "ResponseDetails",
    // pre-existing names, kept for back-compat
    "Express",
  ],
  fastify: [
    "FastifyApp",
    "FastifyRequest",
    "FastifyReply",
    "FastifyNext",
    "FastifyMiddlewareFn",
    "FastifyMiddlewareOptions",
    "FastifyMiddlewareHooks",
    "RequestDetails",
    "ResponseDetails",
    // pre-existing names, kept for back-compat
    "Fastify",
  ],
  hono: [
    "HonoApp",
    "HonoRequest",
    "HonoResponse",
    "HonoNext",
    "HonoMiddlewareFn",
    "HonoMiddlewareOptions",
    "HonoMiddlewareHooks",
    "RequestDetails",
    "ResponseDetails",
    // pre-existing names, kept for back-compat
    "Hono",
    "HonoContext",
    "HonoMiddlewareHandler",
  ],
  koa: [
    "KoaApp",
    "KoaRequest",
    "KoaResponse",
    "KoaNext",
    "KoaMiddlewareFn",
    "KoaMiddlewareOptions",
    "KoaMiddlewareHooks",
    "RequestDetails",
    "ResponseDetails",
    // pre-existing names, kept for back-compat
    "Koa",
    "KoaContext",
  ],
  h3: [
    "H3App",
    "H3Request",
    "H3Response",
    "H3Next",
    "H3MiddlewareFn",
    "H3MiddlewareOptions",
    "H3MiddlewareHooks",
    "RequestDetails",
    "ResponseDetails",
    // pre-existing names, kept for back-compat
    "H3",
    "H3Event",
    "H3Middleware",
  ],
} as const;

/** Reads an emitted declaration file, tolerating a missing build. */
const readDts = (adapter: string): string => {
  const path = new URL(`../dist/${adapter}/${adapter}.d.mts`, import.meta.url);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Cannot read dist/${adapter}/${adapter}.d.mts — run \`pnpm build\` before this suite.`,
    );
  }
};

describe("adapter export surface", () => {
  for (const [adapter, names] of Object.entries(ADAPTERS)) {
    describe(adapter, () => {
      const dts = readDts(adapter);

      it.each(names)("exports %s", (name) => {
        // Match the identifier as a whole word so `H3App` does not satisfy a
        // check for `H3AppAlias`, and `Express` does not match `ExpressNext`.
        expect(dts).toMatch(new RegExp(`(^|[^\\w])${name}([^\\w]|$)`));
      });
    });
  }

  it("RequestDetails/ResponseDetails are the shared definitions, not per-adapter copies", () => {
    // They moved to src/adapter-types.ts; every adapter re-exports that one type,
    // so a wrapper can write a single helper against all five frameworks.
    const shared = readFileSync(
      new URL("../src/adapter-types.d.ts", import.meta.url),
      "utf8",
    );
    expect(shared).toMatch(/export type RequestDetails/);
    expect(shared).toMatch(/export type ResponseDetails/);
  });
});
