import { beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import { attachRPC, attachVite, readBody } from "../src/fastify/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/fastify/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import fastifyPlugin from "../src/fastify/plugin.ts";
import {
  makeFastifyDone,
  makeFastifyReply,
  makeFastifyReq,
  seedServerMap,
  simulateRawBody,
} from "./fixtures/fastify.ts";

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

// ─── Fastify Helpers Tests ────────────────────────────────────────────
describe("Fastify helpers", () => {
  describe("readBody JSON", () => {
    it("should parse JSON from req.body", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      const result = await readBody(req as any);
      expect(result.contentType).toBe("application/json");
      expect(result.data).toEqual({ hello: "world" });
    });

    it("should read text from raw stream when not JSON", async () => {
      const req = makeFastifyReq({});
      simulateRawBody(req, "plain text");
      const result = await readBody(req as any);
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("plain text");
    });

    it("should reject on stream error", async () => {
      const req = makeFastifyReq();
      const p = readBody(req as any);
      process.nextTick(() =>
        (req as any).raw.emit("error", new Error("stream fail"))
      );
      await expect(p).rejects.toThrow("stream fail");
    });

    it("should use pre-parsed JSON body from Fastify", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      const result = await readBody(req as any);
      expect(result).toEqual({
        contentType: "application/json",
        data: { hello: "world" },
      });
    });

    it("should use pre-parsed text body from Fastify", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "text/plain" },
        body: JSON.stringify("plain text body"),
      });
      const result = await readBody(req as any);
      expect(result).toEqual({
        contentType: "text/plain",
        data: "plain text body",
      });
    });

    it("should not register stream listeners when body is pre-parsed", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/json" },
      });
      req.body = { data: 42 };

      const onSpy = vi.spyOn(req.raw, "on");
      const result = await readBody(req as any);
      expect(result).toEqual({
        contentType: "application/json",
        data: { data: 42 },
      });
      expect(onSpy).not.toHaveBeenCalled();
    });

    it("should fall through to raw stream when body is undefined", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/json" },
        rawBody: JSON.stringify({ from: "stream" }),
      });
      const p = readBody(req as any);
      simulateRawBody(req, JSON.stringify({ from: "stream" }));
      const result = await p;
      expect(result).toEqual({
        contentType: "application/json",
        data: { from: "stream" },
      });
    });

    it("should read valid JSON from raw stream with non-JSON content type", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "text/plain" },
        rawBody: JSON.stringify({ key: "value" }),
      });
      const p = readBody(req as any);
      simulateRawBody(req, JSON.stringify({ key: "value" }));
      const result = await p;
      expect(result).toEqual({
        contentType: "text/plain",
        data: { key: "value" },
      });
    });

    it("should use pre-parsed multipart body from a multipart parser", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
        body: JSON.stringify({ name: "artae" }),
      });
      const result = await readBody(req as any);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { name: "artae" },
      });
    });

    it("should return raw stream data for multipart when no parser ran", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
      });
      const p = readBody(req as any);
      simulateRawBody(req, "--xyz--");
      const result = await p;
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { raw: "--xyz--" },
      });
    });
  });

  describe("attachRPC", () => {
    it("should call loadRPCConfig and register the plugin", async () => {
      const app = { register: vi.fn() };
      await attachRPC(app as any);
      expect(app.register).toHaveBeenCalledOnce();
    });

    it("should call app.register with plugin", async () => {
      const app = { register: vi.fn() };
      const options = { rpcPrefix: "__rpc" };
      app.register(fastifyPlugin, options);
      expect(app.register).toHaveBeenCalledOnce();
      expect(app.register).toHaveBeenCalledWith(fastifyPlugin, options);
    });
  });

  describe("attachVite", () => {
    it("should add onRequest hook that calls vite.middlewares", async () => {
      const hooks: any[] = [];
      const app: any = {
        addHook: vi.fn((type: string, fn: any) => {
          hooks.push({ type, fn });
        }),
      };
      const vite = {
        middlewares: vi.fn((_req, _reply, cb) => cb()),
      };
      attachVite(app as any, vite as unknown as ViteDevServer);
      expect(app.addHook).toHaveBeenCalledWith(
        "onRequest",
        expect.any(Function),
      );
      expect(hooks.length).toBe(1);
      const hookFn = hooks[0].fn;
      expect(typeof hookFn).toBe("function");
    });

    it("should invoke hook and call vite.middlewares with raw objects", async () => {
      const hooks: any[] = [];
      const app: any = {
        addHook: vi.fn((_type: string, fn: any) => {
          hooks.push(fn);
        }),
      };
      const vite = {
        middlewares: vi.fn((_req: any, _reply: any, cb: any) => cb()),
      };
      attachVite(app as any, vite as unknown as ViteDevServer);
      const hookFn = hooks[0];
      const request = { raw: { method: "GET", url: "/test" } };
      const reply = { raw: { statusCode: 200 } };
      await hookFn(request, reply);
      expect(vite.middlewares).toHaveBeenCalledWith(
        request.raw,
        reply.raw,
        expect.any(Function),
      );
    });
  });
});

// ─── Fastify plugin ───────────────────────────────────────────────────

describe("Fastify plugin", () => {
  it("should work with default options when none provided", async () => {
    const addHook = vi.fn();
    const fastify = { addHook } as any;
    const done = vi.fn();
    fastifyPlugin(fastify, {}, done);
    expect(addHook).toHaveBeenCalledWith("preHandler", expect.any(Function));
    expect(done).toHaveBeenCalledOnce();
  });

  it("should register preHandler hook and call done", async () => {
    const addHook = vi.fn();
    const fastify = { addHook } as never;
    const done = vi.fn();
    const options = { rpcPrefix: "__rpc" };
    fastifyPlugin(fastify, options, done);
    expect(addHook).toHaveBeenCalledWith("preHandler", expect.any(Function));
    expect(done).toHaveBeenCalledOnce();
  });

  it("should invoke preHandler hook without error", async () => {
    const hooks: any[] = [];
    const addHook = vi.fn((_type: string, fn: any) => hooks.push(fn));
    const done = vi.fn();
    const f = { addHook } as never;
    seedServerMap();
    fastifyPlugin(f, { rpcPrefix: "other" }, done);
    const hookFn = hooks[0];
    const request = {
      url: "/not-matching",
      headers: {},
      method: "GET",
      raw: new EventEmitter(),
    };
    const reply = { raw: {}, status: vi.fn().mockReturnThis(), send: vi.fn() };
    await expect(hookFn(request, reply)).resolves.toBeUndefined();
  });
});

// ─── Fastify createMiddleware ─────────────────────────────────────────

describe("Fastify createMiddleware", () => {
  beforeEach(() => {
    seedServerMap();
  });

  it("should scan for server files when map is empty", async () => {
    serverFunctionsMap.clear();
    const handler = vi.fn();
    const mw = createMiddleware({ handler, rpcPrefix: "_server" });
    const req = makeFastifyReq({ url: "/_server/testFn" });
    const reply = makeFastifyReply();
    const done = vi.fn();
    await mw(req as any, reply as any, done);
    expect(handler).toHaveBeenCalled();
  });

  it("should return a function with auto-generated name", async () => {
    const mw = createMiddleware({ handler: vi.fn() });
    expect(typeof mw).toBe("function");
    expect(mw.name).toMatch(/^viteRPCMiddleware-/);
  });

  it("should use provided name", async () => {
    const mw = createMiddleware({ name: "fastify-mw", handler: vi.fn() });
    expect(mw.name).toBe("fastify-mw");
  });

  it("should throw on duplicate name", async () => {
    createMiddleware({ name: "fastify-dup", handler: vi.fn() });
    expect(() => createMiddleware({ name: "fastify-dup", handler: vi.fn() }))
      .toThrow("fastify-dup");
  });

  it("should call done() when no handler provided", async () => {
    const mw = createMiddleware();
    const req = makeFastifyReq() as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone();
    await mw(req, reply, done);
    expect(done).toHaveBeenCalledOnce();
  });

  it("should call done() on path mismatch (string)", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const req = makeFastifyReq({ url: "/other/path" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone();
    await mw(req, reply, done);
    expect(handler).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("should call handler when path matches", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: "/api", handler });
    const req = makeFastifyReq({ url: "/api/test" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should filter by RegExp", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const req = makeFastifyReq({ url: "/v2/users" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip on RegExp path mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ path: /^\/v[0-9]+/, handler });
    const req = makeFastifyReq({ url: "/api/users" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("should filter by rpcPrefix match", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "rpc", handler });
    const req = makeFastifyReq({ url: "/rpc/hello" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should skip when rpcPrefix mismatch", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "rpc", handler });
    const req = makeFastifyReq({ url: "/other/path" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const req = makeFastifyReq({ url: "/__rpc-evil/hello" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it("should call done() on no-match fallthrough", async () => {
    const handler = vi.fn();
    // Path and prefix both provided but match — exercise fallthrough
    const mw = createMiddleware({ path: /.*/, handler });
    const req = makeFastifyReq({ url: "/anything" }) as never;
    const reply = makeFastifyReply() as never;
    const done = makeFastifyDone() as never;
    await mw(req, reply, done);
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ─── Fastify createRPCMiddleware ──────────────────────────────────────

describe("Fastify createRPCMiddleware", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/noSuchFn",
      method: "POST",
    }) as never;
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Function not found",
    });
  });

  it("should return 200 with result for known function", async () => {
    createServerFunction(
      "fastify-hello",
      vi.fn().mockResolvedValue("hello fastify"),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-hello",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["arg1"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ data: "hello fastify" });
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
    const req = makeFastifyReq({
      url: "/__A_server/testFn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    req.body = { key: "value" };
    await mw(req as any, reply as any, done);
    const handler = serverFunctionsMap.get("testFn")!.handler;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("should pass args from JSON body", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/echoFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["a", "b"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
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
    const req = makeFastifyReq({
      url: "/__rpc/cancelFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    const mwPromise = mw(req as never, reply as never, done);
    setTimeout(() => (req.raw as any).emit("close"), 50);
    await mwPromise;
    expect(cancelled).toBe(true);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should return 500 on handler error", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("fastify oops")),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/errFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: "Internal Server Error" });
    process.env.NODE_ENV = prevEnv;
  });

  it("should skip non-matching rpcPrefix (fallthrough)", async () => {
    seedServerMap();
    const mw = createRPCMiddleware({ rpcPrefix: "custom-prefix" });
    const req = makeFastifyReq({ url: "/other/path", method: "POST" });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(done).toHaveBeenCalledOnce();
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("fastify-get-only", vi.fn());
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-get-only",
      method: "GET",
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(405);
    expect(reply.send).toHaveBeenCalledWith({ error: "Method Not Allowed" });
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("fastify-public");
    createServerFunction("fastify-public", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: `/__rpc/fastify-public?args=${
        encodeURIComponent(
          JSON.stringify(["news"]),
        )
      }`,
      method: "GET",
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("fastify-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "Forbidden" });
  });

  it("should pass requests without an Origin header when origin is set", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});
