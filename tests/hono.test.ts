import { beforeEach, describe, expect, it, vi } from "vitest";

import { field, schema } from "../src/schema.ts";
import { decodeFormFlash, FLASH_PARAM } from "../src/form-fallback.ts";
import { Hono } from "hono";
import EventEmitter from "node:events";
import type { ViteDevServer } from "vite";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import type { DispatchContext } from "../src/types.d.ts";
import {
  getRequestContext,
  redirect as serverRedirect,
  // sendResponse,
} from "../src/context.ts";
import {
  attachRPC,
  attachVite,
  readBody,
  redirect,
  viteMiddleware,
} from "../src/hono/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/hono/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import {
  makeHonoContext,
  makeHonoNext,
  seedServerMap,
} from "./fixtures/hono.ts";

beforeEach(() => {
  serverFunctionsMap.clear();
  seedServerMap();
});

// ─── Hono Helpers ─────────────────────────────────────────────────────

describe("Hono helpers", () => {
  describe("readBody", () => {
    it("should sniff a body with no Content-Type as JSON when it parses", async () => {
      // New in 0.4.0. hono previously returned the raw string here while
      // express, fastify, and koa parsed it — a cross-adapter inconsistency the
      // readBody consolidation surfaced. The lenient sniff is the library's
      // documented behaviour (curl and the nojs form fallback send JSON with no
      // Content-Type), so hono now matches the other four.
      const c = makeHonoContext({ body: '{"hello":"world"}' });
      const result = await readBody(c);
      expect(result.data).toEqual({ hello: "world" });
      // The reported label still reflects the *declared* type, which is absent
      // here — long-standing behaviour, not a consequence of the sniff.
      expect(result.contentType).toBe("text/plain");
    });

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

    it("should return multipart fields from pre-parsed body", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
        body: "ignored",
      });
      (c.env as any).incoming = { body: { name: "artae" } };
      const result = await readBody(c);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { name: "artae" },
      });
    });

    it("should return raw text for multipart when no parser ran", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "multipart/form-data; boundary=xyz" },
        body: "--xyz--",
      });
      const result = await readBody(c);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { raw: "--xyz--" },
      });
    });

    it("should return urlencoded fields from pre-parsed body", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "ignored",
      });
      (c.env as any).incoming = { body: { name: "artae", job: "developer" } };
      const result = await readBody(c);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });

    it("should parse urlencoded body from the request text", async () => {
      const c = makeHonoContext({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=artae&job=developer",
      });
      const result = await readBody(c);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });
  });

  describe("redirect", () => {
    it("should return c.redirect(location, status)", () => {
      const c = makeHonoContext();
      c.redirect = vi.fn(() => new Response(null, { status: 303 }));
      const result = redirect(c, "/target", 303);
      expect(c.redirect).toHaveBeenCalledWith("/target", 303);
      expect(result).toBeInstanceOf(Response);
    });

    it("should return the response and default to 303", () => {
      const c = makeHonoContext();
      c.redirect = vi.fn(() => new Response(null, { status: 303 }));
      const result = redirect(c, "/target");
      expect(c.redirect).toHaveBeenCalledWith("/target", 303);
      expect(result).toBeInstanceOf(Response);
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

  // A whole class of runtimes (Cloudflare Workers, Bun, Deno, standalone
  // serverless adapters, and Hono's own `app.fetch()`) leave `c.env`
  // undefined. The fixtures below always set it, so nothing caught that
  // `readBody`, the disconnect hook and `viteMiddleware` each read `c.env`
  // unguarded — every request on those runtimes threw a TypeError and came back
  // as a 500, even a well-formed one. These tests drive a real `Hono` app
  // through `app.fetch()` so `c.env` is genuinely absent.
  describe("on a runtime without c.env", () => {
    // A native `Request` cannot carry `Host` (forbidden header name), so the
    // default `origin: "self"` policy has nothing to compare against and
    // correctly rejects. These tests are about `c.env` being absent, not about
    // origin policy, so an explicit literal allowlist admits the request and the
    // exact-match tier of the ladder is exercised instead.
    const call = async (path: string, body: unknown, contentType?: string) => {
      const app = new Hono();
      app.use(createRPCMiddleware({ origin: "http://localhost" }));
      return app.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            origin: "http://localhost",
            ...(contentType ? { "content-type": contentType } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    };

    it("dispatches a well-formed JSON body", async () => {
      createServerFunction("hono-env", vi.fn().mockResolvedValue("ok"));
      const res = await call(
        "/__rpc/hono-env",
        ["hi"],
        "application/json",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: "ok" });
    });

    it("passes the parsed argument through", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      createServerFunction("hono-arg", fn);
      await call("/__rpc/hono-arg", { email: "a@b.c" }, "application/json");
      const received = fn.mock.calls[0]?.[1] as unknown;
      expect(received).toEqual({ email: "a@b.c" });
    });

    it("rejects a malformed JSON body with 400, not 500", async () => {
      createServerFunction("hono-bad", vi.fn().mockResolvedValue("ok"));
      const app = new Hono();
      app.use(createRPCMiddleware({ origin: "http://localhost" }));
      const res = await app.fetch(
        new Request("http://localhost/__rpc/hono-bad", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: "{not json",
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Bad Request" });
    });

    it("returns 404 for an unknown function", async () => {
      const res = await call("/__rpc/nope", [], "application/json");
      expect(res.status).toBe(404);
    });

    it("answers 400 for malformed JSON, as h3 does", async () => {
      // Previously a declared-JSON body was parsed by `c.req.json()`, so Hono
      // threw its own HTTPException and rpc re-derived the status. Reading the
      // body ourselves removes that failure mode: there is no host error left to
      // preserve, and a bad body is rpc's own 400 on every adapter.
      createServerFunction("hono-bad-json", vi.fn().mockResolvedValue("ok"));
      const app = new Hono();
      app.use(createRPCMiddleware({ origin: "http://localhost" }));
      const res = await app.fetch(
        new Request("http://localhost/__rpc/hono-bad-json", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: "{not json",
        }),
      );
      expect(res.status).toBe(400);
    });

    it("uses a body a host middleware already read, rather than a spent stream", async () => {
      // A host middleware that touches the body first — an auth step calling
      // `c.req.json()`, say — consumes `c.req.raw` and leaves the result in
      // Hono's body cache under a body-form key. rpc cannot re-read the stream,
      // so it has to take the cache. Note the cache holds the *raw text*, not a
      // parsed object: `c.req.json()` caches the text and parses it itself
      // afterwards, so handing that straight to a pre-parsed path would return
      // the caller a string and silently lose the object.
      createServerFunction(
        "hono-precached",
        vi.fn().mockResolvedValue("ok"),
      );
      const app = new Hono();
      app.use("*", async (c, next) => {
        await c.req.json();
        await next();
      });
      app.use(createRPCMiddleware({ origin: "http://localhost" }));
      const fn = vi.fn().mockResolvedValue("ok");
      createServerFunction("hono-precached-fn", fn);
      const res = await app.fetch(
        new Request("http://localhost/__rpc/hono-precached-fn", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({ n: 7 }),
        }),
      );
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledWith(expect.anything(), { n: 7 });
    });

    it("rejects a malformed ?args= with 400, not 500", async () => {
      const fn = vi.fn();
      createServerFunction("hono-malformed-args", fn, { method: "GET" });
      const app = new Hono();
      app.use(createRPCMiddleware({ origin: "http://localhost" }));
      const res = await app.fetch(
        new Request(
          "http://localhost/__rpc/hono-malformed-args?args=not%20json",
          { headers: { origin: "http://localhost" } },
        ),
      );
      expect(fn).not.toHaveBeenCalled();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Bad Request" });
    });
  });

  it("should return 404 for unknown function", async () => {
    seedServerMap();
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/noSuchFn" });
    const next = makeHonoNext();
    await mw(c, next);
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
      method: "POST",
      body: JSON.stringify(["arg1"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ data: "hello hono" }, 200);
  });

  it("should use default prefix when rpcPrefix is undefined", async () => {
    createServerFunction(
      "hono-hello",
      vi.fn().mockResolvedValue("hello hono"),
    );
    const mw = createRPCMiddleware({ rpcPrefix: undefined });
    const c = makeHonoContext({
      path: "/__rpc/hono-hello",
      method: "POST",
      body: JSON.stringify(["arg1"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ data: "hello hono" }, 200);
  });

  it("should expose request context to server functions", async () => {
    let seenC: unknown;
    createServerFunction(
      "hono-context",
      vi.fn().mockImplementation(async (_signal: AbortSignal) => {
        seenC = getRequestContext().nativeEvent;
        return "ok";
      }),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-context",
      method: "POST",
      body: JSON.stringify([]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(seenC).toBe(c);
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should return c.redirect when the function redirects", async () => {
    createServerFunction(
      "hono-redirect",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-redirect",
      method: "POST",
      body: JSON.stringify([]),
    });
    c.redirect = vi.fn((location: string, status: number) => ({
      location,
      status,
    }));
    const next = makeHonoNext();
    const result = await mw(c, next);
    expect(c.redirect).toHaveBeenCalledWith("/login", 303);
    expect(result).toEqual({ location: "/login", status: 303 });
    expect(c.json).not.toHaveBeenCalled();
  });

  it("should return c.body when the function sends a response", async () => {
    createServerFunction(
      "hono-send",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send?.(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-send",
      method: "POST",
      body: JSON.stringify([]),
    });
    c.body = vi.fn(() => new Response());
    const next = makeHonoNext();
    const result = await mw(c, next);
    expect(c.body).toHaveBeenCalledWith(
      JSON.stringify({ error: "Rate limit exceeded" }),
      429,
      { "content-type": "application/json", "retry-after": "30" },
    );
    expect(result).toBeInstanceOf(Response);
    expect(c.json).not.toHaveBeenCalled();
  });

  it("should expose functionName via the request context", async () => {
    let seenName: string | undefined;
    createServerFunction(
      "hono-context-send",
      vi.fn().mockImplementation(async () => {
        seenName = getRequestContext().functionName;
        return "ok";
      }),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-context-send",
      method: "POST",
      body: JSON.stringify([]),
    });
    c.body = vi.fn(() => new Response());
    const next = makeHonoNext();
    await mw(c, next);
    expect(seenName).toBe("hono-context-send");
  });

  it("should use default 303 when redirect is called without a status", async () => {
    createServerFunction(
      "hono-redirect-default",
      vi.fn().mockImplementation(async () => {
        getRequestContext().redirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-redirect-default",
      method: "POST",
      body: JSON.stringify([]),
    });
    c.redirect = vi.fn((location: string, status: number) => ({
      location,
      status,
    }));
    const next = makeHonoNext();
    const result = await mw(c, next);
    expect(c.redirect).toHaveBeenCalledWith("/login", 303);
    expect(result).toEqual({ location: "/login", status: 303 });
    expect(c.json).not.toHaveBeenCalled();
  });

  it("should pass args from JSON body to function", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("echoFn", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/echoFn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["a", "b"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "a", "b");
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("jsonFn", vi.fn().mockResolvedValue("ok"));
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/jsonFn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=artae",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Unsupported Media Type" },
      415,
    );
  });

  it("should return 415 when text-declared function gets json body", async () => {
    createServerFunction(
      "textFn",
      vi.fn().mockResolvedValue("ok"),
      { contentType: "text/plain" },
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      method: "POST",
      path: "/__rpc/textFn",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["hello"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Unsupported Media Type" },
      415,
    );
  });

  it("should accept urlencoded body for multipart-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "mpFn",
      fn,
      { contentType: "multipart/form-data" },
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      method: "POST",
      path: "/__rpc/mpFn",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=artae",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
    });
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should accept multipart body for urlencoded-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "urlFn",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      method: "POST",
      path: "/__rpc/urlFn",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body:
        '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      raw: expect.stringContaining('name="a"'),
    });
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should exempt requests without a Content-Type header (curl compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("noHeaderFn", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      method: "POST",
      path: "/__rpc/noHeaderFn",
      body: "plain",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "plain");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
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
      method: "POST",
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
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    createServerFunction(
      "errFn",
      vi.fn().mockRejectedValue(new Error("hono oops")),
    );
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/errFn", method: "POST" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Internal Server Error" },
      500,
    );
    process.env.NODE_ENV = prevEnv;
  });

  it("should call next() when prefix doesn't match", async () => {
    seedServerMap();
    const mw = createRPCMiddleware({ rpcPrefix: "_sv" });
    const c = makeHonoContext({ path: "/other/path" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("hono-get-only", vi.fn());
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/hono-get-only", method: "GET" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith(
      { error: "Method Not Allowed" },
      405,
    );
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("hono-public");
    createServerFunction("hono-public", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: `/__rpc/hono-public?args=${
        encodeURIComponent(
          JSON.stringify(["news"]),
        )
      }`,
      method: "GET",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(c.json).toHaveBeenCalledWith({ data: "hono-public" }, 200);
  });

  it("should dispatch GET functions without args query param", async () => {
    const fn = vi.fn().mockResolvedValue("no-args");
    createServerFunction("hono-public-no-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-public-no-args",
      method: "GET",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(c.json).toHaveBeenCalledWith({ data: "no-args" }, 200);
  });

  it("should return 400 when GET ?args= is not a JSON array", async () => {
    const fn = vi.fn();
    createServerFunction("hono-public-bad-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: `/__rpc/hono-public-bad-args?args=${encodeURIComponent('{"a":1}')}`,
      method: "GET",
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).not.toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledWith({ error: "Bad Request" }, 400);
  });

  it("should dispatch functions registered without options (default POST)", async () => {
    serverFunctionsMap.set("hono-plain", {
      name: "hono-plain",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("plain"),
        cancel: vi.fn(),
      }),
    });
    const mw = createRPCMiddleware();
    const c = makeHonoContext({ path: "/__rpc/hono-plain", method: "POST" });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ data: "plain" }, 200);
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("hono-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });

  it("should pass requests without an Origin header when origin is set", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["x"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should pass requests whose Origin matches the configured origin (single string, back-compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify(["x"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should return 403 when Origin is absent and Sec-Fetch-Site is cross-site", async () => {
    createServerFunction("hono-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { origin: undefined, "sec-fetch-site": "cross-site" },
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });

  it("should pass when Origin is absent and Sec-Fetch-Site is same-origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: {
        origin: undefined,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(["x"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("default policy rejects a cross-origin request with no options at all", async () => {
    // Proves the secure default is wired through this adapter, not merely
    // implemented in the shared helper. Creating the middleware with no options
    // must already be protected.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { origin: "https://evil.com", "sec-fetch-site": "cross-site" },
      body: JSON.stringify(["x"]),
    });
    await mw(c, makeHonoNext());
    expect(fn).not.toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });

  it("default policy admits the server's own host, comparing host only", async () => {
    // `http://` against the fixture's `Host` proves the scheme is not part of
    // the comparison, so a TLS-terminating proxy needs no configuration.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { host: "app.example.com", origin: "http://app.example.com" },
      body: JSON.stringify(["x"]),
    });
    await mw(c, makeHonoNext());
    expect(fn).toHaveBeenCalled();
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("sibling subdomain survives: allowlisted Origin + same-site passes", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "sec-fetch-site": "same-site",
        "content-type": "application/json",
      },
      body: JSON.stringify(["x"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should pass requests whose Origin matches one entry of an allowlist array", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify(["x"]),
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("should return 403 when Origin matches no entry of an allowlist array", async () => {
    createServerFunction("hono-fn", vi.fn());
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });

  it('should return 403 for Origin: "null" when an allowlist is set', async () => {
    createServerFunction("hono-fn", vi.fn());
    const mw = createRPCMiddleware({ origin: ["https://app.example.com"] });
    const c = makeHonoContext({
      path: "/__rpc/hono-fn",
      method: "POST",
      headers: { origin: "null" },
    });
    const next = makeHonoNext();
    await mw(c, next);
    expect(c.json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });

  it("should not crash when env.incoming is missing", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-bare", fn);
    const mw = createRPCMiddleware();
    const c = makeHonoContext({
      path: "/__rpc/hono-bare",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["x"]),
    });
    c.env = {}; // no incoming stream (e.g. bare serverless adapter)
    const next = makeHonoNext();
    await mw(c, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(c.json).toHaveBeenCalledWith({ data: "ok" }, 200);
  });

  it("validates the input against the function schema before dispatch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("validated", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
      hint: "a single function-wide hint",
    });
    const mw = createRPCMiddleware({ allowHeaderless: true });
    const ok = makeHonoContext({
      path: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c" }),
    });
    await mw(ok, makeHonoNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      email: "a@b.c",
    });
    expect(ok.json).toHaveBeenCalledWith({ data: "ok" }, 200);

    const bad = makeHonoContext({
      path: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 5 }),
    });
    await mw(bad, makeHonoNext());
    expect(bad.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Validation failed" }),
      422,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    const body = bad.json.mock.calls.at(-1)?.[0] as { hint?: string };
    expect(body.hint).toMatch(
      /^a single function-wide hint — .*wiki\/server-functions\.md#input-validation$/,
    );

    // Without a function-wide hint, the pointer stands alone.
    createServerFunction("validated", vi.fn(), {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
    });
    const plain = makeHonoContext({
      path: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 5 }),
    });
    await mw(plain, makeHonoNext());
    expect(
      (plain.json.mock.calls.at(-1)?.[0] as { hint?: string }).hint,
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
    const bad = makeHonoContext({
      path: "/__rpc/array-payload",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([[1, 2]]),
    });
    await mw(bad, makeHonoNext());
    expect(fn).not.toHaveBeenCalled();
    expect(bad.json).toHaveBeenCalledWith({ error: "Bad Request" }, 400);
  });
});

/* ─── onDispatch ────────────────────────────────────────────────────────────
 * hono returns a `Response`, so the id is merged by cloning and re-serialising
 * the body — the one adapter whose `withId` has to be async.
 */

describe("hono onDispatch", () => {
  const HOST = "http://localhost";
  const seen: DispatchContext[] = [];

  const go = async (
    path: string,
    body: unknown = [],
    headers: Record<string, string> = {},
  ) => {
    const app = new Hono();
    app.use(
      createRPCMiddleware({
        origin: HOST,
        onDispatch: (ctx: DispatchContext) => {
          seen.push(ctx);
        },
      }),
    );
    const res = await app.fetch(
      new Request(`${HOST}${path}`, {
        method: "POST",
        headers: {
          origin: HOST,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  beforeEach(() => {
    serverFunctionsMap.clear();
    seen.length = 0;
  });

  it("records a successful dispatch", async () => {
    createServerFunction("hono-ok", vi.fn().mockResolvedValue("ok"));
    const { status } = await go("/__rpc/hono-ok", ["x"]);
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prefix: "__rpc",
      functionName: "hono-ok",
      method: "POST",
      declaredMethod: "POST",
      declaredContentType: "application/json",
      contentTypeMatched: true,
      status: 200,
      outcome: "ok",
    });
  });

  it("shapes the args and never records a value", async () => {
    createServerFunction("hono-shape", vi.fn().mockResolvedValue("ok"));
    await go("/__rpc/hono-shape", [{ a: 1, password: "correct-horse" }]);
    expect(seen[0].argShape).toBe("[{a:number,password:string}]");
    expect(JSON.stringify(seen[0])).not.toContain("correct-horse");
  });

  it("records the 404 and lists the sibling names", async () => {
    createServerFunction("hono-known", vi.fn().mockResolvedValue("ok"));
    const { status } = await go("/__rpc/nope");
    expect(status).toBe(404);
    expect(seen[0]).toMatchObject({
      functionName: "nope",
      status: 404,
      outcome: "client-error",
    });
    expect(seen[0].registeredNames).toContain("hono-known");
  });

  it("records the origin rejection", async () => {
    createServerFunction("hono-forbidden", vi.fn().mockResolvedValue("ok"));
    const app = new Hono();
    app.use(createRPCMiddleware({
      origin: HOST,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
    }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-forbidden`, {
        headers: { origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
    expect(seen[0]).toMatchObject({ status: 403, originTier: "origin" });
  });

  it("records a thrown handler as a server error", async () => {
    createServerFunction(
      "hono-boom",
      vi.fn().mockRejectedValue(new Error("b")),
    );
    const { status } = await go("/__rpc/hono-boom");
    expect(status).toBe(500);
    expect(seen[0]).toMatchObject({
      status: 500,
      outcome: "server-error",
    });
  });

  it("merges the id into the Response body, and the record agrees", async () => {
    const { body } = await go("/__rpc/nope");
    const id = (body as { id?: string }).id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0].id).toBe(id);
  });

  it("leaves the body alone with no hook registered", async () => {
    seedServerMap();
    const app = new Hono();
    app.use(createRPCMiddleware({ origin: HOST }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/noSuchFn`, { headers: { origin: HOST } }),
    );
    expect(await res.json()).toEqual({ error: "Function not found" });
  });

  it("records a declared contentType, not just the default", async () => {
    createServerFunction("hono-text", vi.fn().mockResolvedValue("hi"), {
      contentType: "text/plain",
    });
    const app = new Hono();
    app.use(createRPCMiddleware({
      origin: HOST,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
    }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-text`, {
        method: "POST",
        headers: { origin: HOST, "content-type": "text/plain" },
        body: "[]",
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      declaredContentType: "text/plain",
      actualContentType: "text/plain",
      contentTypeMatched: true,
    });
  });

  it("records a GET function called with no ?args= at all", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-noargs", handler, { method: "GET" });
    const app = new Hono();
    app.use(createRPCMiddleware({
      origin: HOST,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
    }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-noargs`, { headers: { origin: HOST } }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      functionName: "hono-noargs",
      status: 200,
      argShape: "[]",
    });
  });

  it("falls back to the default contentType for a hand-registered entry", async () => {
    serverFunctionsMap.set("no-options", {
      handler: (async () => "bare") as never,
    } as never);
    const app = new Hono();
    app.use(createRPCMiddleware({
      origin: HOST,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
    }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/no-options`, {
        method: "POST",
        headers: { origin: HOST, "content-type": "application/json" },
        body: "[]",
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ declaredContentType: "application/json" });
  });

  it("does not take down the request when the hook throws", async () => {
    createServerFunction("hono-throw", vi.fn().mockResolvedValue("ok"));
    const app = new Hono();
    app.use(createRPCMiddleware({
      origin: HOST,
      onDispatch: () => {
        throw new Error("log exploded");
      },
    }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-throw`, {
        method: "POST",
        headers: { origin: HOST, "content-type": "application/json" },
        body: "[]",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("Hono bodyLimit", () => {
  const HOST = "http://localhost";

  // `headers` is merged rather than spread from an `init` object: spreading
  // `init` after `headers` replaced the whole record, dropping `origin` and
  // turning these into 403s from the cross-origin check instead of the 413
  // under test.
  const post = (
    body: BodyInit,
    headers: Record<string, string> = {},
    fn = "hono-limit",
    extra: RequestInit = {},
  ) =>
    new Request(`${HOST}/__rpc/${fn}`, {
      method: "POST",
      headers: {
        origin: HOST,
        "content-type": "application/json",
        ...headers,
      },
      body,
      ...extra,
    });

  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("caps a declared-JSON body, which is the case that was uncapped", async () => {
    // This is the regression guard. `readBody` used to return early for
    // declared-JSON via `c.req.json()`, which reads the stream itself and sits
    // on no capped path — so `bodyLimit` silently did not apply to JSON on
    // Hono, while it applied to every other content type and to the identical
    // body on h3. The suite had no Hono cap test at all, which is how that
    // survived at 100% line coverage: coverage measured that the branch ran,
    // not that it bounded anything.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-limit", fn);
    const app = new Hono();
    app.use(createRPCMiddleware({ origin: HOST, bodyLimit: 64 }));

    const res = await app.fetch(post(JSON.stringify(["x".repeat(4096)])));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Payload Too Large" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("caps a body with no Content-Length, so the cap is enforced while streaming", async () => {
    // A `Content-Length` pre-check is not a cap: a Request built in JavaScript
    // carries none, which is the normal case for `app.fetch()`, Workers, Bun,
    // Deno and serverless. This is the path that must actually count bytes.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-limit", fn);
    const app = new Hono();
    app.use(createRPCMiddleware({ origin: HOST, bodyLimit: 64 }));

    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(["x".repeat(4096)])));
        c.close();
      },
    });
    const res = await app.fetch(
      post(chunked as unknown as BodyInit, {}, "hono-limit", {
        // @ts-expect-error - Node requires this for a streaming request body
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts a body under the cap", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-limit", fn);
    const app = new Hono();
    app.use(createRPCMiddleware({ origin: HOST, bodyLimit: 1024 }));

    const res = await app.fetch(post(JSON.stringify(["small"])));
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caps a text body too, so the behaviour matches h3 for every content type", async () => {
    createServerFunction("hono-limit-text", vi.fn().mockResolvedValue("ok"), {
      contentType: "text/plain",
    });
    const app = new Hono();
    app.use(createRPCMiddleware({ origin: HOST, bodyLimit: 64 }));

    const res = await app.fetch(
      post(
        "x".repeat(4096),
        { "content-type": "text/plain" },
        "hono-limit-text",
      ),
    );
    expect(res.status).toBe(413);
  });
});

describe("Hono body cache", () => {
  const HOST = "http://localhost";

  /**
   * `c.req.bodyCache` is keyed by *body form*, and Hono stores the raw body
   * under the form key its accessor was asked for — `c.req.json()` asks for
   * `text` and parses the result itself. So the same cache can hand rpc a parsed
   * value or raw bytes depending on who wrote it, and those need different
   * treatment. Each case below writes the cache directly, which is what a host
   * middleware does.
   */
  const withCache = async (
    key: string,
    value: unknown,
    declared: string,
    // the function's declared content type, so content-type strictness does not
    // answer 415 before the body is ever read
    fnContentType: "json" | "text" = "json",
  ) => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-cache", fn, {
      ...(fnContentType === "text" ? { contentType: "text/plain" } : {}),
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      // Hono types the cache as `Partial<Body>`, so a dynamic key needs the cast
      // the production code also needs.
      (c.req.bodyCache as Record<string, Promise<unknown>>)[key] = Promise
        .resolve(value);
      await next();
    });
    app.use(createRPCMiddleware({ origin: HOST }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-cache`, {
        method: "POST",
        headers: { origin: HOST, "content-type": declared },
        body: "consumed-elsewhere",
      }),
    );
    return { res, fn };
  };

  it("parses a cached raw text body, which is what c.req.json() leaves", async () => {
    const { res, fn } = await withCache(
      "text",
      '{"n":7}',
      "application/json",
    );
    expect(res.status).toBe(200);
    // The text must be parsed, not handed through as a string.
    expect(fn).toHaveBeenCalledWith(expect.anything(), { n: 7 });
  });

  it("accepts a cached value already parsed under the json key", async () => {
    const { res, fn } = await withCache("json", { n: 7 }, "application/json");
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(expect.anything(), { n: 7 });
  });

  it("accepts a cached non-string raw body", async () => {
    // `arrayBuffer` / `blob` / `formData` all hold bytes, not text, so they take
    // the pre-parsed path rather than `parseRawBody`.
    const { res } = await withCache(
      "arrayBuffer",
      new TextEncoder().encode("payload").buffer,
      "text/plain",
      "text",
    );
    expect(res.status).toBe(200);
  });

  it("prefers a parsed json entry over raw text when both are cached", async () => {
    // Hono's own lookup accepts whichever form was cached first, so a cache
    // holding both is ambiguous by construction. Whichever wins, the caller
    // must get a parsed object rather than a raw string.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("hono-cache", fn);
    const app = new Hono();
    app.use("*", async (c, next) => {
      const cache = c.req.bodyCache as Record<string, Promise<unknown>>;
      cache.json = Promise.resolve({ n: 1 });
      cache.text = Promise.resolve('{"n":2}');
      await next();
    });
    app.use(createRPCMiddleware({ origin: HOST }));
    const res = await app.fetch(
      new Request(`${HOST}/__rpc/hono-cache`, {
        method: "POST",
        headers: { origin: HOST, "content-type": "application/json" },
        body: "x",
      }),
    );
    expect(res.status).toBe(200);
    const received = fn.mock.calls[0]?.[1] as { n: number };
    expect(received.n).toBe(1);
  });
});

describe("Hono no-JS form fallback (dispatch)", () => {
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
    return makeHonoContext({
      path: "/__rpc/contact",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept },
      body: BODIES[kind],
    });
  };

  // The load-bearing claim: a rejected *navigation* redirects. It only holds
  // because the fallback branch sits ahead of the client-error branch, which
  // would otherwise claim the ValidationError and answer a 422 JSON body.
  it("redirects a rejected native form instead of answering 422", async () => {
    const handler = vi.fn().mockResolvedValue("sent");
    createServerFunction("contact", handler, {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
      fallback: "/contact",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad");
    await mw(ctx as never, makeHonoNext());
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toContain(
      "/contact",
    );
    const flash = decodeFormFlash(
      new URL(ctx.redirect.mock.calls[0]?.[0] as string, "http://localhost")
        .searchParams.get(FLASH_PARAM)!,
    );
    expect(flash!.errors?.age).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  // The other load-bearing claim: the generated stub posts form encodings too,
  // so the discriminator has to be the navigation, not the content type.
  it("leaves a fetch from the client stub on the JSON path", async () => {
    const handler = vi.fn().mockResolvedValue("sent");
    createServerFunction("contact", handler, {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
      fallback: "/contact",
    });
    const mw = createRPCMiddleware();
    const ctx = formCtx("bad", "application/json");
    await mw(ctx as never, makeHonoNext());
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
    await mw(ctx as never, makeHonoNext());
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
    await mw(ctx as never, makeHonoNext());
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
    await mw(ctx as never, makeHonoNext());
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
    await mw(ctx as never, makeHonoNext());
    expect(ctx.redirect.mock.calls[0]?.[0] as string ?? null).toBe(null);
  });
});
