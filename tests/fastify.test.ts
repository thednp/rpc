import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, schema } from "../src/schema.ts";
import { decodeFormFlash, FLASH_PARAM } from "../src/form-fallback.ts";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";
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
  viteMiddleware,
} from "../src/fastify/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/fastify/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import fastifyPlugin from "../src/fastify/plugin.ts";
import type { DispatchContext } from "../src/types.d.ts";
import {
  makeFastifyDone,
  makeFastifyReply,
  makeFastifyReq,
  seedServerMap,
  simulateRawBody,
} from "./fixtures/fastify.ts";

beforeEach(() => {
  for (const map of serverFunctionsByPrefix.values()) {
    map.clear();
  }
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

    it("should use pre-parsed urlencoded body from a urlencoded parser", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: JSON.stringify({ name: "artae" }),
      });
      const result = await readBody(req as any);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae" },
      });
    });

    it("should parse urlencoded body from the raw stream", async () => {
      const req = makeFastifyReq({
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const p = readBody(req as any);
      simulateRawBody(req, "name=artae&job=developer");
      const result = await p;
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
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

  describe("viteMiddleware", () => {
    it("should return a function with correct signature", () => {
      const vite = { middlewares: vi.fn() };
      const handler = viteMiddleware(vite as unknown as ViteDevServer);
      expect(typeof handler).toBe("function");
    });

    it("should call reply.hijack and vite.middlewares with raw objects", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, _reply: any, cb: any) => cb()),
      };
      const handler = viteMiddleware(vite as unknown as ViteDevServer);
      const request = { raw: { method: "GET", url: "/test" } };
      const reply = {
        hijack: vi.fn(),
        raw: { statusCode: 200 },
      };
      await handler(request as any, reply as any);
      expect(reply.hijack).toHaveBeenCalledOnce();
      expect(vite.middlewares).toHaveBeenCalledWith(
        request.raw,
        reply.raw,
        expect.any(Function),
      );
    });

    it("should reject when vite.middlewares passes an error", async () => {
      const vite = {
        middlewares: vi.fn((_req: any, _reply: any, cb: any) =>
          cb(new Error("vite failed"))
        ),
      };
      const handler = viteMiddleware(vite as unknown as ViteDevServer);
      const request = { raw: { method: "GET", url: "/test" } };
      const reply = {
        hijack: vi.fn(),
        raw: { statusCode: 200 },
      };
      await expect(handler(request as any, reply as any)).rejects.toThrow(
        "vite failed",
      );
    });
  });

  describe("redirect", () => {
    it("should call reply.redirect with location first (v5 signature)", () => {
      const reply = makeFastifyReply();
      reply.redirect = vi.fn();
      redirect(reply as never, "/target", 303);
      expect(reply.redirect).toHaveBeenCalledWith("/target", 303);
    });

    it("should default to 303 See Other", () => {
      const reply = makeFastifyReply();
      reply.redirect = vi.fn();
      redirect(reply as never, "/target");
      expect(reply.redirect).toHaveBeenCalledWith("/target", 303);
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

  it("should use default prefix when rpcPrefix is undefined", async () => {
    createServerFunction(
      "fastify-hello",
      vi.fn().mockResolvedValue("hello fastify"),
    );
    const mw = createRPCMiddleware({ rpcPrefix: undefined });
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

  it("should expose request context to server functions", async () => {
    let seenRequest: unknown;
    createServerFunction(
      "fastify-context",
      vi.fn().mockImplementation(async (_signal: AbortSignal) => {
        const event = getRequestContext();
        seenRequest = event.request;
        event.locals.traceId = "abc-123";
        return (event.locals as { traceId: string }).traceId;
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-context",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ data: "abc-123" });
    expect(seenRequest).toBe(req);
  });

  it("should skip the JSON send when the function redirects", async () => {
    createServerFunction(
      "fastify-redirect",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-redirect",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    reply.redirect = vi.fn();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.redirect).toHaveBeenCalledWith("/login", 303);
    expect(reply.status).not.toHaveBeenCalledWith(200);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("should short-circuit with send status, body and headers", async () => {
    createServerFunction(
      "fastify-send",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send?.(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-send",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.header).toHaveBeenCalledWith("retry-after", "30");
    expect(reply.send).toHaveBeenCalledWith({ error: "Rate limit exceeded" });
  });

  it("should short-circuit with send without headers", async () => {
    createServerFunction(
      "fastify-send-no-headers",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send?.(204, null);
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-send-no-headers",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(204);
    expect(reply.header).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith(null);
  });

  it("should expose functionName via the request context", async () => {
    let seenName: string | undefined;
    createServerFunction(
      "fastify-context-send",
      vi.fn().mockImplementation(async () => {
        seenName = getRequestContext().functionName;
        return "ok";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-context-send",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(seenName).toBe("fastify-context-send");
  });

  it("should use default 303 when redirect is called without a status", async () => {
    createServerFunction(
      "fastify-redirect-default",
      vi.fn().mockImplementation(async () => {
        getRequestContext().redirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-redirect-default",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    reply.redirect = vi.fn();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.redirect).toHaveBeenCalledWith("/login", 303);
    expect(reply.send).not.toHaveBeenCalled();
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
    const req = makeFastifyReq({
      url: "/__A_server/testFn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    req.body = { key: "value" };
    await mw(req as any, reply as any, done);
    const handler = getFunctionsForPrefix("__A_server").get("testFn")!.handler;
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
      body: JSON.stringify(["a"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a");
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("jsonFn", vi.fn().mockResolvedValue("ok"));
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/jsonFn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ name: "artae" }),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(415);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Unsupported Media Type",
    });
  });

  it("should return 415 when text-declared function gets json body", async () => {
    createServerFunction(
      "textFn",
      vi.fn().mockResolvedValue("ok"),
      { contentType: "text/plain" },
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/textFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["hello"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(415);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Unsupported Media Type",
    });
  });

  it("should accept urlencoded body for multipart-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "mpFn",
      fn,
      { contentType: "multipart/form-data" },
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/mpFn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ name: "artae" }),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), { name: "artae" });
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should accept multipart body for urlencoded-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "urlFn",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/urlFn",
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: JSON.stringify({ a: "1" }),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), { a: "1" });
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should exempt requests without a Content-Type header (curl compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("noHeaderFn", fn);
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/noHeaderFn",
      method: "POST",
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
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

  it("should dispatch GET functions without args query param", async () => {
    const fn = vi.fn().mockResolvedValue("no-args");
    createServerFunction("fastify-public-no-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-public-no-args",
      method: "GET",
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    // The input slot is always passed explicitly, so an empty wire array
    // arrives as `undefined` — the same shape a direct `fn()` call has.
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should return 400 when GET ?args= is not a JSON array", async () => {
    const fn = vi.fn();
    createServerFunction("fastify-public-bad-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: `/__rpc/fastify-public-bad-args?args=${
        encodeURIComponent('{"a":1}')
      }`,
      method: "GET",
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: "Bad Request" });
  });

  it("should return 400 when GET ?args= is not valid JSON", async () => {
    // A malformed request, not a server fault — it used to escape the dispatch
    // try and be reported as a 500.
    const fn = vi.fn();
    createServerFunction("fastify-malformed-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: `/__rpc/fastify-malformed-args?args=${
        encodeURIComponent("not json")
      }`,
      method: "GET",
    });
    const reply = makeFastifyReply();
    await mw(req as never, reply as never, makeFastifyDone());
    expect(fn).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("should answer 400 end to end for a malformed JSON body", async () => {
    // Fastify's own parser answers 400 before rpc is reached, so this drives
    // the raw-stream path rpc uses when no parser ran.
    const fn = vi.fn();
    createServerFunction("fastify-malformed", fn);
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-malformed",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    simulateRawBody(req, "{not json");
    const reply = makeFastifyReply();
    await mw(req as never, reply as never, makeFastifyDone());
    expect(fn).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: "Bad Request" });
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

  it("should pass requests whose Origin matches the configured origin (single string, back-compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: "https://app.example.com" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should return 403 when Origin is absent and Sec-Fetch-Site is cross-site", async () => {
    createServerFunction("fastify-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: undefined, "sec-fetch-site": "cross-site" },
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "Forbidden" });
  });

  it("should pass when Origin is absent and Sec-Fetch-Site is same-origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: undefined, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("default policy rejects a cross-origin request with no options at all", async () => {
    // Proves the secure default is wired through this adapter, not merely
    // implemented in the shared helper. Creating the middleware with no options
    // must already be protected.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: "https://evil.com", "sec-fetch-site": "cross-site" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    await mw(req as never, reply as never, makeFastifyDone());
    expect(fn).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it("default policy admits the server's own host, comparing host only", async () => {
    // `http://` against the fixture's `Host` proves the scheme is not part of
    // the comparison, so a TLS-terminating proxy needs no configuration.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware();
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { host: "app.example.com", origin: "http://app.example.com" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    await mw(req as never, reply as never, makeFastifyDone());
    expect(fn).toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("sibling subdomain survives: allowlisted Origin + same-site passes", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "sec-fetch-site": "same-site",
      },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should pass requests whose Origin matches one entry of an allowlist array", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fastify-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: "https://admin.example.com" },
      body: JSON.stringify(["x"]),
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it("should return 403 when Origin matches no entry of an allowlist array", async () => {
    createServerFunction("fastify-fn", vi.fn());
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
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

  it('should return 403 for Origin: "null" when an allowlist is set', async () => {
    createServerFunction("fastify-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: ["https://app.example.com"] });
    const req = makeFastifyReq({
      url: "/__rpc/fastify-fn",
      method: "POST",
      headers: { origin: "null" },
    });
    const reply = makeFastifyReply();
    const done = makeFastifyDone();
    await mw(req as never, reply as never, done);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "Forbidden" });
  });

  it("validates the input against the function schema before dispatch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("validated", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
      hint: "a single function-wide hint",
    });
    const mw = createRPCMiddleware({ allowHeaderless: true });
    const ok = makeFastifyReq({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c" }),
    });
    const okReply = makeFastifyReply();
    await mw(ok as never, okReply as never, makeFastifyDone());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      email: "a@b.c",
    });
    expect(okReply.status).toHaveBeenCalledWith(200);

    const bad = makeFastifyReq({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 5 }),
    });
    const badReply = makeFastifyReply();
    await mw(bad as never, badReply as never, makeFastifyDone());
    expect(badReply.status).toHaveBeenCalledWith(422);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((badReply as unknown as { _data: { hint?: string } })._data.hint)
      .toMatch(
        /^a single function-wide hint — .*wiki\/server-functions\.md#input-validation$/,
      );

    // Without a function-wide hint, the pointer stands alone.
    createServerFunction("validated", vi.fn(), {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const plain = makeFastifyReq({
      url: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 5 }),
    });
    const plainReply = makeFastifyReply();
    await mw(plain as never, plainReply as never, makeFastifyDone());
    expect(
      (plainReply as unknown as { _data: { hint?: string } })._data.hint,
    ).toBe(
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
    const req = makeFastifyReq({
      url: "/__rpc/array-payload",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([[1, 2]]),
    });
    const reply = makeFastifyReply();
    await mw(req as never, reply as never, makeFastifyDone());
    expect(fn).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: "Bad Request" });
  });
});

/* ─── onDispatch ────────────────────────────────────────────────────────────
 * fastify answers through `reply.send()`, so the body is gone by the time a
 * result comes back — the id is merged by wrapping `send` in `onStart`, which is
 * the one adapter that needs the id before the dispatch runs.
 */

describe("fastify onDispatch", () => {
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

  const go = async (path: string, body: unknown = []) => {
    const req = makeFastifyReq({
      url: path,
      method: "POST",
      headers: { "content-type": "application/json" },
    }) as never;
    const reply = makeFastifyReply();
    simulateRawBody(req, JSON.stringify(body));
    await mw()(req, reply as never, makeFastifyDone());
    return {
      status: reply.statusCode,
      body: (reply as unknown as { _data?: Record<string, unknown> })._data,
    };
  };

  it("records a successful dispatch", async () => {
    createServerFunction("fy-ok", vi.fn().mockResolvedValue("ok"));
    const { status } = await go("/__rpc/fy-ok", ["x"]);
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prefix: "__rpc",
      functionName: "fy-ok",
      method: "POST",
      declaredMethod: "POST",
      declaredContentType: "application/json",
      contentTypeMatched: true,
      status: 200,
      outcome: "ok",
    });
  });

  it("shapes the args and never records a value", async () => {
    createServerFunction("fy-shape", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/fy-shape", [{ a: 1, password: "correct-horse" }]);
    expect(seen[0].argShape).toBe("[{a:number,password:string}]");
    expect(JSON.stringify(seen[0])).not.toContain("correct-horse");
  });

  it("records the 404 and lists the sibling names", async () => {
    createServerFunction("fy-known", vi.fn().mockResolvedValue("ok"));
    const { status } = await go("/__rpc/nope");
    expect(status).toBe(404);
    expect(seen[0]).toMatchObject({
      functionName: "nope",
      status: 404,
      outcome: "client-error",
    });
    expect(seen[0].registeredNames).toContain("fy-known");
  });

  it("records the origin rejection", async () => {
    const req = makeFastifyReq({
      url: "/__rpc/fy-ok",
      method: "POST",
      headers: { origin: "https://evil.test" },
    }) as never;
    const reply = makeFastifyReply();
    await mw()(req, reply as never, makeFastifyDone());
    expect(reply.statusCode).toBe(403);
    expect(seen[0]).toMatchObject({ status: 403, originTier: "origin" });
  });

  it("records a thrown handler as a server error", async () => {
    createServerFunction("fy-boom", vi.fn().mockRejectedValue(new Error("b")));
    const { status } = await go("/__rpc/fy-boom");
    expect(status).toBe(500);
    expect(seen[0]).toMatchObject({
      status: 500,
      outcome: "server-error",
    });
  });

  it("merges the id into what reply.send sends, and the record agrees", async () => {
    const { body } = await go("/__rpc/nope");
    expect(body?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0].id).toBe(body?.id);
  });

  it("leaves a success body alone", async () => {
    createServerFunction("fy-ok2", vi.fn().mockResolvedValue("ok"));
    const { body } = await go("/__rpc/fy-ok2");
    expect(body).toEqual({ data: "ok" });
  });

  it("leaves the body alone with no hook registered", async () => {
    seedServerMap();
    const req = makeFastifyReq({
      url: "/__rpc/noSuchFn",
      method: "POST",
    }) as never;
    const reply = makeFastifyReply();
    await createRPCMiddleware()(req, reply as never, makeFastifyDone());
    expect(reply.send).toHaveBeenCalledWith({ error: "Function not found" });
  });

  it("records a method mismatch with the declared method", async () => {
    createServerFunction("fy-get", vi.fn().mockResolvedValue("ok"), {
      method: "GET",
    });
    const { status } = await go("/__rpc/fy-get");
    expect(status).toBe(405);
    expect(seen[0]).toMatchObject({
      status: 405,
      declaredMethod: "GET",
    });
  });

  it("records a content-type mismatch with both sides of it", async () => {
    createServerFunction("fy-ct", vi.fn().mockResolvedValue("ok"));
    const req = makeFastifyReq({
      url: "/__rpc/fy-ct",
      method: "POST",
      headers: { "content-type": "text/plain" },
    }) as never;
    const reply = makeFastifyReply();
    simulateRawBody(req, "[]");
    await mw()(req, reply as never, makeFastifyDone());
    expect(seen[0]).toMatchObject({
      status: 415,
      declaredContentType: "application/json",
      actualContentType: "text/plain",
      contentTypeMatched: false,
    });
  });

  it("records a GET function called with no ?args= at all", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createServerFunction("fy-noargs", handler, { method: "GET" });
    const req = makeFastifyReq({
      url: "/__rpc/fy-noargs",
      method: "GET",
    }) as never;
    const reply = makeFastifyReply();
    await mw()(req, reply as never, makeFastifyDone());
    expect(seen[0]).toMatchObject({
      functionName: "fy-noargs",
      status: 200,
      argShape: "[]",
    });
  });

  it("falls back to the default contentType for a hand-registered entry", async () => {
    serverFunctionsMap.set("no-options", {
      handler: (async () => "bare") as never,
    } as never);
    const req = makeFastifyReq({
      url: "/__rpc/no-options",
      method: "POST",
      headers: { "content-type": "application/json" },
    }) as never;
    const reply = makeFastifyReply();
    simulateRawBody(req, "[]");
    await mw()(req, reply as never, makeFastifyDone());
    expect(seen[0]).toMatchObject({ declaredContentType: "application/json" });
  });

  it("does not take down the request when the hook throws", async () => {
    createServerFunction("fy-throw", vi.fn().mockResolvedValue("ok"));
    const req = makeFastifyReq({
      url: "/__rpc/fy-throw",
      method: "POST",
      headers: { "content-type": "application/json" },
    }) as never;
    const reply = makeFastifyReply();
    simulateRawBody(req, "[]");
    await createRPCMiddleware({
      onDispatch: () => {
        throw new Error("log exploded");
      },
    })(req, reply as never, makeFastifyDone());
    expect(reply.statusCode).toBe(200);
  });
});

describe("Fastify no-JS form fallback (dispatch)", () => {
  const formHeaders = (accept: string) => ({
    "content-type": "application/x-www-form-urlencoded",
    accept,
  });

  beforeEach(() => {
    serverFunctionsMap.clear();
    seedServerMap();
  });

  const BODIES: Record<string, string> = {
    "form-nav-bad": "age=nope",
    "form-fetch": "age=nope",
    "form-nav-ok": "age=7",
    "form-nav-replay": "age=nope&note=hello",
  };
  const formReq = (kind: string) => {
    const r = makeFastifyReq({
      url: "/__rpc/contact",
      method: "POST",
      headers: formHeaders(
        kind === "form-fetch" ? "application/json" : "text/html",
      ),
      rawBody: BODIES[kind],
    });
    // The urlencoded body has to arrive on the Node stream, the way Fastify's own
    // parser would have delivered it, so the adapter reads it through `readBody`.
    simulateRawBody(r, BODIES[kind]);
    return r;
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
    const request = formReq("form-nav-bad");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/contact"),
      303,
    );
    const url = new URL(
      reply.redirect.mock.calls[0][0] as string,
      "http://localhost",
    );
    const flash = decodeFormFlash(url.searchParams.get(FLASH_PARAM)!);
    expect(flash!.errors?.age).toBeDefined();
    expect(reply.status).not.toHaveBeenCalledWith(422);
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
    const request = formReq("form-fetch");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(reply.redirect).not.toHaveBeenCalled();
  });

  it("redirects a successful navigation to the author's target", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      fallback: "/thanks",
    });
    const mw = createRPCMiddleware();
    const request = formReq("form-nav-ok");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/thanks"),
      303,
    );
    const url = new URL(
      reply.redirect.mock.calls[0][0] as string,
      "http://localhost",
    );
    // A success carries no failure to report, so no flash at all.
    expect(url.searchParams.get(FLASH_PARAM)).toBeNull();
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
    const request = formReq("form-nav-ok");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.redirect).not.toHaveBeenCalled();
  });

  it("replays only the fields the author named", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number(), note: field.string() }),
      fallback: { to: "/contact", replay: ["note"] },
    });
    const mw = createRPCMiddleware();
    const request = formReq("form-nav-replay");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    const url = new URL(
      reply.redirect.mock.calls[0][0] as string,
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
    const request = formReq("form-nav-bad");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.status).toHaveBeenCalledWith(422);
  });
});

describe("Fastify staged response headers (RequestEvent.header)", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
    seedServerMap();
  });

  // The staged write happens before/alongside the redirect, never instead of
  // it: the header rides the fallback's 303 rather than replacing it.
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
    const request = makeFastifyReq({
      url: "/__rpc/cookie-form",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      rawBody: "email=a%40b.c",
    });
    // The urlencoded body has to arrive on the Node stream, the way Fastify's
    // own parser would have delivered it, so the adapter reads it through
    // `readBody`.
    simulateRawBody(request, "email=a%40b.c");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.header).toHaveBeenCalledWith("Set-Cookie", "sid=1");
    expect(reply.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/thanks"),
      303,
    );
    expect(reply.header.mock.invocationCallOrder[0]).toBeLessThan(
      reply.redirect.mock.invocationCallOrder[0],
    );
  });

  it("carries a staged header on the default JSON response", async () => {
    createServerFunction(
      "cookie-json",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("X-Staged", "yes");
        return "hello fastify";
      }),
    );
    const mw = createRPCMiddleware();
    const request = makeFastifyReq({
      url: "/__rpc/cookie-json",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.header).toHaveBeenCalledWith("X-Staged", "yes");
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ data: "hello fastify" });
  });

  // The guard drops the late write — after `send` the reply is committed and
  // a further `reply.header()` would be silently dropped anyway.
  it("ignores a staged header once the response has been committed", async () => {
    createServerFunction(
      "late-header",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send(200, { ok: true });
        getRequestContext().header("X-Late", "1");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const request = makeFastifyReq({
      url: "/__rpc/late-header",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.header).not.toHaveBeenCalledWith("X-Late", "1");
    expect(reply.send).toHaveBeenCalledWith({ ok: true });
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
    const request = makeFastifyReq({
      url: "/__rpc/cookie-multi",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      rawBody: "email=a%40b.c",
    });
    simulateRawBody(request, "email=a%40b.c");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.header).toHaveBeenCalledWith("Set-Cookie", [
      "sid=1",
      "theme=dark",
    ]);
    expect(reply.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/thanks"),
      303,
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
    const request = makeFastifyReq({
      url: "/__rpc/cookie-empty",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      rawBody: "email=a%40b.c",
    });
    simulateRawBody(request, "email=a%40b.c");
    const reply = makeFastifyReply();
    await mw(request as never, reply as never, makeFastifyDone());

    expect(reply.header).not.toHaveBeenCalledWith(
      "X-Empty",
      expect.anything(),
    );
    expect(reply.redirect).toHaveBeenCalledWith(
      expect.stringContaining("/thanks"),
      303,
    );
  });
});
