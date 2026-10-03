import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, schema } from "../src/schema.ts";
import { decodeFormFlash, FLASH_PARAM } from "../src/form-fallback.ts";
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
import type { DispatchContext } from "../src/types.d.ts";
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

    it("should reject with a 400 when a declared JSON body does not parse", async () => {
      // This used to resolve as `text/plain` with the raw string, silently
      // handing a JSON-declared function a string and answering 200. A
      // malformed body is a client error — Express (`entity.parse.failed`),
      // Fastify (`FST_ERR_CTP_INVALID_JSON_BODY`), koa-bodyparser and h3's own
      // readBody all answer 400 here.
      const ctx = makeKoaCtx({
        headers: { "content-type": "application/json" },
      });
      simulateKoaBody(ctx, "not json");
      await expect(readBody(ctx)).rejects.toMatchObject({ status: 400 });
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
        middlewares: vi.fn((_req: any, res: any, cb: any) => {
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
        middlewares: vi.fn((_req: any, _res: any, cb: any) => {
          cb();
        }),
      };
      attachVite(app as any, vite as unknown as ViteDevServer);
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
        middlewares: vi.fn((_req: any, res: any, cb: any) => {
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
    simulateKoaBody(ctx, JSON.stringify(["a"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a");
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

  it("should return 400 when GET ?args= is not valid JSON", async () => {
    // A malformed request, not a server fault.
    const fn = vi.fn();
    createServerFunction("koa-malformed-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: `/__rpc/koa-malformed-args?args=${encodeURIComponent("not json")}`,
      method: "GET",
    });
    await mw(ctx, makeKoaNext());
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({ error: "Bad Request" });
  });

  it("should answer 400 end to end for a malformed JSON body", async () => {
    // A malformed request is a client error; it used to be answered 200 with
    // the raw string handed to a JSON-declared function.
    const fn = vi.fn();
    createServerFunction("koa-malformed", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-malformed",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, "{not json");
    await mw(ctx, makeKoaNext());
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
    // The input slot is always passed explicitly, so an empty wire array
    // arrives as `undefined` — the same shape a direct `fn()` call has.
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
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

  it("should pass requests whose Origin matches the configured origin (single string, back-compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "content-type": "application/json",
      },
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });

  it("should return 403 when Origin is absent and Sec-Fetch-Site is cross-site", async () => {
    createServerFunction("koa-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { origin: undefined, "sec-fetch-site": "cross-site" },
    });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(403);
    expect(ctx.body).toEqual({ error: "Forbidden" });
  });

  it("should pass when Origin is absent and Sec-Fetch-Site is same-origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: {
        origin: undefined,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });

  it("default policy rejects a cross-origin request with no options at all", async () => {
    // Proves the secure default is wired through this adapter, not merely
    // implemented in the shared helper. Creating the middleware with no options
    // must already be protected.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { origin: "https://evil.com", "sec-fetch-site": "cross-site" },
    });
    await mw(ctx, makeKoaNext());
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.status).toBe(403);
    expect(ctx.body).toEqual({ error: "Forbidden" });
  });

  it("default policy admits the server's own host, comparing host only", async () => {
    // `http://` against the fixture's `Host` proves the scheme is not part of
    // the comparison, so a TLS-terminating proxy needs no configuration.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { origin: "http://app.example.com" },
    });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, makeKoaNext());
    expect(fn).toHaveBeenCalled();
    expect(ctx.status).toBe(200);
  });

  it("sibling subdomain survives: allowlisted Origin + same-site passes", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "sec-fetch-site": "same-site",
        "content-type": "application/json",
      },
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });

  it("should pass requests whose Origin matches one entry of an allowlist array", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "content-type": "application/json",
      },
    });
    const next = makeKoaNext();
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(ctx.status).toBe(200);
  });

  it("should return 403 when Origin matches no entry of an allowlist array", async () => {
    createServerFunction("koa-fn", vi.fn());
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
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

  it('should return 403 for Origin: "null" when an allowlist is set', async () => {
    createServerFunction("koa-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: ["https://app.example.com"] });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-fn",
      method: "POST",
      headers: { origin: "null" },
    });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(403);
    expect(ctx.body).toEqual({ error: "Forbidden" });
  });

  it("validates the input against the function schema before dispatch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("validated", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
      hint: "a single function-wide hint",
    });
    const mw = createRPCMiddleware({ allowHeaderless: true });
    const ok = makeKoaCtx({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ok, JSON.stringify({ email: "a@b.c" }));
    await mw(ok, makeKoaNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      email: "a@b.c",
    });
    expect(ok.status).toBe(200);

    const bad = makeKoaCtx({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(bad, JSON.stringify({ email: 5 }));
    await mw(bad, makeKoaNext());
    expect(bad.status).toBe(422);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((bad.body as { hint?: string }).hint).toMatch(
      /^a single function-wide hint — .*wiki\/server-functions\.md#input-validation$/,
    );

    // Without a function-wide hint, the pointer stands alone.
    createServerFunction("validated", vi.fn(), {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const plain = makeKoaCtx({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(plain, JSON.stringify({ email: 5 }));
    await mw(plain, makeKoaNext());
    expect((plain.body as { hint?: string }).hint).toBe(
      "input did not match the function's schema; see wiki/server-functions.md#input-validation",
    );
  });

  it("answers a JSON array body with 400 because it is an argument list, not one array argument", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("array-payload", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const mw = createRPCMiddleware({ allowHeaderless: true });
    const ctx = makeKoaCtx({
      url: "/__rpc/array-payload",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, JSON.stringify([[1, 2]]));
    await mw(ctx, makeKoaNext());
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({ error: "Bad Request" });
  });
});

/* ─── onDispatch ────────────────────────────────────────────────────────────
 * koa writes `ctx.status` / `ctx.body` and returns nothing, so the wrapper reads
 * the status off the context and merges the id into `ctx.body`. Same record as
 * the other four: the rule lives in `dispatchRequest`.
 */

describe("koa onDispatch", () => {
  const seen: DispatchContext[] = [];

  const mw = (options: Record<string, unknown> = {}) =>
    createRPCMiddleware({
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
      ...options,
    });

  beforeEach(() => {
    serverFunctionsMap.clear();
    seen.length = 0;
  });

  const go = async (
    path: string,
    body: unknown = [],
    headers: Record<string, string> = {},
  ) => {
    const ctx = makeKoaCtx({
      url: path,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    });
    simulateKoaBody(ctx, JSON.stringify(body));
    await mw()(ctx, makeKoaNext());
    return { status: ctx.status, body: ctx.body as Record<string, unknown> };
  };

  it("records a successful dispatch", async () => {
    createServerFunction("koa-ok", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/koa-ok", ["x"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prefix: "__rpc",
      functionName: "koa-ok",
      method: "POST",
      declaredMethod: "POST",
      declaredContentType: "application/json",
      contentTypeMatched: true,
      status: 200,
      outcome: "ok",
    });
  });

  it("shapes the args and never records a value", async () => {
    createServerFunction("koa-shape", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/koa-shape", [{ a: 1, password: "correct-horse" }]);
    expect(seen[0].argShape).toBe("[{a:number,password:string}]");
    expect(JSON.stringify(seen[0])).not.toContain("correct-horse");
  });

  it("records the 404 and lists the sibling names", async () => {
    createServerFunction("koa-known", vi.fn().mockResolvedValue("ok"));
    const { status } = await go("/__rpc/nope");
    expect(status).toBe(404);
    expect(seen[0]).toMatchObject({
      functionName: "nope",
      status: 404,
      outcome: "client-error",
    });
    expect(seen[0].registeredNames).toContain("koa-known");
  });

  it("records the origin rejection, which is also before the try", async () => {
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-ok",
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    await mw()(ctx, makeKoaNext());
    expect(ctx.status).toBe(403);
    expect(seen[0]).toMatchObject({ status: 403, originTier: "origin" });
  });

  it("records a thrown handler as a server error", async () => {
    createServerFunction("koa-boom", vi.fn().mockRejectedValue(new Error("b")));
    const { status } = await go("/__rpc/koa-boom");
    expect(status).toBe(500);
    expect(seen[0]).toMatchObject({
      status: 500,
      outcome: "server-error",
    });
    expect(seen[0].error?.isRPCError).toBe(false);
  });

  it("merges the id into ctx.body on a failure, and the record agrees", async () => {
    const { body } = await go("/__rpc/nope");
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0].id).toBe(body.id);
  });

  it("leaves a success body alone", async () => {
    createServerFunction("koa-ok2", vi.fn().mockResolvedValue("ok"));
    const { body } = await go("/__rpc/koa-ok2");
    expect(body).toEqual({ data: "ok" });
  });

  it("dispatches normally with no hook registered", async () => {
    // The `if (emit)` guards in the body all take their false arm here, which no
    // other test reaches: the other no-hook test is a 404, and it returns before
    // the dispatch.
    createServerFunction("koa-nohook", vi.fn().mockResolvedValue("ok"));
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-nohook",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, "[]");
    await createRPCMiddleware()(ctx, makeKoaNext());
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "ok" });
  });

  it("leaves the body alone with no hook registered", async () => {
    seedServerMap();
    const ctx = makeKoaCtx({
      url: "/__rpc/noSuchFn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, "[]");
    await createRPCMiddleware()(ctx, makeKoaNext());
    expect(ctx.body).toEqual({ error: "Function not found" });
  });

  it("records a malformed ?args= on a GET function", async () => {
    // A malformed query is a malformed request, answered 400 — and it returns
    // before the dispatch try block, so it is a separate exit path.
    createServerFunction("koa-get", vi.fn().mockResolvedValue("ok"), {
      method: "GET",
    });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-get?args=notjson",
      method: "GET",
    });
    await mw()(ctx, makeKoaNext());
    expect(ctx.status).toBe(400);
    expect(seen[0]).toMatchObject({ status: 400, outcome: "client-error" });
  });

  it("records a non-array ?args= on a GET function", async () => {
    createServerFunction("koa-get2", vi.fn().mockResolvedValue("ok"), {
      method: "GET",
    });
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-get2?args=%7B%22a%22%3A1%7D",
      method: "GET",
    });
    await mw()(ctx, makeKoaNext());
    expect(ctx.status).toBe(400);
  });

  it("records a GET function called with no ?args= at all", async () => {
    // The `if (raw)` false path: no query, so `args` stays empty and the
    // handler is called with none. Every other GET test here passes `?args=`.
    const handler = vi.fn().mockResolvedValue("ok");
    createServerFunction("koa-noargs", handler, { method: "GET" });
    const ctx = makeKoaCtx({ url: "/__rpc/koa-noargs", method: "GET" });
    await mw()(ctx, makeKoaNext());
    expect(ctx.status).toBe(200);
    expect(seen[0]).toMatchObject({
      functionName: "koa-noargs",
      status: 200,
      argShape: "[]",
    });
  });

  it("falls back to the default contentType for a hand-registered entry", async () => {
    // `serverFunction.options?.contentType` — the optional chain, not just the
    // `??`. Reached only by an entry registered without options, which is what a
    // hand-registered or lazily-scanned entry can look like.
    serverFunctionsMap.set("no-options", {
      handler: (async () => "bare") as never,
    } as never);
    const ctx = makeKoaCtx({
      url: "/__rpc/no-options",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, "[]");
    await mw()(ctx, makeKoaNext());
    expect(ctx.status).toBe(200);
    expect(seen[0]).toMatchObject({ declaredContentType: "application/json" });
  });

  it("does not take down the request when the hook throws", async () => {
    createServerFunction("koa-throw", vi.fn().mockResolvedValue("ok"));
    const ctx = makeKoaCtx({
      url: "/__rpc/koa-throw",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateKoaBody(ctx, "[]");
    await createRPCMiddleware({
      onDispatch: () => {
        throw new Error("log exploded");
      },
    })(ctx, makeKoaNext());
    expect(ctx.status).toBe(200);
  });
});

describe("Koa no-JS form fallback (dispatch)", () => {
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
    const c = makeKoaCtx({
      url: "/__rpc/contact",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept },
    });
    simulateKoaBody(c, BODIES[kind]);
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
    await mw(ctx as never, makeKoaNext());
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/contact",
    );
    const flash = decodeFormFlash(
      new URL(ctx.redirect.mock.calls[0]?.[0] as string, "http://localhost")
        .searchParams.get(FLASH_PARAM)!,
    );
    expect(flash!.errors?.age).toBeDefined();
    expect(ctx.status).not.toBe(422);
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
    await mw(ctx as never, makeKoaNext());
    expect(ctx.status).toBe(422);
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toBe(null);
  });

  it("redirects a successful navigation to the author's target", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      fallback: "/thanks",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("ok");
    await mw(ctx as never, makeKoaNext());
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/thanks",
    );
    // A success carries no failure to report, so no flash at all.
    expect(
      new URL(ctx.redirect.mock.calls[0]?.[0] as string, "http://localhost")
        .searchParams.get(FLASH_PARAM),
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
    await mw(ctx as never, makeKoaNext());
    expect(ctx.status).toBe(500);
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toBe(null);
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
    await mw(ctx as never, makeKoaNext());
    const url = new URL(
      ctx.redirect.mock.calls[0]?.[0] as string,
      "http://localhost",
    );
    const flash = decodeFormFlash(url.searchParams.get(FLASH_PARAM)!);
    expect(flash!.values).toEqual({ note: "hello" });
    expect(url.search).not.toContain("nope");
  });

  it("does not redirect when the function sets no fallback", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad");
    await mw(ctx as never, makeKoaNext());
    expect(ctx.status).toBe(422);
  });
});

describe("Koa staged response headers (RequestEvent.header)", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
    seedServerMap();
  });

  // The staged write happens before/alongside the redirect, never instead of
  // it: the header rides the fallback's 303 rather than replacing it. Koa
  // flushes after the middleware chain, so there is no commit guard to test.
  it("writes a staged header into the response bag and still redirects a successful native form", async () => {
    createServerFunction(
      "cookie-form",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("Set-Cookie", "sid=1");
        return "sent";
      }),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        fallback: "/thanks",
      },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/cookie-form",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    });
    simulateKoaBody(ctx, "email=a%40b.c");
    await mw(ctx as never, makeKoaNext());

    expect(ctx.set).toHaveBeenCalledWith("Set-Cookie", "sid=1");
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/thanks",
    );
    expect(ctx.set.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.redirect.mock.invocationCallOrder[0],
    );
  });

  it("carries a staged header on the default JSON response", async () => {
    createServerFunction(
      "cookie-json",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("X-Staged", "yes");
        return "hello koa";
      }),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/cookie-json", method: "POST" });
    simulateKoaBody(ctx, JSON.stringify([]));
    await mw(ctx as never, makeKoaNext());

    expect(ctx.set).toHaveBeenCalledWith("X-Staged", "yes");
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "hello koa" });
  });

  it("writes a staged array as one header line per element", async () => {
    createServerFunction(
      "cookie-multi",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("Set-Cookie", ["sid=1", "theme=dark"]);
        return "sent";
      }),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        fallback: "/thanks",
      },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/cookie-multi",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    });
    simulateKoaBody(ctx, "email=a%40b.c");
    await mw(ctx as never, makeKoaNext());

    expect(ctx.set).toHaveBeenCalledWith("Set-Cookie", ["sid=1", "theme=dark"]);
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/thanks",
    );
  });

  it("sets nothing for an empty staged array", async () => {
    createServerFunction(
      "cookie-empty",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("X-Empty", []);
        return "sent";
      }),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        fallback: "/thanks",
      },
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({
      url: "/__rpc/cookie-empty",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    });
    simulateKoaBody(ctx, "email=a%40b.c");
    await mw(ctx as never, makeKoaNext());

    expect(ctx.set).not.toHaveBeenCalledWith("X-Empty", expect.anything());
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/thanks",
    );
  });
});
