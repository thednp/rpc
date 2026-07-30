import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";
// import type { ServerFnEntry } from "../src";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import { attachRPC, attachVite, readBody } from "../src/koa/helpers.ts";
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
  serverFunctionsMap.clear();
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
    const ctx = makeKoaCtx({ url: "/__rpc/koa-hello" });
    simulateKoaBody(ctx, JSON.stringify(["arg1"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ data: "hello koa" });
  });

  it("should wrap non-array JSON body in array for the handler", async () => {
    serverFunctionsMap.set("testFn", {
      name: "testFn",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("ok"),
        cancel: vi.fn(),
      }),
    });
    const mw = createRPCMiddleware({ rpcPrefix: "__A_server" });
    const ctx = makeKoaCtx({
      url: "/__A_server/testFn",
      headers: { "content-type": "application/json" },
    });
    const next = makeKoaNext();
    process.nextTick(() => {
      ctx.req.emit("data", Buffer.from(JSON.stringify({ key: "value" })));
      ctx.req.emit("end");
    });
    await mw(ctx, next);
    const handler = serverFunctionsMap.get("testFn")!.handler;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("should pass args from JSON body", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/echoFn" });
    simulateKoaBody(ctx, JSON.stringify(["a", "b"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
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
    const ctx = makeKoaCtx({ url: "/__rpc/cancelFn" });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    const next = makeKoaNext();
    const mwPromise = mw(ctx, next);
    setTimeout(() => ctx.req.emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
    expect(ctx.status).toBe(200);
  });

  it("should return 500 on handler error", async () => {
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("koa oops")),
    );
    const mw = createRPCMiddleware();
    const ctx = makeKoaCtx({ url: "/__rpc/errFn" });
    simulateKoaBody(ctx, JSON.stringify(["x"]));
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(ctx.status).toBe(500);
    expect(ctx.body).toEqual({ error: "Internal Server Error" });
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const mw = createRPCMiddleware({ rpcPrefix: "rpc" });
    const ctx = makeKoaCtx({ url: "/other/path" });
    const next = makeKoaNext();
    await mw(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
