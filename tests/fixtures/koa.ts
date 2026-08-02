import EventEmitter from "node:events";
import { vi } from "vitest";
import type { ServerFnEntry } from "../../src/types.d.ts";
import { serverFunctionsMap } from "../../src/functionsMap.ts";

function seedServerMap() {
  serverFunctionsMap.set("__dummy", {
    name: "__dummy",
    handler: vi.fn() as unknown as ServerFnEntry["handler"],
  });
}

function makeKoaCtx(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}) {
  const ee = new EventEmitter();
  const ctx: any = {
    url: opts.url ?? "/",
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    req: Object.assign(ee, {
      url: opts.url ?? "/",
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
    }),
    res: {
      end: vi.fn(),
      setHeader: vi.fn(),
      statusCode: 200,
    },
    status: 200,
    body: undefined,
    set: vi.fn(),
    request: {
      headers: opts.headers ?? {},
      header: opts.headers ?? {},
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
