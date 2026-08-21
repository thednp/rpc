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

function makeReq(opts: {
  url?: string;
  originalUrl?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const ee = new EventEmitter();
  const req = Object.assign(ee, {
    url: opts.url ?? "/",
    originalUrl: opts.originalUrl,
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
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
