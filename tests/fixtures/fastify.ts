import EventEmitter from "node:events";
import { vi } from "vitest";
import type { ServerFnEntry } from "../../src/types.d.ts";
import { serverFunctionsMap } from "../../src/functionsMap.ts";
import { setGlobalPrefix } from "../../src/server.ts";

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
  headers?: Record<string, string>;
  body?: string;
  rawBody?: string;
} = {}) {
  const ee = new EventEmitter();
  const req = Object.assign(ee, {
    url: opts.url ?? "/",
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
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
    status: vi.fn().mockReturnThis(),
    sent: false,
    send: vi.fn(function (this: any, data?: unknown) {
      this.sent = true;
      if (data !== undefined) this._data = data;
    }),
    header: vi.fn(),
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
