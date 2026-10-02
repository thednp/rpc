import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, schema } from "../src/schema.ts";
import { decodeFormFlash, FLASH_PARAM } from "../src/form-fallback.ts";
import EventEmitter from "node:events";
import { bodyLimit, H3, H3Error } from "h3";
import type { H3Event } from "h3";
import type { ViteDevServer } from "vite";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import {
  getRequestContext,
  redirect as serverRedirect,
  sendResponse,
} from "../src/context.ts";
import {
  attachRPC,
  attachVite,
  readBody,
  redirect,
  viteMiddleware,
} from "../src/h3/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/h3/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import { makeH3Event, makeH3Next, seedServerMap } from "./fixtures/h3.ts";
import type { DispatchContext } from "../src/types.d.ts";

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

const APP_HOST = "http://localhost";

/**
 * Builds a request against this test app with the headers the origin policy
 * needs. A native `Request` cannot carry `Host` (forbidden header name), so the
 * explicit `origin` allowlist configured on these middlewares is what admits the
 * request — see the note on `postJSON`.
 */
const appRequest = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { origin: APP_HOST, ...(init.headers as Record<string, string>) },
  });

const postJSON = (path: string, body: unknown) =>
  appRequest(`${APP_HOST}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ─── h3 Helpers ──────────────────────────────────────────────────────

describe("h3 helpers", () => {
  describe("readBody", () => {
    it("should parse JSON via event.req.text()", async () => {
      const event = makeH3Event({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      const result = await readBody(event);
      expect(result.contentType).toBe("application/json");
      expect(result.data).toEqual({ hello: "world" });
    });

    it("should sniff a body with no Content-Type as JSON when it parses", async () => {
      // New in 0.4.0. h3 previously returned the raw string here while express,
      // fastify, and koa parsed it — a cross-adapter inconsistency the
      // readBody consolidation surfaced. The lenient sniff is the library's
      // documented behaviour (curl and the nojs form fallback send JSON with no
      // Content-Type), so h3 now matches the other four.
      const event = makeH3Event({ body: '{"hello":"world"}' });
      const result = await readBody(event);
      expect(result.data).toEqual({ hello: "world" });
      // The reported label still reflects the *declared* type, which is absent
      // here — long-standing behaviour, not a consequence of the sniff.
      expect(result.contentType).toBe("text/plain");
    });

    it("should read text via event.req.text()", async () => {
      const event = makeH3Event({ body: "plain text" });
      const result = await readBody(event);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("plain text");
    });

    it("should return urlencoded fields for urlencoded content type", async () => {
      const event = makeH3Event({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=artae&job=developer",
      });
      const result = await readBody(event);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });

    it("should return raw text for multipart bodies", async () => {
      const event = makeH3Event({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
        body: "--xyz--",
      });
      const result = await readBody(event);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { raw: "--xyz--" },
      });
    });
  });

  describe("redirect", () => {
    it("should return an HTTPResponse with Location and default 303", () => {
      const result = redirect("/target");
      expect(result.status).toBe(303);
      expect(result.headers.get("location")).toBe("/target");
    });

    it("should honor a custom status", () => {
      const result = redirect("/target", 307);
      expect(result.status).toBe(307);
      expect(result.headers.get("location")).toBe("/target");
    });
  });

  describe("attachRPC", () => {
    it("should call loadRPCConfig and register middleware", async () => {
      const app = { use: vi.fn() };
      await attachRPC(app as any);
      expect(app.use).toHaveBeenCalledOnce();
    });
  });

  describe("attachVite", () => {
    it("should call app.use with viteMiddleware", async () => {
      const app: any = { use: vi.fn() };
      const vite: any = {};
      attachVite(app as any, vite as ViteDevServer);
      expect(app.use).toHaveBeenCalledOnce();
      expect(typeof app.use.mock.calls[0][0]).toBe("function");
    });
  });

  describe("viteMiddleware", () => {
    it("should capture the body written by the Vite stack (web fallback)", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, _cb: any) => {
          res.setHeader("content-type", "text/html");
          res.end("<h1>app</h1>");
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const event = makeH3Event({ path: "/" });
      const next = makeH3Next();
      const result = await mw(event, next) as {
        status?: number;
        headers?: Headers;
      };
      expect(next).not.toHaveBeenCalled();
      expect(result.headers?.get("content-type")).toBe("text/html");
    });

    it("should call next() when the Vite stack passes through", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, _res: any, cb: any) => cb()),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const event = makeH3Event({ path: "/__rpc/anything" });
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(next).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });

    it("should stop the chain when the Vite stack writes the response (node runtime)", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, _cb: any) => {
          res.end("<h1>node app</h1>");
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const fakeRes = new EventEmitter() as any;
      fakeRes.writableEnded = false;
      fakeRes.headersSent = false;
      fakeRes.statusCode = 200;
      fakeRes.end = vi.fn(() => {
        fakeRes.writableEnded = true;
        fakeRes.emit("finish");
        return fakeRes;
      });
      const event = {
        runtime: { node: { req: {}, res: fakeRes } },
        url: new URL("http://localhost/"),
        req: { method: "GET", headers: new Headers() },
      } as unknown as H3Event;
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(result).toBeInstanceOf(Response);
      expect(next).not.toHaveBeenCalled();
    });

    it("should call next() when the Vite stack passes through (node runtime)", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, _res: any, cb: any) => cb()),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const fakeRes = new EventEmitter() as any;
      fakeRes.writableEnded = false;
      fakeRes.headersSent = false;
      const event = {
        runtime: { node: { req: {}, res: fakeRes } },
        url: new URL("http://localhost/"),
        req: { method: "GET", headers: new Headers() },
      } as unknown as H3Event;
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(next).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });

    it("should stop with an empty response when the response was already written before cb (node runtime)", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, _res: any, cb: any) => cb()),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const fakeRes = new EventEmitter() as any;
      fakeRes.writableEnded = true;
      fakeRes.headersSent = false;
      const event = {
        runtime: { node: { req: {}, res: fakeRes } },
        url: new URL("http://localhost/"),
        req: { method: "GET", headers: new Headers() },
      } as unknown as H3Event;
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(result).toBeInstanceOf(Response);
      expect(next).not.toHaveBeenCalled();
    });

    it("should support writeHead in the web fallback", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, _cb: any) => {
          res.writeHead(200);
          res.setHeader("content-type", "text/html");
          res.end("<h1>app</h1>");
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const event = makeH3Event({ path: "/" });
      const next = makeH3Next();
      const result = await mw(event, next) as { headers?: Headers };
      expect(next).not.toHaveBeenCalled();
      expect(result.headers?.get("content-type")).toBe("text/html");
    });

    it("should ignore cb after end() without a body in the web fallback", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, cb: any) => {
          res.writeHead(200);
          res.end();
          cb();
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const event = makeH3Event({ path: "/" });
      const next = makeH3Next();
      const result = await mw(event, next) as { headers?: Headers };
      expect(next).not.toHaveBeenCalled();
      expect(result.headers).toBeDefined();
    });

    it("should settle only once when the response finishes and cb runs (node runtime)", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, cb: any) => {
          res.end("<h1>node app</h1>");
          cb();
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const fakeRes = new EventEmitter() as any;
      fakeRes.writableEnded = false;
      fakeRes.headersSent = false;
      fakeRes.statusCode = 200;
      fakeRes.end = vi.fn(() => {
        fakeRes.writableEnded = true;
        fakeRes.emit("finish");
        return fakeRes;
      });
      const event = {
        runtime: { node: { req: {}, res: fakeRes } },
        url: new URL("http://localhost/"),
        req: { method: "GET", headers: new Headers() },
      } as unknown as H3Event;
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(result).toBeInstanceOf(Response);
      expect(next).not.toHaveBeenCalled();
    });

    it("should settle when the node response closes", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, res: any, _cb: any) => {
          res.emit("close");
        }),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const fakeRes = new EventEmitter() as any;
      fakeRes.writableEnded = false;
      fakeRes.headersSent = false;
      const event = {
        runtime: { node: { req: {}, res: fakeRes } },
        url: new URL("http://localhost/"),
        req: { method: "GET", headers: new Headers() },
      } as unknown as H3Event;
      const next = makeH3Next();
      const result = await mw(event, next);
      expect(result).toBeInstanceOf(Response);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

// ─── h3 createMiddleware ─────────────────────────────────────────────

describe("h3 createMiddleware", () => {
  beforeEach(() => {
    seedServerMap();
  });

  it("should scan for server files when map is empty", async () => {
    serverFunctionsMap.clear();
    const handler = vi.fn();
    const mw = createMiddleware({ handler, rpcPrefix: "_server" });
    const event = makeH3Event({ path: "/_server/testFn", method: "POST" });
    const next = makeH3Next();
    // scanForServerFiles runs silently (catches ENOENT), then handler is called
    await mw(event, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should return a function with auto-generated name", async () => {
    const mw = createMiddleware({ handler: vi.fn() });
    expect(typeof mw).toBe("function");
    expect(mw.name).toMatch(/^viteRPCMiddleware-/);
  });

  it("should use provided name", async () => {
    const mw = createMiddleware({ name: "h3-mw", handler: vi.fn() });
    expect(mw.name).toBe("h3-mw");
  });

  it("should throw on duplicate name", async () => {
    createMiddleware({ name: "h3-dup", handler: vi.fn() });
    expect(() => createMiddleware({ name: "h3-dup", handler: vi.fn() }))
      .toThrow("h3-dup");
  });

  it("should call next() when no handler provided", async () => {
    const mw = createMiddleware();
    const event = makeH3Event();
    const next = makeH3Next();
    await mw(event, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("should call handler when path matches (string)", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const event = makeH3Event({ path: "/api/test" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should call next() on string path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const event = makeH3Event({ path: "/other" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by RegExp", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const event = makeH3Event({ path: "/v2/users" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip on RegExp path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const event = makeH3Event({ path: "/api/users" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by rpcPrefix match", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "_server", handler });
    const event = makeH3Event({ path: "/_server/hello" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip when rpcPrefix mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "_server", handler });
    const event = makeH3Event({ path: "/other/path" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const event = makeH3Event({ path: "/__rpc-evil/hello" });
    const next = makeH3Next();
    await mw(event, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

// ─── h3 createRPCMiddleware ──────────────────────────────────────────

describe("h3 createRPCMiddleware", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(appRequest(`${APP_HOST}/__rpc/noSuchFn`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Function not found" });
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction(
      "h3-hello",
      vi.fn().mockResolvedValue("hello h3"),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-hello", ["arg1"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "hello h3" });
  });

  it("should surface a 413 when the host body limit trips mid-read", async () => {
    // h3 enforces `bodyLimit` while the request stream is read, so an
    // oversized *chunked* body (no Content-Length to check up front) throws
    // inside the dispatch. The other four adapters get a 413 from their host
    // body parser before rpc runs; h3 must not report it as a 500.
    createServerFunction("h3-hello", vi.fn().mockResolvedValue("hello h3"));
    const app = new H3();
    app.use(bodyLimit(64));
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    // A ReadableStream body has no Content-Length, so this takes the
    // mid-stream path rather than the up-front rejection.
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(["x".repeat(4096)])));
        c.close();
      },
    });
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunked,
        // @ts-expect-error - Node requires this for a streaming request body
        duplex: "half",
      }),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload Too Large" });
  });

  it("should forward a 4xx the handler raises, and fall back to Bad Request", async () => {
    // Covers the non-413 client-error branch and the statusText fallback:
    // a bare H3Error carries no statusText, so the body uses BAD_REQUEST.
    createServerFunction(
      "h3-client-error",
      vi.fn().mockRejectedValue(new H3Error({ status: 400 })),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    const res = await app.fetch(postJSON("/__rpc/h3-client-error", []));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad Request" });
  });

  it("should not forward a 5xx the handler raises", async () => {
    // The 4xx pass-through must not turn a server fault into a bare 5xx body
    // — 5xx still goes through formatError.
    createServerFunction(
      "h3-server-error",
      vi.fn().mockRejectedValue(new H3Error({ status: 503, message: "down" })),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    const res = await app.fetch(postJSON("/__rpc/h3-server-error", []));
    expect(res.status).toBe(500);
  });

  it("should answer 400 for a malformed JSON body", async () => {
    // h3's own readBody throws a 400 here; rpc parses the body itself and used
    // to let the SyntaxError escape the dispatch as a 500.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-malformed", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-malformed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad Request" });
  });

  it("should still report an unexpected handler throw as a 500", async () => {
    // The 4xx pass-through must not swallow genuine server faults.
    createServerFunction(
      "h3-boom",
      vi.fn().mockRejectedValue(new Error("kaboom")),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    const res = await app.fetch(postJSON("/__rpc/h3-boom", []));
    expect(res.status).toBe(500);
  });

  it("should use default prefix when rpcPrefix is undefined", async () => {
    createServerFunction(
      "h3-hello",
      vi.fn().mockResolvedValue("hello h3"),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ rpcPrefix: undefined, origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-hello", ["arg1"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "hello h3" });
  });

  it("should expose request context to server functions", async () => {
    let seenEvent: unknown;
    let seenLocals: unknown;
    createServerFunction(
      "h3-context",
      vi.fn().mockImplementation(async (_signal: AbortSignal) => {
        seenEvent = getRequestContext().nativeEvent;
        seenLocals = getRequestContext().locals;
        return "ok";
      }),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-context", []));
    expect(res.status).toBe(200);
    expect(seenEvent).toBeInstanceOf(Object);
    expect(seenEvent).toEqual(expect.objectContaining({ context: seenLocals }));
    expect(await res.json()).toEqual({ data: "ok" });
  });

  it("should redirect when the function redirects (no JSON data)", async () => {
    createServerFunction(
      "h3-redirect",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/login");
        return "ignored";
      }),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-redirect", []));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const body = await res.text();
    expect(body.includes('"data"')).toBe(false);
  });

  it("should pass args from JSON body to function", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/echoFn", ["a", "b"]));
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("jsonFn", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/jsonFn`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=artae",
      }),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "Unsupported Media Type" });
  });

  it("should return 415 when text-declared function gets json body", async () => {
    createServerFunction(
      "textFn",
      vi.fn().mockResolvedValue("ok"),
      { contentType: "text/plain" },
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/textFn", ["hello"]));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "Unsupported Media Type" });
  });

  it("should accept urlencoded body for multipart-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "mpFn",
      fn,
      { contentType: "multipart/form-data" },
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/mpFn`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=artae",
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
    });
  });

  it("should accept multipart body for urlencoded-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "urlFn",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/urlFn`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
        body:
          '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      raw: expect.stringContaining('name="a"'),
    });
  });

  it("should exempt requests without a Content-Type header (curl compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("noHeaderFn", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    // A Uint8Array request body carries no automatic Content-Type header,
    // simulating clients (curl, native) that send without one.
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/noHeaderFn`, {
        method: "POST",
        body: new TextEncoder().encode("plain"),
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "plain");
  });

  it("should cancel on node request close", async () => {
    let cancelled = false;
    const fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          cancelled = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        );
      });
      return "result";
    });
    createServerFunction("cancelFn", fn);
    const mw = createRPCMiddleware({ origin: APP_HOST });
    const ee = new EventEmitter();
    const event = makeH3Event({
      path: "/__rpc/cancelFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["x"]),
      nodeReq: ee,
    });
    const next = makeH3Next();
    const mwPromise = mw(event, next);
    setTimeout(() => ee.emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
  });

  it("should return 500 on handler error", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("h3 oops")),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/errFn", []));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    process.env.NODE_ENV = prevEnv;
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const app = new H3();
    app.use(createRPCMiddleware({ rpcPrefix: "_sv", origin: APP_HOST }));
    app.use(() => ({ ok: "fallback" }));
    const res = await app.fetch(appRequest(`${APP_HOST}/other/path`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: "fallback" });
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("h3-get-only", vi.fn());
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(appRequest(`${APP_HOST}/__rpc/h3-get-only`));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method Not Allowed" });
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("h3-public");
    createServerFunction("h3-public", fn, { method: "GET" });
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(
        `${APP_HOST}/__rpc/h3-public?args=${
          encodeURIComponent(JSON.stringify(["news"]))
        }`,
      ),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(await res.json()).toEqual({ data: "h3-public" });
  });

  it("should dispatch GET functions without args query param", async () => {
    const fn = vi.fn().mockResolvedValue("no-args");
    createServerFunction("h3-public-no-args", fn, { method: "GET" });
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-public-no-args`),
    );
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "no-args" });
  });

  it("should return 400 when GET ?args= is not a JSON array", async () => {
    const fn = vi.fn();
    createServerFunction("h3-public-bad-args", fn, { method: "GET" });
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(
        `${APP_HOST}/__rpc/h3-public-bad-args?args=${
          encodeURIComponent('{"a":1}')
        }`,
      ),
    );
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad Request" });
  });

  it("should return 400 when GET ?args= is not valid JSON", async () => {
    const fn = vi.fn();
    createServerFunction("h3-malformed-args", fn, { method: "GET" });
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(
        `${APP_HOST}/__rpc/h3-malformed-args?args=${
          encodeURIComponent("not json")
        }`,
      ),
    );
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad Request" });
  });

  it("should dispatch functions registered without options (default POST)", async () => {
    serverFunctionsMap.set("h3-plain", {
      name: "h3-plain",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("plain"),
        cancel: vi.fn(),
      }),
    });
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-plain`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "plain" });
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("h3-fn", vi.fn());
    const app = new H3();
    app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("default policy rejects a cross-origin request with no options at all", async () => {
    // Proves the secure default is wired through this adapter, not merely
    // implemented in the shared helper. Creating the middleware with no options
    // must already be protected.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-fn", fn);
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { origin: "https://evil.com", "sec-fetch-site": "cross-site" },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it("default policy admits the server's own host, comparing host only", async () => {
    // A native `Request` cannot carry `Host`, so the self-origin comparison has
    // nothing to match and this documents the fail-closed result rather than a
    // false pass. The host-only comparison itself is covered in
    // `tests/server-helpers.test.ts` and end-to-end by the other four adapters,
    // whose fixtures can set `Host`.
    const fn = vi.fn();
    createServerFunction("h3-fn", fn);
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { origin: APP_HOST },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a headerless request by default, even with origin configured", async () => {
    // Since 0.4.0 an absent policy is the secure default, not an unchecked
    // endpoint, and a request with no browser provenance headers is refused
    // unless the operator opts in. This is the behaviour change from 0.3.x,
    // where a headerless request always passed.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-fn", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
    const res = await app.fetch(
      // Built directly rather than via `appRequest`: the Fetch `Headers`
      // constructor stringifies every value, so `origin: undefined` would
      // become the literal header "undefined" instead of dropping the header.
      new Request(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it("admits a headerless request when allowHeaderless is enabled", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-fn", fn);
    const app = new H3();
    app.use(
      createRPCMiddleware({
        origin: "https://app.example.com",
        allowHeaderless: true,
      }),
    );
    const res = await app.fetch(
      // Built directly rather than via `appRequest`: the Fetch `Headers`
      // constructor stringifies every value, so `origin: undefined` would
      // become the literal header "undefined" instead of dropping the header.
      new Request(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
  });

  it("should not crash when event.runtime is missing", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-bare", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-bare", ["x"]));
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
  });

  it("should redirect with default 303 when redirect is called without a status", async () => {
    createServerFunction(
      "h3-redirect-default",
      vi.fn().mockImplementation(async () => {
        getRequestContext().redirect("/default-target");
        return "ignored";
      }),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-redirect-default", []));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/default-target");
  });

  it("should short-circuit with sendResponse status, body and headers", async () => {
    createServerFunction(
      "h3-send",
      vi.fn().mockImplementation(async () => {
        sendResponse(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        return "ignored";
      }),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-send", []));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    await expect(res.json()).resolves.toEqual({ error: "Rate limit exceeded" });
  });

  it("should expose functionName and send via the request context", async () => {
    let seenName: string | undefined;
    let seenSend: boolean = false;
    createServerFunction(
      "h3-context-send",
      vi.fn().mockImplementation(async () => {
        const ctx = getRequestContext();
        seenName = ctx.functionName;
        seenSend = typeof ctx.send === "function";
        ctx.send(400, { error: "Bad Request" });
        return "ignored";
      }),
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(postJSON("/__rpc/h3-context-send", []));
    expect(seenName).toBe("h3-context-send");
    expect(seenSend).toBe(true);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Bad Request" });
  });

  it("should wrap non-array JSON body in array for the handler", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-obj-arg", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-obj-arg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      key: "value",
    });
  });

  it("should pass requests whose Origin matches the configured origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-origin-ok", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-origin-ok`, {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
  });

  it("should pass requests whose Origin matches one entry of an allowlist array", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-origin-array", fn);
    const app = new H3();
    app.use(
      createRPCMiddleware({
        origin: ["https://app.example.com", "https://admin.example.com"],
      }),
    );
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-origin-array`, {
        method: "POST",
        headers: {
          origin: "https://admin.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify(["x"]),
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
  });

  it("should return 403 when Origin matches no entry of an allowlist array", async () => {
    createServerFunction("h3-origin-array", vi.fn());
    const app = new H3();
    app.use(
      createRPCMiddleware({
        origin: ["https://app.example.com", "https://admin.example.com"],
      }),
    );
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-origin-array`, {
        method: "POST",
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it('should return 403 for Origin: "null" when an allowlist is set', async () => {
    createServerFunction("h3-origin-null", vi.fn());
    const app = new H3();
    app.use(createRPCMiddleware({ origin: ["https://app.example.com"] }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-origin-null`, {
        method: "POST",
        headers: { origin: "null" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("should pass parsed urlencoded body as single object arg", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "h3-urlencode",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-urlencode`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=artae&job=developer",
      }),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
      job: "developer",
    });
  });

  it("validates the input against the function schema before dispatch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("validated", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const app = new H3();
    // A native Request carries no Host header, so the host-only self-origin
    // comparison has nothing to match — the same allowlist the rest of this
    // suite uses.
    app.use(createRPCMiddleware({ allowHeaderless: true, origin: APP_HOST }));
    const ok = await app.fetch(
      postJSON("/__rpc/validated", { email: "a@b.c" }),
    );
    expect(ok.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      email: "a@b.c",
    });

    const bad = await app.fetch(postJSON("/__rpc/validated", { email: 5 }));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual(
      expect.objectContaining({ error: "Validation failed" }),
    );
    expect(fn).toHaveBeenCalledTimes(1);

    // A function-wide hint leads, and rpc's documentation pointer is kept.
    const hinted = vi.fn();
    createServerFunction("validated", hinted, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
      hint: "a single function-wide hint",
    });
    const hintedRes = await app.fetch(
      postJSON("/__rpc/validated", { email: 5 }),
    );
    expect(hintedRes.status).toBe(422);
    expect((await hintedRes.json()).hint).toMatch(
      /^a single function-wide hint — .*wiki\/server-functions\.md#input-validation$/,
    );
  });

  it("answers a JSON array body with 400 because it is an argument list, not one array argument", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("array-payload", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const app = new H3();
    app.use(createRPCMiddleware({ allowHeaderless: true, origin: APP_HOST }));

    const res = await app.fetch(postJSON("/__rpc/array-payload", [[1, 2]]));
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad Request" });
  });
});

/* ─── onDispatch ────────────────────────────────────────────────────────────
 * h3 reports through `event.res.status` plus a returned body rather than a send
 * function, so it is wrapped rather than intercepted. These assert the wrapper
 * assembled the same record express does — the rule lives in `dispatchRequest`,
 * and the only adapter-specific part is `readStatus`.
 */

describe("h3 onDispatch", () => {
  const seen: DispatchContext[] = [];

  const mw = (options: Record<string, unknown> = {}) =>
    createRPCMiddleware({
      origin: APP_HOST,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
      ...options,
    });

  beforeEach(() => {
    serverFunctionsMap.clear();
    seen.length = 0;
  });

  // `postJSON` already prefixes APP_HOST, so `path` is the pathname only.
  const go = async (path: string, body: unknown = []) => {
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(postJSON(path, body));
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  it("records a successful dispatch", async () => {
    createServerFunction("h3-ok", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/h3-ok", ["x"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prefix: "__rpc",
      functionName: "h3-ok",
      method: "POST",
      declaredMethod: "POST",
      declaredContentType: "application/json",
      contentTypeMatched: true,
      status: 200,
      outcome: "ok",
    });
  });

  it("shapes the args and never records a value", async () => {
    createServerFunction("h3-shape", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/h3-shape", [{ a: 1, password: "correct-horse" }]);
    expect(seen[0].argShape).toBe("[{a:number,password:string}]");
    expect(JSON.stringify(seen[0])).not.toContain("correct-horse");
  });

  it("records the 404, which happens before the dispatch try block", async () => {
    createServerFunction("h3-known", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(appRequest(`${APP_HOST}/__rpc/nope`));
    expect(res.status).toBe(404);
    expect(seen[0]).toMatchObject({
      functionName: "nope",
      status: 404,
      outcome: "client-error",
    });
    // The sibling names, which is what turns "Function not found" into a question
    // an agent can answer. The requested name is not among them — that is the
    // point of listing them.
    expect(seen[0].registeredNames).toContain("h3-known");
    expect(seen[0].registeredNames).not.toContain("nope");
  });

  it("records a 403 from the origin check, which is also before the try", async () => {
    createServerFunction("h3-forbidden", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-forbidden`, {
        headers: { origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
    expect(seen[0]).toMatchObject({ status: 403, originTier: "origin" });
  });

  it("records a declared contentType, not just the default", async () => {
    createServerFunction("h3-text", vi.fn().mockResolvedValue("hi"), {
      contentType: "text/plain",
    });
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-text`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      declaredContentType: "text/plain",
      actualContentType: "text/plain",
      contentTypeMatched: true,
    });
  });

  it("records a request with no Content-Type at all", async () => {
    // The headerless case: the `?? undefined` on the read, and a declared type
    // that still matches because a missing header is exempt by design.
    createServerFunction("h3-nohdr", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/h3-nohdr`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      declaredContentType: "application/json",
      actualContentType: undefined,
      contentTypeMatched: true,
    });
  });

  it("falls back to the default contentType for a hand-registered entry", async () => {
    // `serverFunction.options?.contentType` — the optional chain, not just the
    // `??`. Reached only by registering an entry without options, which is what
    // the lazy scan can produce for a module with no options object.
    serverFunctionsMap.set("no-options", {
      handler: (async () => "bare") as never,
    } as never);
    const app = new H3();
    app.use(mw());
    const res = await app.fetch(postJSON("/__rpc/no-options", []));
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ declaredContentType: "application/json" });
  });

  it("records a thrown handler as a server error", async () => {
    createServerFunction(
      "h3-boom",
      vi.fn().mockRejectedValue(new Error("boom")),
    );
    const { status } = await go("/__rpc/h3-boom", []);
    expect(status).toBe(500);
    expect(seen[0]).toMatchObject({
      status: 500,
      outcome: "server-error",
    });
    expect(seen[0].error?.isRPCError).toBe(false);
  });

  it("puts the correlation id on a failure body and the record agrees with it", async () => {
    const { body } = await go("/__rpc/nope", []);
    expect((body as { id?: string }).id).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0].id).toBe((body as { id?: string }).id);
  });

  it("leaves the body alone with no hook registered", async () => {
    seedServerMap();
    const app = new H3();
    app.use(createRPCMiddleware({ origin: APP_HOST }));
    const res = await app.fetch(appRequest(`${APP_HOST}/__rpc/noSuchFn`));
    expect(await res.json()).toEqual({ error: "Function not found" });
  });

  it("does not take down the request when the hook throws", async () => {
    createServerFunction("h3-throw", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(createRPCMiddleware({
      origin: APP_HOST,
      onDispatch: () => {
        throw new Error("log exploded");
      },
    }));
    const res = await app.fetch(postJSON("/__rpc/h3-throw", []));
    expect(res.status).toBe(200);
  });
});

describe("h3 no-JS form fallback (dispatch)", () => {
  const BODIES: Record<string, string> = {
    bad: "age=nope",
    ok: "age=7",
    replay: "age=nope&note=hello",
  };

  beforeEach(() => {
    serverFunctionsMap.clear();
    seedServerMap();
  });

  const formCtx = (kind: string, accept = "text/html") => {
    const c = makeH3Event({
      path: "/__rpc/contact",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept },
      body: BODIES[kind],
    });
    return c;
  };

  // The load-bearing claim: a rejected *navigation* redirects. It only holds
  // because the fallback branch sits ahead of the client-error branch, which
  // would otherwise claim the ValidationError and answer a 422 JSON body.
  it("redirects a rejected native form instead of answering 422", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
      fallback: "/contact",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad");
    const res = (await mw(ctx as never, makeH3Next())) as Response;
    const location = res?.headers?.get("location") ?? null;
    expect(location).toContain("/contact");
    const flash = decodeFormFlash(
      new URL(location!, "http://localhost").searchParams
        .get(FLASH_PARAM)!,
    );
    expect(flash!.errors?.age).toBeDefined();
    expect(ctx.res.status).not.toBe(422);
  });

  // The other load-bearing claim: the generated stub posts form encodings too,
  // so the discriminator has to be the navigation, not the content type.
  it("leaves a fetch from the client stub on the JSON path", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
      fallback: "/contact",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad", "application/json");
    const res = (await mw(ctx as never, makeH3Next())) as Response;
    const location = res?.headers?.get("location") ?? null;
    expect(ctx.res.status).toBe(422);
    expect(location).toBe(null);
  });

  it("redirects a successful navigation to the author's target", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      fallback: "/thanks",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("ok");
    const res = (await mw(ctx as never, makeH3Next())) as Response;
    const location = res?.headers?.get("location") ?? null;
    expect(location).toContain("/thanks");
    // A success carries no failure to report, so no flash at all.
    expect(
      new URL(location!, "http://localhost").searchParams
        .get(FLASH_PARAM),
    ).toBeNull();
  });

  // A real fault must not be laundered into a friendly redirect.
  it("keeps an unexpected throw a 500 even on a navigation", async () => {
    createServerFunction(
      "contact",
      vi.fn().mockRejectedValue(new Error("boom")),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        fallback: "/contact",
      },
    );
    const mw = createRPCMiddleware();
    const ctx = formCtx("ok");
    const res = (await mw(ctx as never, makeH3Next())) as Response;
    const location = res?.headers?.get("location") ?? null;
    expect(ctx.res.status).toBe(500);
    expect(location).toBe(null);
  });

  it("replays only the fields the author named", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number(), note: field.string() }),
      fallback: { to: "/contact", replay: ["note"] },
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("replay");
    const res = (await mw(ctx as never, makeH3Next())) as Response;
    const location = res?.headers?.get("location") ?? null;
    const url = new URL(location!, "http://localhost");
    const flash = decodeFormFlash(url.searchParams.get(FLASH_PARAM)!);
    expect(flash!.values).toEqual({ note: "hello" });
    expect(url.search).not.toContain("nope");
  });

  // h3 enforces `bodyLimit` while the request stream is being *read*, so an
  // oversized body throws from inside the dispatch `try` — the one adapter that
  // reaches its own `catch` rather than being rejected by a host body parser
  // first. A body does **not** require a `Content-Type`, so this is the path where
  // the catch reads that header as absent; a headerless `curl -T` upload is the
  // real-world shape.
  it("classifies an oversized headerless body without throwing", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      fallback: "/contact",
    });
    const app = new H3();
    app.use(bodyLimit(64));
    app.use(createRPCMiddleware({ origin: APP_HOST }));

    // A ReadableStream body carries no `Content-Length`, so the cap trips
    // mid-read rather than up front.
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("a".repeat(4096)));
        c.close();
      },
    });
    const res = await app.fetch(
      appRequest(`${APP_HOST}/__rpc/contact`, {
        method: "POST",
        // No `content-type` at all.
        headers: { accept: "text/html" },
        body: chunked,
        // @ts-expect-error - Node requires this for a streaming request body
        duplex: "half",
      }),
    );

    // The limit is a client error, so the fallback is not consulted for a flash
    // and no redirect is issued — the dispatch still classifies the failure
    // correctly with every optional header absent.
    expect(res.status).toBe(413);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not redirect when the function sets no fallback", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad");
    await mw(ctx as never, makeH3Next());
    expect(ctx.res.status).toBe(422);
  });
});
