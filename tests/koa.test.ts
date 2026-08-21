import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";
// import type { ServerFnEntry } from "../src";
import {
  getFunctionsForPrefix,
  serverFunctionsByPrefix,
  serverFunctionsMap,
} from "../src/functionsMap.ts";
import {
  getRequestContext,
  redirect as serverRedirect,
} from "../src/context.ts";
import {
  attachRPC,
  attachVite,
  readBody,
  redirect,
} from "../src/koa/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/koa/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import {
  makeKoaCtx,
  makeKoaNext,
  seedServerMap,
  simulateKoaBody,
} from "./fixtures/koa.ts";

beforeEach(() => {
  for (const map of serverFunctionsByPrefix.values()) {
    map.clear();
  }
  seedServerMap();
});

// ─── Koa Helpers ──────────────────────────────────────────────────────

describe("Koa helpers", () => {
  describe("readBody", () => {
    it("should parse JSON body", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      simulateKoaBody(ctx, JSON.stringify({ hello: "world" }));
      const result = await readBody(ctx);
      expect(result.contentType).toBe("application/json");
      expect(result.data).toEqual({ hello: "world" });
    });

    it("should read text/plain body", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "text/plain" },
      });
      simulateKoaBody(ctx, "plain text");
      const result = await readBody(ctx);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("plain text");
    });

    it("should fallback to text for invalid JSON with json content-type", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      simulateKoaBody(ctx, "not json");
      const result = await readBody(ctx);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("not json");
    });

    it("should fallback to text/plain for JSON body with empty content-type header", async () => {
      const ctx = makeKoaCtx();
      simulateKoaBody(ctx, "hello world");
      const result = await readBody(ctx);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("hello world");
    });

    it("should reject on stream error", async () => {
      const ctx = makeKoaCtx();
      const p = readBody(ctx);
      process.nextTick(() =>
        ctx.req.emit("error", new Error("koa stream fail"))
      );
      await expect(p).rejects.toThrow("koa stream fail");
    });

    it("should use pre-parsed JSON body from koa-body middleware", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      ctx.request.body = { hello: "world" };

      const result = await readBody(ctx);
      expect(result).toEqual({
        contentType: "application/json",
        data: { hello: "world" },
      });
    });

    it("should use pre-parsed text body from koa-body middleware", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "text/plain" },
      });
      ctx.request.body = "plain text body";

      const result = await readBody(ctx);
      expect(result).toEqual({
        contentType: "text/plain",
        data: "plain text body",
      });
    });

    it("should not register stream listeners when body is pre-parsed", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      ctx.request.body = { data: 42 };

      const onSpy = vi.spyOn(ctx.req, "on");
      const result = await readBody(ctx);
      expect(result).toEqual({
        contentType: "application/json",
        data: { data: 42 },
      });
      expect(onSpy).not.toHaveBeenCalled();
    });

    it("should use pre-parsed multipart body from koa-body middleware", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
      });
      ctx.request.body = { name: "artae", file: "data" };

      const result = await readBody(ctx);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { name: "artae", file: "data" },
      });
    });

    it("should return raw stream data for multipart when no parser ran", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
      });
      const p = readBody(ctx);
      simulateKoaBody(
        ctx,
        '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
      );
      const result = await p;
      expect(result.contentType).toBe("multipart/form-data");
      expect(result.data).toEqual({
        raw: expect.stringContaining('name="a"'),
      });
    });

    it("should use pre-parsed urlencoded body from koa-body middleware", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      ctx.request.body = { name: "artae", job: "developer" };

      const result = await readBody(ctx);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });

    it("should parse urlencoded body from the raw stream", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const p = readBody(ctx);
      simulateKoaBody(ctx, "name=artae&job=developer");
      const result = await p;
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });

    it("should fall through to raw stream when body is undefined", async () => {
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      ctx.request.body = undefined;

      const p = readBody(ctx);
      simulateKoaBody(ctx, '{"from":"stream"}');
      const result = await p;
      expect(result).toEqual({
        contentType: "application/json",
        data: { from: "stream" },
      });
    });
  });

  describe("redirect", () => {
    it("should call ctx.redirect and set status AFTER (koajs/koa#857)", () => {
      const ctx: any = { redirect: vi.fn(), status: 200 };
      redirect(ctx, "/target", 303);
      expect(ctx.redirect).toHaveBeenCalledWith("/target");
      expect(ctx.status).toBe(303);
    });

    it("should default to 303 See Other", () => {
      const ctx: any = { redirect: vi.fn(), status: 200 };
      redirect(ctx, "/target");
      expect(ctx.status).toBe(303);
    });
  });

  describe("attachRPC", () => {
    it("should call app.use with middleware", async () => {
      seedServerMap();
      const middleware = createRPCMiddleware();
      const app = { use: vi.fn() };
      app.use(middleware as any);
      expect(app.use).toHaveBeenCalledOnce();
      expect(app.use).toHaveBeenCalledWith(expect.any(Function));
    });

    it("should call loadRPCConfig and register middleware", async () => {
      const app = { use: vi.fn() };
      await attachRPC(app as any);
      expect(app.use).toHaveBeenCalledOnce();
    });

    it("should skip scan when map already populated (attachRPC)", async () => {
      serverFunctionsMap.set("test", {
        name: "test",
        handler: vi.fn() as never,
      });
      const app = { use: vi.fn() };
      await attachRPC(app as any);
      expect(app.use).toHaveBeenCalledOnce();
    });
  });

  describe("attachVite", () => {
    it("should register vite middleware wrapper", async () => {
      const app: any = { use: vi.fn() };
      const vite: any = {
        middlewares: vi.fn((_req: any, _res: any, cb: any) => cb()),
      };
      await attachVite(app as any, vite as unknown as ViteDevServer);
      expect(app.use).toHaveBeenCalledTimes(1);
      expect(typeof app.use.mock.calls[0][0]).toBe("function");
    });

    it("should call vite.middlewares and skip next() when handled", async () => {
      const nextSpy = vi.fn().mockResolvedValue(undefined);
      const app: any = { use: vi.fn() };
      const vite = {
        middlewares: vi.fn((req: any, res: any, cb: any) => {
          res.end("some content");
          cb();
        }),
      };
      await attachVite(app as any, vite as unknown as ViteDevServer);
      const middlewareFn = app.use.mock.calls[0][0];
      const ctx = {
        req: new EventEmitter(),
        res: { end: vi.fn(), statusCode: 200 },
        url: "/vite-asset.js",
      };
      await middlewareFn(ctx, nextSpy);
      expect(vite.middlewares).toHaveBeenCalledWith(
        ctx.req,
        ctx.res,
        expect.any(Function),
      );
      expect(nextSpy).not.toHaveBeenCalled();
    });

    it("should forward ctx.request.body to req.body", async () => {
      const nextSpy = vi.fn().mockResolvedValue(undefined);
      const app: any = { use: vi.fn() };
      const vite = {
        middlewares: vi.fn((req: any, _res: any, cb: any) => {
          cb();
        }),
      };
      await attachVite(app as any, vite as unknown as ViteDevServer);
      const middlewareFn = app.use.mock.calls[0][0];
      const req = new EventEmitter() as any;
      const ctx = {
        req,
        request: { body: { foo: "bar" } },
        res: { end: vi.fn(), statusCode: 200 },
        url: "/vite-asset.js",
      };
      await middlewareFn(ctx, nextSpy);
      expect(req.body).toEqual({ foo: "bar" });
    });

    it("should call next() when vite returns 404", async () => {
      const nextSpy = vi.fn().mockResolvedValue(undefined);
      const app: any = { use: vi.fn() };
      const vite = {
        middlewares: vi.fn((req: any, res: any, cb: any) => {
          res.statusCode = 404;
          res.end();
          cb();
        }),
      };
      await attachVite(app as any, vite as unknown as ViteDevServer);
      const middlewareFn = app.use.mock.calls[0][0];
      const ctx = {
        req: new EventEmitter(),
        res: { end: vi.fn(), statusCode: 200 },
        url: "/nonexistent.js",
      };
      await middlewareFn(ctx, nextSpy);
      expect(nextSpy).toHaveBeenCalledOnce();
    });

    it("should skip scan when map already populated (attachVite)", async () => {
      serverFunctionsMap.set("test", {
        name: "test",
        handler: vi.fn() as never,
      });
      const app: any = { use: vi.fn() };
      const vite: any = {
        middlewares: vi.fn((_req: any, _res: any, cb: any) => cb()),
      };
      await attachVite(app as any, vite as unknown as ViteDevServer);
      expect(app.use).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Koa createMiddleware ─────────────────────────────────────────────

describe("Koa createMiddleware", () => {
  beforeEach(() => {
    seedServerMap();
  });

  it("should scan for server files when map is empty", async () => {
    serverFunctionsMap.clear();
    const handler = vi.fn();
    const mw = createMiddleware({ handler, rpcPrefix: "__A_server" });
    const ctx = makeKoaCtx({ url: "/__A_server/testFn" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should return a function with auto-generated name", async () => {
    const mw = createMiddleware({ handler: vi.fn() });
    expect(typeof mw).toBe("function");
    expect(mw.name).toMatch(/^viteRPCMiddleware-/);
  });

  it("should use provided name", async () => {
    const mw = createMiddleware({ name: "koa-mw", handler: vi.fn() });
    expect(mw.name).toBe("koa-mw");
  });

  it("should throw on duplicate name", async () => {
    createMiddleware({ name: "koa-dup", handler: vi.fn() });
    expect(() => createMiddleware({ name: "koa-dup", handler: vi.fn() }))
      .toThrow("koa-dup");
  });

  it("should call next() when no handler provided", async () => {
    const mw = createMiddleware();
    const ctx = makeKoaCtx();
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("should call handler when path matches (string)", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const ctx = makeKoaCtx({ url: "/api/test" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should call next() on string path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const ctx = makeKoaCtx({ url: "/other/path" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by RegExp", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const ctx = makeKoaCtx({ url: "/v2/users" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip on RegExp path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const ctx = makeKoaCtx({ url: "/api/users" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by rpcPrefix match", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const ctx = makeKoaCtx({ url: "/__rpc/hello" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip when rpcPrefix mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const ctx = makeKoaCtx({ url: "/other/path" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const ctx = makeKoaCtx({ url: "/__rpc-evil/hello" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should strip query string from URL", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const ctx = makeKoaCtx({ url: "/__rpc/hello?auth=token" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── Koa createRPCMiddleware ──────────────────────────────────────────

describe("Koa createRPCMiddleware", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/noSuchFn" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(404);
    expect(ctx.body).toEqual({
      error: "Function not found",
    });
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction(
      "koa-hello",
      vi.fn().mockResolvedValue("hello koa"),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-hello", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["arg1"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "hello koa" });
  });

  it("should use default prefix when rpcPrefix is undefined", async () => {
    createServerFunction(
      "koa-hello",
      vi.fn().mockResolvedValue("hello koa"),
    );
    const mw = createRPCMiddleware({ rpcPrefix: undefined });
    const ctx = makeKoaCtx({ url: "/__rpc/koa-hello", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["arg1"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "hello koa" });
  });

  it("should expose request context to server functions", async () => {
    let seenLocals: unknown;
    createServerFunction(
      "koa-context",
      vi.fn().mockImplementation(async (_signal: AbortSignal) => {
        seenLocals = getRequestContext().locals;
        getRequestContext().locals.user = "alice";
        return (getRequestContext().locals as { user: string }).user;
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-context", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify([]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "alice" });
    expect(seenLocals).toBe(ctx.state);
  });

  it("should skip the JSON send when the function redirects", async () => {
    createServerFunction(
      "koa-redirect",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-redirect", method: "POST" });
    ctx.redirect = vi.fn();
    simulateKoaBody(ctx, JSON.stringify([]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.redirect).toHaveBeenCalledWith("/login");
    expect(ctx.status).toBe(303);
    expect(ctx.body).toBeUndefined();
  });

  it("should short-circuit with send status, body and headers", async () => {
    createServerFunction(
      "koa-send",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-send", method: "POST" });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify([]));
    await mw(ctx, next);
    expect(ctx.status).toBe(429);
    expect(ctx.body).toEqual({ error: "Rate limit exceeded" });
    expect(ctx.set).toHaveBeenCalledWith("retry-after", "30");
  });

  it("should short-circuit with send without headers", async () => {
    createServerFunction(
      "koa-send-no-headers",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send(204, null);
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-send-no-headers",
      method: "POST",
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify([]));
    await mw(ctx, next);
    expect(ctx.status).toBe(204);
    expect(ctx.body).toBeNull();
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it("should expose functionName via the request context", async () => {
    let seenName: string | undefined;
    createServerFunction(
      "koa-context-send",
      vi.fn().mockImplementation(async () => {
        seenName = getRequestContext().functionName;
        return "ok";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-context-send",
      method: "POST",
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify([]));
    await mw(ctx, next);
    expect(seenName).toBe("koa-context-send");
  });

  it("should use default 303 when redirect is called without a status", async () => {
    createServerFunction(
      "koa-redirect-default",
      vi.fn().mockImplementation(async () => {
        getRequestContext().redirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-redirect-default",
      method: "POST",
    });
    ctx.redirect = vi.fn();
    simulateKoaBody(ctx, JSON.stringify([]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.redirect).toHaveBeenCalledWith("/login");
    expect(ctx.status).toBe(303);
  });

  it("should wrap non-array JSON body in array for the handler", async () => {
    getFunctionsForPrefix("__A_server").set("testFn", {
      name: "testFn",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("ok"),
        cancel: vi.fn(),
      }),
    });
    const mw = createRPCMiddleware({ rpcPrefix: "__A_server" });
    const ctx = makeKoaCtx({
      url: "/__A_server/testFn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const next = makeKoaNext();
    process.nextTick(() => {
      ctx.req.emit("data", Buffer.from(JSON.stringify({ key: "value" })));
      ctx.req.emit("end");
    });
    await mw(ctx, next);
    const handler = getFunctionsForPrefix("__A_server").get("testFn")!.handler;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("should pass args from JSON body", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/echoFn", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["a", "b"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("jsonFn", vi.fn().mockResolvedValue("ok"));
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/jsonFn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    simulateKoaBody(ctx, "name=artae");
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(415);
    expect(ctx.body).toEqual({ error: "Unsupported Media Type" });
  });

  it("should return 415 when text-declared function gets json body", async () => {
    createServerFunction(
      "textFn",
      vi.fn().mockResolvedValue("ok"),
      { contentType: "text/plain" },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/textFn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, JSON.stringify(["hello"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(415);
    expect(ctx.body).toEqual({ error: "Unsupported Media Type" });
  });

  it("should accept urlencoded body for multipart-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "mpFn",
      fn,
      { contentType: "multipart/form-data" },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/mpFn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    simulateKoaBody(ctx, "name=artae");
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
    });
    expect(ctx.status).toBe(200);
  });

  it("should accept multipart body for urlencoded-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "urlFn",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/urlFn",
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
    });
    simulateKoaBody(
      ctx,
      '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
    );
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      raw: expect.stringContaining('name="a"'),
    });
    expect(ctx.status).toBe(200);
  });

  it("should exempt requests without a Content-Type header (curl compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("noHeaderFn", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/noHeaderFn", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });

  it("should cancel on request close", async () => {
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
    const ctx = makeKoaCtx({ url: "/__rpc/cancelFn", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    const next = makeKoaNext();
    const mwPromise = mw(ctx, next);
    setTimeout(() => ctx.req.emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
    expect(ctx.status).toBe(200);
  });

  it("should return 500 on handler error", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("koa oops")),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/errFn", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(500);
    expect(ctx.body).toEqual({ error: "Internal Server Error" });
    process.env.NODE_ENV = prevEnv;
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const mw = createRPCMiddleware({ rpcPrefix: "rpc" });
    const ctx = makeKoaCtx({ url: "/other/path" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("koa-get-only", vi.fn());
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-get-only", method: "GET" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(405);
    expect(ctx.body).toEqual({ error: "Method Not Allowed" });
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("koa-public");
    createServerFunction("koa-public", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: `/__rpc/koa-public?args=${
        encodeURIComponent(
          JSON.stringify(["news"]),
        )
      }`,
      method: "GET",
    });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "koa-public" });
  });

  it("should return 400 when GET ?args= is not a JSON array", async () => {
    const fn = vi.fn();
    createServerFunction("koa-public-bad-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: `/__rpc/koa-public-bad-args?args=${encodeURIComponent('{"a":1}')}`,
      method: "GET",
    });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({ error: "Bad Request" });
  });

  it("should dispatch GET functions without args query param", async () => {
    const fn = vi.fn().mockResolvedValue("no-args");
    createServerFunction("koa-bare-get", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/koa-bare-get", method: "GET" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "no-args" });
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("koa-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(403);
    expect(ctx.body).toEqual({ error: "Forbidden" });
  });

  it("should pass requests without an Origin header when origin is set", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });
});
