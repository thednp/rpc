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

function makeHonoContext(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  envIncoming?: EventEmitter;
} = {}) {
  const ee = opts.envIncoming ?? new EventEmitter();
  const headers = { ...BROWSER_HEADERS, ...opts.headers };
  const rawPath = opts.path ?? "/";
  const jsonBody = opts.body
    ? (() => {
      try {
        return JSON.parse(opts.body);
      } catch {
        return undefined;
      }
    })()
    : undefined;
  // Hono's real `c.req.raw` is a Web `Request`, and the body-limit path reads
  // the cap from its `ReadableStream` rather than trusting a `Content-Length`
  // header (a Request built in JavaScript carries none). Modelling it as a real
  // Request here keeps the fixture honest about that.
  const raw = new Request(`http://localhost${rawPath}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    // `Headers` drops undefined values rather than carrying them, which is what
    // a real header map does.
    headers: new Headers(
      Object.entries(headers).filter(([, v]) => v !== undefined) as [
        string,
        string,
      ][],
    ),
    ...(opts.body !== undefined
      ? ({ body: opts.body, duplex: "half" } as RequestInit)
      : {}),
  });
  const ctx = {
    req: {
      raw,
      path: rawPath.split("?")[0],
      method: opts.method ?? "GET",
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => {
        const qs = rawPath.split("?")[1];
        return qs ? new URLSearchParams(qs).get(name) ?? "" : "";
      },
      json: async () => jsonBody as any,
      text: async () => opts.body ?? "",
    },
    json: vi.fn().mockReturnThis(),
    env: {
      incoming: ee,
      outgoing: {},
    },
    // A real Hono context has `redirect(location, status)`, and the adapter
    // returns its result directly — so the mock has to produce a Response.
    redirect: vi.fn(function (location: string, status: number) {
      return new Response(null, { status, headers: { location } });
    }),
    res: { status: 200 },
    body: vi.fn(),
  };
  return ctx as any;
}

function makeHonoNext() {
  return vi.fn().mockResolvedValue(undefined);
}

export { makeHonoContext, makeHonoNext, seedServerMap };
