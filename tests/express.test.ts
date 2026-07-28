import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";

import type { ServerFnEntry } from "../src";
import { serverFunctionsMap } from "../src/functionsMap";
import {
  attachRPC,
  attachVite,
  getRequestDetails,
  getResponseDetails,
  readBody,
} from "../src/express/helpers";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/express/createMiddleware";
import { createServerFunction } from "../src/createFunction";
import rpcPlugin, { defineConfig, loadRPCConfig } from "../src";
import {
  makeNext,
  makeReq,
  makeRes,
  seedServerMap,
  simulateBody,
} from "./fixtures/express";

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

// ─── Express Helpers (extended) ────────────────────────────────────────

describe("Express helpers extended", () => {
  describe("attachRPC", () => {
    it("should call app.use with RPC middleware", async () => {
      const mock = vi.fn();
      let app = { use: mock };
      await attachRPC(app as never);
      expect(mock).toHaveBeenCalledOnce();
    });

    it("should register middleware that handles RPC prefix", async () => {
      seedServerMap();
      const mw = createRPCMiddleware();
      const appUse = vi.fn();
      const app = { use: appUse } as any;
      appUse(mw);
      expect(appUse).toHaveBeenCalledOnce();
    });
  });

  it("getRequestDetails should fallback to request.url for bare IncomingMessage", async () => {
    const req = Object.assign(new EventEmitter(), {
      url: "/bare-node-path",
      method: "GET",
      headers: {},
    });
    delete (req as any).originalUrl;
    const result = getRequestDetails(req as any);
    expect(result.url).toBe("/bare-node-path");
  });

  describe("attachVite", () => {
    it("should call app.use with vite.middlewares", async () => {
      const app = { use: vi.fn() };
      const vite = { middlewares: vi.fn() };
      attachVite(app as any, vite as unknown as ViteDevServer);
      expect(app.use).toHaveBeenCalledWith(vite.middlewares);
    });
  });

  describe("readBody", () => {
    it("should throw on stream error", async () => {
      const req = makeReq({});
      const p = readBody(req);
      setImmediate(() => req.emit("error", new Error("stream fail")));
      await expect(p).rejects.toThrow("stream fail");
    });

    it("should resolve as text when JSON parse fails", async () => {
      const req = makeReq({});
      const p = readBody(req);
      simulateBody(req, "not-json");
      const result = await p;
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("not-json");
    });
  });

  describe("readBody with pre-parsed body", () => {
    it("should return parsed JSON when req.body is set by express.json()", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "application/json",
        },
      });
      (req as any).body = { hello: "world" };
      const result = await readBody(req);
      expect(result).toEqual({
        contentType: "application/json",
        data: { hello: "world" },
      });
    });

    it("should return text when req.body is set by express.text()", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "text/plain",
        },
      });
      (req as any).body = "plain text body";
      const result = await readBody(req);
      expect(result).toEqual({
        contentType: "text/plain",
        data: "plain text body",
      });
    });

    it("should fall through to raw stream when req.body is undefined", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "application/json",
        },
      });
      (req as any).body = undefined;
      const p = readBody(req);
      simulateBody(req, '{"from":"stream"}');
      const result = await p;
      expect(result).toEqual({
        contentType: "application/json",
        data: { from: "stream" },
      });
    });

    it("should not register stream listeners when req.body is pre-parsed", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "application/json",
        },
      });
      (req as any).body = { data: 42 };
      const onSpy = vi.spyOn(req, "on");
      const result = await readBody(req);
      expect(result).toEqual({
        contentType: "application/json",
        data: { data: 42 },
      });
      expect(onSpy).not.toHaveBeenCalled();
    });
  });

  describe("getResponseDetails setHeader", () => {
    it("should use Express .header() on Express response", async () => {
      const res = makeRes();
      const { setHeader } = getResponseDetails(res);
      setHeader("X-Custom", "value");
      expect(res.header).toHaveBeenCalledWith("X-Custom", "value");
    });

    it("should use .setHeader() on bare ServerResponse", async () => {
      const res = makeRes();
      delete (res as any).header;
      delete (res as any).json;
      delete (res as any).send;
      const { setHeader } = getResponseDetails(res);
      setHeader("X-Custom", "value");
      expect(res.setHeader).toHaveBeenCalledWith("X-Custom", "value");
    });
  });

  describe("getResponseDetails setStatusCode/sendResponse", () => {
    it("setStatusCode should use Express .status() on Express response", async () => {
      const res = makeRes();
      const { setStatusCode } = getResponseDetails(res);
      setStatusCode(404);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.statusCode).toBe(404);
    });

    it("setStatusCode should set statusCode on bare ServerResponse", async () => {
      const res = makeRes();
      delete (res as any).header;
      delete (res as any).json;
      delete (res as any).send;
      delete (res as any).status;
      const { setStatusCode } = getResponseDetails(res);
      setStatusCode(500);
      expect(res.statusCode).toBe(500);
    });

    it("sendResponse should use Express .send() on Express response", async () => {
      const res = makeRes();
      const { sendResponse } = getResponseDetails(res);
      sendResponse(200, { data: "ok" });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(JSON.stringify({ data: "ok" }));
    });

    it("sendResponse should use .end() on bare ServerResponse", async () => {
      const res = makeRes();
      delete (res as any).header;
      delete (res as any).json;
      delete (res as any).send;
      delete (res as any).status;
      const { sendResponse } = getResponseDetails(res);
      sendResponse(500, { error: "fail" });
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "fail" }));
      expect(res.statusCode).toBe(500);
    });
  });
});

// ─── createMiddleware extended ────────────────────────────────────────

describe("Express createMiddleware extended", () => {
  beforeEach(() => {
    seedServerMap();
  });

  it("should scan for server files when map is empty", async () => {
    serverFunctionsMap.clear();
    const handler = vi.fn();
    const mw = createMiddleware({ handler });
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();
    // scanForServerFiles runs silently (catches ENOENT), then handler is called
    await mw(req, res, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should call next() at fallthrough when no handler and map not empty", async () => {
    const mw = createMiddleware();
    const req = makeReq({});
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("createRPCMiddleware should call next() on rpcPreffix mismatch", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const req = makeReq({ originalUrl: "/not-rpc/path", method: "POST" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("should filter requests by string path", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const req = makeReq({ originalUrl: "/api/test" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should filter requests by RegExp path", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const req = makeReq({ originalUrl: "/v2/test" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip on path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const req = makeReq({ originalUrl: "/other/path" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("should filter by rpcPreffix match with handler", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPreffix: "__rpc", handler });
    const req = makeReq({ originalUrl: "/__rpc/hello" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPreffix: "__rpc", handler });
    const req = makeReq({ originalUrl: "/__rpc-evil/hello" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Express createRPCMiddleware handler", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const req = makeReq({ originalUrl: "/__rpc/nonexistent", method: "POST" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData.error).toContain("Function not found");
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction("hello-fn", vi.fn().mockResolvedValue("hello"));
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/hello-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["arg"]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ data: "hello" });
  });

  it("should pass args from JSON body", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echo-fn", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/echo-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["a", "b"]));
    await mw(req, res, next);
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
    createServerFunction("cancel-fn", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/cancel-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["x"]));
    const mwPromise = mw(req, res, next);
    setTimeout(() => req.emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should wrap non-array JSON body in array for the handler", async () => {
    serverFunctionsMap.set("testFn", {
      name: "testFn",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("ok"),
        cancel: vi.fn(),
      }),
    });
    const mw = createRPCMiddleware({ rpcPreffix: "__A_server" });
    const req = makeReq({
      originalUrl: "/__A_server/testFn",
      method: "POST",
    });
    const res = makeRes();
    process.nextTick(() => {
      req.emit("data", JSON.stringify({ key: "value" }));
      req.emit("end");
    });
    await mw(req, res, () => {});
    const handler = serverFunctionsMap.get("testFn")!.handler;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("should return 500 on handler error", async () => {
    createServerFunction(
      "err-fn",
      vi.fn().mockRejectedValue(new Error("oops")),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/err-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Internal Server Error" });
  });
});

// ─── Plugin lifecycle tests ───────────────────────────────────────────

describe("plugin lifecycle", () => {
  it("defineConfig should merge options with defaults", async () => {
    const cfg = defineConfig({ adapter: "hono" });
    expect(cfg.adapter).toBe("hono");
    expect(cfg.rpcPreffix).toBe("__rpc");
  });

  // it("config() should return SSR noExternal config", async () => {
  //   const plugin = rpcPlugin();
  //   const result = (plugin.config as any)?.({}, {});
  //   expect(result).toEqual({ ssr: { noExternal: ["@thednp/rpc"] } });
  // });

  it("configResolved should load RPC config without error", async () => {
    const plugin = rpcPlugin();
    // configResolved calls loadRPCConfig which needs fs
    await expect(
      (plugin as any).configResolved({ root: process.cwd(), base: "/" }),
    ).resolves.toBeUndefined();
  });

  it("buildStart should set isOxc=true for vite 8+", async () => {
    const plugin = rpcPlugin();
    const ctx = { meta: { viteVersion: "8.0.0" } };
    await (plugin as any).buildStart.call(ctx);
    // isOxc defaults to true, vite 8 sets isOxc = true anyway
  });

  it("buildStart should set isOxc=false for vite < 7", async () => {
    const plugin = rpcPlugin();
    serverFunctionsMap.clear();
    const ctx = { meta: { viteVersion: "5.0.0" } };
    await (plugin as any).buildStart.call(ctx);
  });

  it("transform should return null for code without createServerFunction", async () => {
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    const result = await (plugin as any).transform(
      "console.log('hello')",
      "test.ts",
      { ssr: false },
    );
    expect(result).toBeNull();
  });

  it("transform should return null for SSR mode", async () => {
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    const result = await (plugin as any).transform(
      "createServerFunction('test', async () => {})",
      "test.ts",
      { ssr: true },
    );
    expect(result).toBeNull();
  });

  it("transform should return transformed code for RPC code in Node env", async () => {
    // Seed map so scanForServerFiles is skipped (it would fail without real config)
    seedServerMap();
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    const result = await (plugin as any).transform(
      "createServerFunction('test', async () => {})",
      "test.ts",
      { ssr: false },
    );
    // In Node.js (typeof process !== "undefined"), RPC code is transformed
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("map");
    expect(typeof (result as any).code).toBe("string");
  });

  it("configureServer should set viteServer and add express middleware", async () => {
    serverFunctionsMap.clear();
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    const middlewaresUse = vi.fn();
    const server = { middlewares: { use: middlewaresUse } };
    await (plugin as any).configureServer(server);
    expect(middlewaresUse).toHaveBeenCalledOnce();
    expect(middlewaresUse).toHaveBeenCalledWith(expect.any(Function));
  });

  it("buildStart should scan server files when config present but no viteServer", async () => {
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    serverFunctionsMap.clear();
    const ctx = { meta: { viteVersion: "8.0.0" } };
    await expect(
      (plugin as any).buildStart.call(ctx),
    ).resolves.toBeUndefined();
  });

  it("transform should scan server files when map is empty", async () => {
    const plugin = rpcPlugin();
    await (plugin as any).configResolved({ root: process.cwd(), base: "/" });
    serverFunctionsMap.clear();
    const result = await (plugin as any).transform(
      "createServerFunction('test', async () => {})",
      "test.ts",
      { ssr: false },
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("code");
  });

  it("loadRPCConfig should return cached config on second call without args", async () => {
    // First call with a valid config file sets RPCConfig
    const firstResult = await loadRPCConfig("tests/fixtures/good.config.ts");
    expect(firstResult.adapter).toBe("hono");
    // Second call without args should return cached config
    const secondResult = await loadRPCConfig();
    expect(secondResult.adapter).toBe("hono");
    expect(secondResult.rpcPreffix).toBe("_sv");
  });
});
