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

function makeReq(opts: {
  url?: string;
  originalUrl?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}) {
  const ee = new EventEmitter();
  const req = Object.assign(ee, {
    url: opts.url ?? "/",
    originalUrl: opts.originalUrl,
    method: opts.method ?? "GET",
    headers: { ...BROWSER_HEADERS, ...opts.headers },
  });
  return req as typeof req & import("node:http").IncomingMessage;
}

function simulateBody(req: EventEmitter, body: string) {
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
}

function makeRes() {
  const ee = new EventEmitter();
  const chunks: string[] = [];
  const res = Object.assign(ee, {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    header: vi.fn(),
    end: vi.fn((data?: unknown) => {
      if (data) chunks.push(String(data));
      res.writableEnded = true;
    }),
    // A real Express response always has `redirect`, and `isExpressResponse`
    // duck-types on `json` + `send` — so a fixture with those two but no
    // `redirect` is not Express, it is a trap. Any test reaching
    // `redirect(res, …)` would fail with a confusing "res.redirect is not a
    // function" thrown from inside the helper.
    //
    // `...args: unknown[]` rather than `(status, location)`: Express types
    // `redirect` as an *overloaded* method, and a permissive rest signature is
    // assignable to every overload while a two-arg one is not.
    redirect: vi.fn(function (this: typeof res, ...args: unknown[]) {
      const [first, second] = args;
      const status = typeof first === "number" ? first : 302;
      const location = typeof first === "number" ? second : first;
      res.statusCode = status;
      res.setHeader("Location", String(location));
      res.headersSent = true;
    }),
    status: vi.fn(function (this: typeof res, code: number) {
      res.statusCode = code;
      return this;
    }),
    send: vi.fn(function (this: typeof res, data?: unknown) {
      if (data) chunks.push(String(data));
      res.headersSent = true;
    }),
    json: vi.fn(function (this: typeof res, data?: unknown) {
      const json = JSON.stringify(data);
      chunks.push(json);
      res.headersSent = true;
    }),
    get chunks() {
      return chunks;
    },
  });
  return res as
    & typeof res
    & import("node:http").ServerResponse
    & import("express").Response;
}

function makeNext() {
  return vi.fn();
}

export { makeNext, makeReq, makeRes, seedServerMap, simulateBody };
