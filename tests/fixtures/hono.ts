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

function makeHonoContext(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  envIncoming?: EventEmitter;
} = {}) {
  const ee = opts.envIncoming ?? new EventEmitter();
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
  const ctx = {
    req: {
      path: rawPath.split("?")[0],
      method: opts.method ?? "GET",
      header: (name: string) => opts.headers?.[name.toLowerCase()] ?? "",
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
    res: { status: 200 },
    body: vi.fn(),
  };
  return ctx as any;
}

function makeHonoNext() {
  return vi.fn().mockResolvedValue(undefined);
}

export { makeHonoContext, makeHonoNext, seedServerMap };
