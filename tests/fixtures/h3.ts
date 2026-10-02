import EventEmitter from "node:events";
import type { ServerFnEntry } from "../../src/types.d.ts";
import type { H3Event } from "h3";
import { vi } from "vitest";
import { mockEvent } from "h3";
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

// h3 keeps `headers` as `Record<string, string>` rather than allowing
// `undefined` values like the other four fixtures: `mockEvent` takes a
// `HeadersInit`, and the Fetch `Headers` constructor stringifies every value, so
// `origin: undefined` would arrive as the literal header "undefined" rather than
// dropping it. Tests that need a headerless request build the `Request` directly.
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
    headers: { ...BROWSER_HEADERS, ...opts.headers },
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
