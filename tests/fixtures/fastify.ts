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

function makeFastifyReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  rawBody?: string;
} = {}) {
  const ee = new EventEmitter();
  const req = Object.assign(ee, {
    url: opts.url ?? "/",
    method: opts.method ?? "GET",
    headers: { ...BROWSER_HEADERS, ...opts.headers },
    body: opts.rawBody
      ? undefined
      : opts.body
      ? JSON.parse(opts.body)
      : undefined,
  }) as any;
  return {
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    raw: req,
  };
}

function makeFastifyReply() {
  return {
    // A real `reply` carries `statusCode`, and the adapter's `onDispatch` reads
    // it to decide whether a failure body needs the correlation id. The mock used
    // to be a bare `mockReturnThis`, so `statusCode` was always undefined and
    // every record claimed the default — recorded here rather than worked around
    // in the adapter.
    statusCode: 200,
    status: vi.fn(function (this: { statusCode: number }, code?: number) {
      if (typeof code === "number") this.statusCode = code;
      return this;
    }),
    sent: false,
    send: vi.fn(function (this: any, data?: unknown) {
      this.sent = true;
      if (data !== undefined) this._data = data;
    }),
    header: vi.fn(),
    // Fastify v5 signature: destination first, status optional. The
    // `redirect` helper in src/fastify/helpers.ts calls exactly this, so the
    // mock has to carry the method — without it, every redirect test had to
    // bolt one on with a cast.
    redirect: vi.fn(),
    raw: { headersSent: false },
  };
}

function makeFastifyDone() {
  return vi.fn();
}

function simulateRawBody(
  req: { raw: EventEmitter },
  body: string,
) {
  process.nextTick(() => {
    req.raw.emit("data", Buffer.from(body));
    req.raw.emit("end");
  });
}

export {
  makeFastifyDone,
  makeFastifyReply,
  makeFastifyReq,
  seedServerMap,
  simulateRawBody,
};
