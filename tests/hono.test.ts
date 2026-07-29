import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";

import type { ServerFnEntry } from "../src";
import { serverFunctionsMap } from "../src/functionsMap";
import {
  attachRPC,
  attachVite,
  readBody,
  viteMiddleware,
} from "../src/hono/helpers";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/hono/createMiddleware";
import { createServerFunction } from "../src/createFunction";
import { makeHonoContext, makeHonoNext, seedServerMap } from "./fixtures/hono";

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

// ─── Hono Helpers ─────────────────────────────────────────────────────

describe("Hono helpers", () => {
  describe("readBody", () => {
    it("should parse JSON via c.req.json()", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      const result = await readBody(c);
      expect(result.contentType).toBe("application/json");
      expect(result.data).toEqual({ hello: "world" });
    });

    it("should read text via c.req.text()", async () => {
      const c = makeHonoContext({ body: "plain text" });
      const result = await readBody(c);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("plain text");
    });

    it("should return JSON for text content type when body is JSON-like", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      const result = await readBody(c);
      expect(result.contentType).toBe("application/json");
      expect(result.data).toEqual({ a: 1 });
    });

    it("should return text/plain for non-JSON content type", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "text/plain" },
        body: "plain text",
      });
      const result = await readBody(c);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("plain text");
    });

    it("should use pre-parsed body from incoming.body when available", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      (c.env as any).incoming = { body: { preParsed: true } };
      const result = await readBody(c);
      expect(result.data).toEqual({ preParsed: true });
      expect(result.contentType).toBe("application/json");
    });

    it("should use pre-parsed body with non-JSON content type", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "text/plain" },
        body: "plain text body",
      });
      (c.env as any).incoming = { body: "pre-parsed body" };
      const result = await readBody(c);
      expect(result).toEqual({
        contentType: "text/plain",
        data: "pre-parsed body",
      });
    });
  });

  describe("attachRPC", () => {
    it("should call loadRPCConfig and register middleware", async () => {
      const app = { use: vi.fn() };
      await attachRPC(app as any);
      expect(app.use).toHaveBeenCalledOnce();
    });

    it("should call app.use with RPC middleware", async () => {
      seedServerMap();
      const rpcMw = createRPCMiddleware();
      const app = { use: vi.fn() };
      app.use(rpcMw as any);
      expect(app.use).toHaveBeenCalledOnce();
      expect(app.use).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("attachVite", () => {
    it("should call app.use with viteMiddleware", async () => {
      const app: any = { use: vi.fn() };
      const vite: any = {};
      attachVite(app as any, vite as unknown as ViteDevServer);
      expect(app.use).toHaveBeenCalledOnce();
      expect(typeof app.use.mock.calls[0][0]).toBe("function");
    });

    it("should invoke viteMiddleware and call vite.middlewares with env objects", async () => {
      const vite = {
        middlewares: vi.fn((_incoming: any, _outgoing: any, cb: any) => cb()),
      };
      const mw = viteMiddleware(vite as unknown as ViteDevServer);
      const ee = new EventEmitter();
      const c = makeHonoContext({ envIncoming: ee });
      const next = makeHonoNext();
      const result = mw(c, next);
      // In Node.js (typeof Bun === "undefined"), the Node path is taken
      expect(vite.middlewares).toHaveBeenCalledWith(
        ee,
        c.env.outgoing,
        expect.any(Function),
      );
      await expect(result).resolves.toBeUndefined();
    });
  });
});

// ─── Hono createMiddleware ────────────────────────────────────────────

describe("Hono createMiddleware", () => {
  beforeEach(() => {
    seedServerMap();
  });

  it("should scan for server files when map is empty", async () => {
    serverFunctionsMap.clear();
    const handler = vi.fn();
    const mw = createMiddleware({ handler, rpcPrefix: "_server" });
    const c = makeHonoContext({ path: "/_server/testFn" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should return a function with auto-generated name", async () => {
    const mw = createMiddleware({ handler: vi.fn() });
    expect(typeof mw).toBe("function");
    expect(mw.name).toMatch(/^viteRPCMiddleware-/);
  });

  it("should use provided name", async () => {
    const mw = createMiddleware({ name: "hono-mw", handler: vi.fn() });
    expect(mw.name).toBe("hono-mw");
  });

  it("should throw on duplicate name", async () => {
    createMiddleware({ name: "hono-dup", handler: vi.fn() });
    expect(() => createMiddleware({ name: "hono-dup", handler: vi.fn() }))
      .toThrow("hono-dup");
  });

  it("should call next() when no handler provided", async () => {
    const mw = createMiddleware();
    const c = makeHonoContext();
    const next = makeHonoNext();
    await mw(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("should call handler when path matches (string)", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const c = makeHonoContext({ path: "/api/test" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should call next() on string path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const c = makeHonoContext({ path: "/other" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by RegExp", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const c = makeHonoContext({ path: "/v2/users" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip on RegExp path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const c = makeHonoContext({ path: "/api/users" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by rpcPrefix match", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "_server", handler });
    const c = makeHonoContext({ path: "/_server/hello" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip when rpcPrefix mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "_server", handler });
    const c = makeHonoContext({ path: "/other/path" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const c = makeHonoContext({ path: "/__rpc-evil/hello" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

// ─── Hono createRPCMiddleware ─────────────────────────────────────────

describe("Hono createRPCMiddleware", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/noSuchFn" });
    const next = makeHonoNext();
    const result = await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Function not found" },
      404,
    );
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction(
      "hono-hello",
      vi.fn().mockResolvedValue("hello hono"),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-hello",
      body: JSON.stringify(["arg1"]),
    });
    const next = makeHonoNext();
    const result = await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ data: "hello hono" }, 200);
  });

  it("should pass args from JSON body to function", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/echoFn",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["a", "b"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
  });

  it("should cancel on incoming close", async () => {
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
    const c = makeHonoContext({
      path: "/__rpc/cancelFn",
      body: JSON.stringify(["x"]),
      envIncoming: ee,
    });
    const next = makeHonoNext();
    const mwPromise = mw(c, next);
    setTimeout(() => ee.emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
    expect(c.json).toHaveBeenCalledWith({ data: "result" }, 200);
  });

  it("should return 500 on handler error", async () => {
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("hono oops")),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/errFn" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Internal Server Error" },
      500,
    );
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const mw = createRPCMiddleware({ rpcPrefix: "_sv" });
    const c = makeHonoContext({ path: "/other/path" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
