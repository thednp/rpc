import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import { H3 } from "h3";
import type { H3Event } from "h3";
import type { ViteDevServer } from "vite";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import {
  getRequestContext,
  redirect as serverRedirect,
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

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

const APP_HOST = "http://localhost";

const postJSON = (path: string, body: unknown) =>
  new Request(`${APP_HOST}${path}`, {
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
        middlewares: vi.fn((_req: any, res: any, cb: any) => {
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(new Request(`${APP_HOST}/__rpc/noSuchFn`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Function not found" });
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction(
      "h3-hello",
      vi.fn().mockResolvedValue("hello h3"),
    );
    const app = new H3();
    app.use(createRPCMiddleware());
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
    app.use(createRPCMiddleware());
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
    app.use(createRPCMiddleware());
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(postJSON("/__rpc/echoFn", ["a", "b"]));
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("jsonFn", vi.fn().mockResolvedValue("ok"));
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/jsonFn`, {
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
    app.use(createRPCMiddleware());
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/mpFn`, {
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/urlFn`, {
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
    app.use(createRPCMiddleware());
    // A Uint8Array request body carries no automatic Content-Type header,
    // simulating clients (curl, native) that send without one.
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/noHeaderFn`, {
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
    const mw = createRPCMiddleware();
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(postJSON("/__rpc/errFn", []));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    process.env.NODE_ENV = prevEnv;
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const app = new H3();
    app.use(createRPCMiddleware({ rpcPrefix: "_sv" }));
    app.use(() => ({ ok: "fallback" }));
    const res = await app.fetch(new Request(`${APP_HOST}/other/path`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: "fallback" });
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("h3-get-only", vi.fn());
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(new Request(`${APP_HOST}/__rpc/h3-get-only`));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method Not Allowed" });
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("h3-public");
    createServerFunction("h3-public", fn, { method: "GET" });
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(
        `${APP_HOST}/__rpc/h3-public?args=${
          encodeURIComponent(JSON.stringify(["news"]))
        }`,
      ),
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(await res.json()).toEqual({ data: "h3-public" });
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/h3-plain`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "plain" });
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("h3-fn", vi.fn());
    const app = new H3();
    app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/h3-fn`, {
        method: "POST",
        headers: { origin: "https://evil.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("should pass requests without an Origin header when origin is set", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-fn", fn);
    const app = new H3();
    app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
    const res = await app.fetch(postJSON("/__rpc/h3-fn", ["x"]));
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
  });

  it("should not crash when event.runtime is missing", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-bare", fn);
    const app = new H3();
    app.use(createRPCMiddleware());
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
    app.use(createRPCMiddleware());
    const res = await app.fetch(postJSON("/__rpc/h3-redirect-default", []));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/default-target");
  });

  it("should wrap non-array JSON body in array for the handler", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("h3-obj-arg", fn);
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/h3-obj-arg`, {
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
      new Request(`${APP_HOST}/__rpc/h3-origin-ok`, {
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

  it("should pass parsed urlencoded body as single object arg", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "h3-urlencode",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const app = new H3();
    app.use(createRPCMiddleware());
    const res = await app.fetch(
      new Request(`${APP_HOST}/__rpc/h3-urlencode`, {
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
});
