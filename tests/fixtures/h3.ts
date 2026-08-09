import EventEmitter from "node:events";
import type { ServerFnEntry } from "../../src/types.d.ts";
import type { H3Event } from "h3";
import { vi } from "vitest";
import { mockEvent } from "h3";
import { serverFunctionsMap } from "../../src/functionsMap.ts";

function seedServerMap() {
  serverFunctionsMap.set("__dummy", {
    name: "__dummy",
    handler: vi.fn() as unknown as ServerFnEntry["handler"],
  });
}

function makeH3Event(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  locals?: Record<string, unknown>;
  nodeReq?: EventEmitter;
} = {}): H3Event {
  const path = opts.path ?? "/";
  const url = path.includes("://") ? path : `http://localhost${path}`;
  const event = mockEvent(url, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.headers,
    body: opts.body,
    h3: opts.locals,
  });
  if (opts.nodeReq) {
    // Pretend the request is running through the Node.js runtime; the node
    // req is used by the adapters for client-disconnect cancellation.
    (event.req as { runtime?: Record<string, unknown> }).runtime = {
      name: "node",
      node: { req: opts.nodeReq, res: {} },
    };
  }
  return event;
}

function makeH3Next() {
  return vi.fn().mockResolvedValue(undefined);
}

export { makeH3Event, makeH3Next, seedServerMap };
