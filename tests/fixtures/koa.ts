import EventEmitter from "node:events";
import { vi } from "vitest";
import type { ServerFnEntry } from "../../src/types.d.ts";
import { serverFunctionsMap } from "../../src/functionsMap.ts";
import { setGlobalPrefix } from "../../src/server.ts";

/**
 * Browser-like headers that satisfy the default `origin: "self"` policy.
 *
 * Since 0.4.0 the origin check is on by default, so a request fixture carrying
 * no browser provenance headers is rejected with 403 before any RPC logic runs —
 * and the rest of this suite would never reach the behaviour it is testing.
 * Defaulting the fixture to a self-origin request means the whole suite runs
 * *through* the secure default rather than around it, and a test that wants a
 * specific tier overrides these explicitly (`origin: undefined` drops a header,
 * because the spread preserves an explicit `undefined`).
 */
// Typed as `Record` rather than `as const` so adapters can index it with a
// dynamic header name (Hono's `c.req.header(name)` does exactly that).
export const BROWSER_HEADERS: Record<string, string> = {
  host: "app.example.com",
  origin: "https://app.example.com",
  "sec-fetch-site": "same-origin",
};

function seedServerMap() {
  setGlobalPrefix(undefined);
  serverFunctionsMap.set("__dummy", {
    name: "__dummy",
    handler: vi.fn() as unknown as ServerFnEntry["handler"],
  });
}

function makeKoaCtx(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
} = {}) {
  const ee = new EventEmitter();
  const ctx: any = {
    url: opts.url ?? "/",
    method: opts.method ?? "GET",
    headers: { ...BROWSER_HEADERS, ...opts.headers },
    state: {},
    req: Object.assign(ee, {
      url: opts.url ?? "/",
      method: opts.method ?? "GET",
      headers: { ...BROWSER_HEADERS, ...opts.headers },
    }),
    res: {
      end: vi.fn(),
      setHeader: vi.fn(),
      statusCode: 200,
    },
    status: 200,
    // A real Koa context always has `redirect()`, and src/koa/helpers.ts calls
    // exactly this — without it on the mock, any test reaching a redirect dies
    // with "ctx.redirect is not a function" thrown from inside the helper.
    redirect: vi.fn(),
    body: undefined,
    set: vi.fn(),
    request: {
      headers: { ...BROWSER_HEADERS, ...opts.headers },
      header: { ...BROWSER_HEADERS, ...opts.headers },
    },
    response: {
      set: vi.fn(),
    },
  };
  return ctx;
}

function simulateKoaBody(ctx: any, body: string) {
  process.nextTick(() => {
    ctx.req.emit("data", Buffer.from(body));
    ctx.req.emit("end");
  });
}

function makeKoaNext() {
  return vi.fn().mockResolvedValue(undefined);
}

export { makeKoaCtx, makeKoaNext, seedServerMap, simulateKoaBody };
