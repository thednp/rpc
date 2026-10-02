import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { field, schema } from "../src/schema.ts";
import { decodeFormFlash, FLASH_PARAM } from "../src/form-fallback.ts";
import type { StandardSchemaV1 } from "../src/types.d.ts";
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
import { scannedServerFiles } from "../src/scanForServerFiles.ts";
import {
  attachRPC,
  attachVite,
  getRequestDetails,
  getResponseDetails,
  readBody,
  redirect,
} from "../src/express/helpers.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/express/createMiddleware.ts";
import { createServerFunction } from "../src/createFunction.ts";
import { clientErrorStatus } from "../src/server-helpers.ts";
import type { JsonValue } from "../src/types.d.ts";
import type { DispatchContext } from "../src/types.d.ts";
import { setGlobalPrefix } from "../src/server.ts";
import rpcPlugin, { loadRPCConfig } from "../src/index.ts";
import { defineConfig } from "../src/config.ts";
import { defaultRPCOptions } from "../src/options.ts";
import {
  makeNext,
  makeReq,
  makeRes,
  seedServerMap,
  simulateBody,
} from "./fixtures/express.ts";

beforeEach(() => {
  for (const map of serverFunctionsByPrefix.values()) {
    map.clear();
  }
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

    it("should sniff a body with no Content-Type as JSON when it parses", async () => {
      // No Content-Type at all (curl, and the nojs form fallback): the lenient
      // sniff must stay, or a headerless JSON body would arrive as a string.
      const req = makeReq({});
      const p = readBody(req);
      simulateBody(req, '{"hello":"world"}');
      const result = await p;
      expect(result.data).toEqual({ hello: "world" });
    });

    it("should resolve as text when a non-JSON body does not parse", async () => {
      const req = makeReq({});
      const p = readBody(req);
      simulateBody(req, "not-json");
      const result = await p;
      expect(result.contentType).toBe("text/plain");
      expect(result.data).toBe("not-json");
    });

    it("should reject with a 400 when a declared JSON body does not parse", async () => {
      // Previously this resolved as `text/plain` with the raw string — a
      // JSON-declared function silently received a string and answered 200.
      // A malformed body is a client error, and every supported host framework
      // answers 400 here.
      const req = makeReq({ headers: { "content-type": "application/json" } });
      const p = readBody(req);
      simulateBody(req, "not-json");
      await expect(p).rejects.toMatchObject({ status: 400 });
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

    it("should return multipart fields when req.body is set by a multipart parser", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "multipart/form-data; boundary=xyz",
        },
      });
      (req as any).body = { name: "artae", file: "data" };
      const result = await readBody(req);
      expect(result).toEqual({
        contentType: "multipart/form-data",
        data: { name: "artae", file: "data" },
      });
    });

    it("should return raw stream data for multipart when no parser ran", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "multipart/form-data; boundary=xyz",
        },
      });
      const p = readBody(req);
      simulateBody(
        req,
        '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
      );
      const result = await p;
      expect(result.contentType).toBe("multipart/form-data");
      expect(result.data).toEqual({
        raw: expect.stringContaining('name="a"'),
      });
    });

    it("should return urlencoded fields when req.body is set by express.urlencoded()", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      (req as any).body = { name: "artae", job: "developer" };
      const result = await readBody(req);
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });

    it("should parse urlencoded body from the raw stream", async () => {
      const req = makeReq({
        originalUrl: "/test",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      const p = readBody(req);
      simulateBody(req, "name=artae&job=developer");
      const result = await p;
      expect(result).toEqual({
        contentType: "application/x-www-form-urlencoded",
        data: { name: "artae", job: "developer" },
      });
    });
  });

  describe("redirect", () => {
    it("should use Express res.redirect(status, url) on an Express response", () => {
      const res = makeRes();
      (res as any).redirect = vi.fn();
      redirect(res, "/issue/123", 303);
      expect(res.redirect).toHaveBeenCalledWith(303, "/issue/123");
    });

    it("should default to 303 See Other", () => {
      const res = makeRes();
      (res as any).redirect = vi.fn();
      redirect(res, "/target");
      expect(res.redirect).toHaveBeenCalledWith(303, "/target");
    });

    it("should write raw statusCode + Location on a bare ServerResponse", () => {
      const res = makeRes();
      delete (res as any).json;
      delete (res as any).send;
      delete (res as any).header;
      delete (res as any).status;
      redirect(res, "/back", 301);
      expect(res.statusCode).toBe(301);
      expect(res.setHeader).toHaveBeenCalledWith("Location", "/back");
      expect(res.end).toHaveBeenCalled();
    });

    it("should set statusCode to 303 by default on a bare ServerResponse", () => {
      const res = makeRes();
      delete (res as any).json;
      delete (res as any).send;
      delete (res as any).header;
      delete (res as any).status;
      redirect(res, "/back");
      expect(res.statusCode).toBe(303);
      expect(res.setHeader).toHaveBeenCalledWith("Location", "/back");
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

  it("createRPCMiddleware should call next() on rpcPrefix mismatch", async () => {
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

  it("should filter by rpcPrefix match with handler", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const req = makeReq({ originalUrl: "/__rpc/hello" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("should NOT match on prefix boundary bypass", async () => {
    const handler = vi.fn();
    const mw = createMiddleware({ rpcPrefix: "__rpc", handler });
    const req = makeReq({ originalUrl: "/__rpc-evil/hello" });
    const res = makeRes();
    const next = makeNext();
    await mw(req, res, next);
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Express no-JS form fallback (dispatch)", () => {
  const formHeaders = (accept: string) => ({
    "content-type": "application/x-www-form-urlencoded",
    accept,
  });

  beforeEach(() => {
    serverFunctionsMap.clear();
    seedServerMap();
  });

  // The load-bearing claim: a rejected *navigation* is a redirect, not a 422.
  // This is the case the feature exists for, and it only holds because the
  // fallback branch sits ahead of the client-error branch.
  it("redirects a rejected native form instead of answering 422", async () => {
    createServerFunction(
      "contact",
      vi.fn().mockResolvedValue("sent"),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        schema: schema({ age: field.number() }),
        fallback: "/contact",
      },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("text/html,application/xhtml+xml"),
    });
    const res = makeRes();
    simulateBody(req, "age=not-a-number");
    await mw(req, res, makeNext());

    expect(res.redirect).toHaveBeenCalledWith(
      303,
      expect.stringContaining("/contact"),
    );
    const location = res.redirect.mock.calls[0][1] as string;
    expect(location).toBeDefined();
    const url = new URL(location, "https://app.example.com");
    expect(url.pathname).toBe("/contact");
    const flash = decodeFormFlash(url.searchParams.get(FLASH_PARAM)!);
    expect(flash!.errors?.age).toBeDefined();
    // …and it must not ALSO have written a 422 body.
    expect(res.status).not.toHaveBeenCalledWith(422);
  });

  // The other load-bearing claim: the generated stub uses form encodings too, so
  // the discriminator has to be the navigation, not the content type.
  it("leaves a fetch from the client stub on the JSON path", async () => {
    createServerFunction(
      "contact",
      vi.fn().mockResolvedValue("sent"),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        schema: schema({ age: field.number() }),
        fallback: "/contact",
      },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("application/json"),
    });
    const res = makeRes();
    simulateBody(req, "age=not-a-number");
    await mw(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects a successful navigation to the author's target", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      fallback: "/thanks",
    });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("text/html"),
    });
    const res = makeRes();
    simulateBody(req, "email=a%40b.c");
    await mw(req, res, makeNext());

    expect(res.redirect).toHaveBeenCalledWith(
      303,
      expect.stringContaining("/thanks"),
    );
    const location = res.redirect.mock.calls[0][1] as string;
    expect(new URL(location, "https://app.example.com").pathname).toBe(
      "/thanks",
    );
    // A success carries no failure to report.
    expect(
      decodeFormFlash(
        new URL(location, "https://app.example.com").searchParams.get(
          FLASH_PARAM,
        )!,
      )?.errors,
    )
      .toBeUndefined();
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
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("text/html"),
    });
    const res = makeRes();
    simulateBody(req, "email=a%40b.c");
    await mw(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("replays only the fields the author named", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number(), note: field.string() }),
      fallback: { to: "/contact", replay: ["note"] },
    });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("text/html"),
    });
    const res = makeRes();
    simulateBody(req, "age=nope&note=hello");
    await mw(req, res, makeNext());

    const location = res.redirect.mock.calls[0][1] as string;
    const flash = decodeFormFlash(
      new URL(location, "https://app.example.com").searchParams.get(
        FLASH_PARAM,
      )!,
    );
    expect(flash!.values).toEqual({ note: "hello" });
    expect(JSON.stringify(flash)).not.toContain("nope");
  });

  // A handler may redirect itself through the request context. That is a more
  // specific answer than the author's fallback target, so the success path must
  // not overwrite it — otherwise the handler's own redirect silently becomes
  // the fallback.
  it("leaves a handler-issued redirect alone", async () => {
    createServerFunction(
      "contact",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/handler-chosen");
        return "sent";
      }),
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        fallback: "/fallback-target",
      },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    });
    const res = makeRes();
    simulateBody(req, "email=a%40b.c");
    await mw(req, res, makeNext());

    const location = res.redirect.mock.calls[0]?.[1] as string;
    expect(location).toContain("/handler-chosen");
    expect(location).not.toContain("/fallback-target");
  });

  it("does not redirect when the function sets no fallback", async () => {
    createServerFunction("contact", vi.fn().mockResolvedValue("sent"), {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      schema: schema({ age: field.number() }),
    });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/contact",
      method: "POST",
      headers: formHeaders("text/html"),
    });
    const res = makeRes();
    simulateBody(req, "age=nope");
    await mw(req, res, makeNext());

    expect(res.status).toHaveBeenCalledWith(422);
  });
});

describe("Express staged response headers (RequestEvent.header)", () => {
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
    const req = makeReq({
      originalUrl: "/__rpc/cookie-form",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
    });
    const res = makeRes();
    simulateBody(req, "email=a%40b.c");
    await mw(req, res, makeNext());

    expect(res.header).toHaveBeenCalledWith("Set-Cookie", "sid=1");
    expect(res.redirect).toHaveBeenCalledWith(
      303,
      expect.stringContaining("/thanks"),
    );
    expect(res.header.mock.invocationCallOrder[0]).toBeLessThan(
      res.redirect.mock.invocationCallOrder[0],
    );
  });

  it("carries a staged header on the default JSON response", async () => {
    createServerFunction(
      "cookie-json",
      vi.fn().mockImplementation(async () => {
        getRequestContext().header("X-Staged", "yes");
        return "hello";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/cookie-json",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, makeNext());

    expect(res.header).toHaveBeenCalledWith("X-Staged", "yes");
    expect(res.status).toHaveBeenCalledWith(200);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ data: "hello" });
  });

  // The guard drops the late write instead of throwing ERR_HTTP_HEADERS_SENT —
  // and the committed send is what the client got.
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
    const req = makeReq({
      originalUrl: "/__rpc/late-header",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, makeNext());

    expect(res.header).not.toHaveBeenCalledWith("X-Late", "1");
    expect(res.status).toHaveBeenCalledWith(200);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ ok: true });
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

  it("should use default prefix when rpcPrefix is undefined", async () => {
    createServerFunction("hello-fn", vi.fn().mockResolvedValue("hello"));
    const mw = createRPCMiddleware({ rpcPrefix: undefined });
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

  it("should expose request context to server functions", async () => {
    let seenLocals: unknown;
    createServerFunction(
      "ctx-fn",
      vi.fn().mockImplementation(async (_signal: AbortSignal) => {
        seenLocals = getRequestContext().locals;
        getRequestContext().locals.user = "alice";
        return (getRequestContext().locals as { user: string }).user;
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/ctx-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    res.locals = {};
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ data: "alice" });
    expect(seenLocals).toBe(res.locals);
  });

  it("should skip the JSON send when the function redirects", async () => {
    createServerFunction(
      "redirect-fn",
      vi.fn().mockImplementation(async () => {
        serverRedirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/redirect-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    res.redirect = vi.fn();
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(303, "/login");
    expect(res.send).not.toHaveBeenCalled();
  });

  it("should short-circuit with send status, body and headers", async () => {
    createServerFunction(
      "send-fn",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/send-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.header).toHaveBeenCalledWith("retry-after", "30");
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Rate limit exceeded" });
  });

  it("should short-circuit with send without headers", async () => {
    createServerFunction(
      "send-no-headers",
      vi.fn().mockImplementation(async () => {
        getRequestContext().send(204, null);
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/send-no-headers",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.header).not.toHaveBeenCalledWith("retry-after", "30");
    expect(res.send).toHaveBeenCalledWith("null");
  });

  it("should expose functionName via the request context", async () => {
    let seenName: string | undefined;
    createServerFunction(
      "send-context-fn",
      vi.fn().mockImplementation(async () => {
        seenName = getRequestContext().functionName;
        return "ok";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/send-context-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(seenName).toBe("send-context-fn");
  });

  it("should use default 303 when redirect is called without a status", async () => {
    createServerFunction(
      "redirect-default-fn",
      vi.fn().mockImplementation(async () => {
        getRequestContext().redirect("/login");
        return "ignored";
      }),
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/redirect-default-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    res.redirect = vi.fn();
    const next = makeNext();
    simulateBody(req, JSON.stringify([]));
    await mw(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(303, "/login");
    expect(res.send).not.toHaveBeenCalled();
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

  it("should pass parsed urlencoded body as single object arg", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "form-fn",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/form-fn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, "name=artae&job=developer");
    await mw(req, res, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
      job: "developer",
    });
  });

  // ─── content-type enforcement ──────────────────────────────────────

  it("should return 415 when json-declared function gets urlencoded body", async () => {
    createServerFunction("json-fn", vi.fn().mockResolvedValue("ok"));
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/json-fn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, "name=artae");
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(415);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Unsupported Media Type" });
  });

  it("should return 415 when text-declared function gets json body", async () => {
    createServerFunction(
      "text-fn",
      vi.fn().mockResolvedValue("ok"),
      { contentType: "text/plain" },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/text-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["hello"]));
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(415);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Unsupported Media Type" });
  });

  it("should accept urlencoded body for multipart-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "mp-fn",
      fn,
      { contentType: "multipart/form-data" },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/mp-fn",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, "name=artae");
    await mw(req, res, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      name: "artae",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should accept multipart body for urlencoded-declared function (lenient forms)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction(
      "form-fn2",
      fn,
      { contentType: "application/x-www-form-urlencoded" },
    );
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/form-fn2",
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(
      req,
      '--xyz\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\n',
    );
    await mw(req, res, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      raw: expect.stringContaining('name="a"'),
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should exempt requests without a Content-Type header (curl compat)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("noheader-fn", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({ originalUrl: "/__rpc/noheader-fn", method: "POST" });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, next);
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(res.status).toHaveBeenCalledWith(200);
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
    getFunctionsForPrefix("__A_server").set("testFn", {
      name: "testFn",
      handler: vi.fn().mockReturnValue({
        data: Promise.resolve("ok"),
        cancel: vi.fn(),
      }),
    });
    const mw = createRPCMiddleware({ rpcPrefix: "__A_server" });
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
    const handler = getFunctionsForPrefix("__A_server").get("testFn")!.handler;
    expect(handler).toHaveBeenCalledWith({ key: "value" });
  });

  it("should return 500 on handler error", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
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
    process.env.NODE_ENV = prevEnv;
  });

  it("should return 405 when method does not match POST default", async () => {
    createServerFunction("get-only", vi.fn());
    const mw = createRPCMiddleware();
    const req = makeReq({ originalUrl: "/__rpc/get-only", method: "GET" });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(405);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Method Not Allowed" });
  });

  it("should dispatch GET functions with ?args= query params", async () => {
    const fn = vi.fn().mockResolvedValue("public-data");
    createServerFunction("public-data", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: `/__rpc/public-data?args=${
        encodeURIComponent(
          JSON.stringify(["news"]),
        )
      }`,
      method: "GET",
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "news");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should dispatch GET functions without args query param", async () => {
    const fn = vi.fn().mockResolvedValue("no-args");
    createServerFunction("public-data-no-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/public-data-no-args",
      method: "GET",
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should return 400 when GET ?args= is not a JSON array", async () => {
    const fn = vi.fn();
    createServerFunction("public-data-bad-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: `/__rpc/public-data-bad-args?args=${
        encodeURIComponent('{"a":1}')
      }`,
      method: "GET",
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Bad Request" });
  });

  it("should return 400 when GET ?args= is not valid JSON", async () => {
    // `?args=abc` is a malformed request, not a server fault. It used to throw
    // out of the dispatch's try and be reported as a 500.
    const fn = vi.fn();
    createServerFunction("public-malformed-args", fn, { method: "GET" });
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: `/__rpc/public-malformed-args?args=${
        encodeURIComponent("not json")
      }`,
      method: "GET",
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should answer 400 end to end for a malformed JSON body", async () => {
    // The readBody-level test asserts the rejection; this asserts the status
    // the client actually sees, which is what the framework consensus requires.
    const fn = vi.fn();
    createServerFunction("malformed-body", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/malformed-body",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, "{not json");
    await mw(req, res, makeNext());
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should return 403 when Origin does not match the configured origin", async () => {
    createServerFunction("fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: "https://evil.com",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Forbidden" });
  });

  it("should pass requests without an Origin header when origin is set", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should pass requests whose Origin matches the configured origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: "https://app.example.com",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should return 403 when Origin is absent and Sec-Fetch-Site is cross-site", async () => {
    createServerFunction("fn", vi.fn());
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: undefined,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("should pass when Origin is absent and Sec-Fetch-Site is same-origin", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware({ origin: "https://app.example.com" });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: undefined,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("default policy rejects a cross-origin request with no options at all", async () => {
    // Proves the secure default is wired through this adapter, not merely
    // implemented in the shared helper. Creating the middleware with no options
    // must already be protected.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: { origin: "https://evil.com", "sec-fetch-site": "cross-site" },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("default policy admits the server's own host, comparing host only", async () => {
    // `http://` against the fixture's `Host` proves the scheme is not part of
    // the comparison, so a TLS-terminating proxy needs no configuration.
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware();
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: { origin: "http://app.example.com" },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("sibling subdomain survives: allowlisted Origin + same-site passes", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "sec-fetch-site": "same-site",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should pass requests whose Origin matches one entry of an allowlist array", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("fn", fn);
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: "https://admin.example.com",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    simulateBody(req, JSON.stringify(["x"]));
    await mw(req, res, makeNext());
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "x");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should return 403 when Origin matches no entry of an allowlist array", async () => {
    createServerFunction("fn", vi.fn());
    const mw = createRPCMiddleware({
      origin: ["https://app.example.com", "https://admin.example.com"],
    });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: {
        origin: "https://evil.com",
        "content-type": "application/json",
      },
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Forbidden" });
  });

  it('should return 403 for Origin: "null" when an allowlist is set', async () => {
    createServerFunction("fn", vi.fn());
    const mw = createRPCMiddleware({ origin: ["https://app.example.com"] });
    const req = makeReq({
      originalUrl: "/__rpc/fn",
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
    });
    const res = makeRes();
    await mw(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
    const sentData = JSON.parse(res.send.mock.calls[0][0] as string);
    expect(sentData).toEqual({ error: "Forbidden" });
  });
});

// ─── Plugin lifecycle tests ───────────────────────────────────────────

describe("plugin lifecycle", () => {
  it("defineConfig should merge options with defaults", async () => {
    const cfg = defineConfig({ serverFiles: "glob", rpcPrefix: "@demo" });
    expect(cfg.serverFiles).toBe("glob");
    expect(cfg.rpcPrefix).toBe("@demo");
    expect(cfg.scanRoot).toBe(defaultRPCOptions.scanRoot);
  });

  it("defineConfig should skip explicitly undefined values", () => {
    const cfg = defineConfig({
      scanRoot: undefined,
      rpcPrefix: "_x",
      serverFiles: undefined,
    });
    expect(cfg.rpcPrefix).toBe("_x");
    expect(cfg.serverFiles).toBe("exact");
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
    scannedServerFiles.add("test.ts");
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
    scannedServerFiles.add("test.ts");
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
    expect(firstResult.serverFiles).toBe("glob");
    // Second call without args should return cached config
    const secondResult = await loadRPCConfig();
    expect(secondResult.serverFiles).toBe("glob");
    expect(secondResult.rpcPrefix).toBe("_sv");
  });
});

// ─── Global-prefix dispatch (audit finding F1) ─────────────────────────
//
// `createRPCMiddleware` used to merge `{ rpcPrefix: defaultRPCOptions.rpcPrefix }`
// into its options *before* resolving the prefix, so `rpcPrefix` was always the
// truthy string "__rpc" and the trailing `|| getGlobalPrefix() || defaultPrefix`
// was unreachable in all five adapters. `createServerFunction` DOES honour the
// global prefix (src/createFunction.ts:61), so the two halves disagreed:
//
//   setGlobalPrefix("@demo"); createServerFunction("greet", ...)
//   createRPCMiddleware({})  ->  POST /@demo/greet  =>  next()  (404)
//                              POST /__rpc/greet  =>  "Function not found"
//
// Every fixture in tests/fixtures/*.ts calls `setGlobalPrefix(undefined)`, so
// the state this feature is *about* was never exercised — 100% coverage and a
// broken feature at the same time. These tests set a real global prefix.

describe("global-prefix dispatch", () => {
  beforeEach(() => {
    for (const map of serverFunctionsByPrefix.values()) map.clear();
  });

  afterEach(() => {
    setGlobalPrefix(undefined);
    for (const map of serverFunctionsByPrefix.values()) map.clear();
  });

  const registerUnderGlobalPrefix = (name: string) =>
    createServerFunction(name, vi.fn(async () => ({ data: "ok" })) as never);

  // POST dispatch reads the body off the stream, so the request has to be
  // ended or the middleware waits forever.
  const post = async (
    mw: ReturnType<typeof createRPCMiddleware>,
    url: string,
  ) => {
    const req = makeReq({
      originalUrl: url,
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    const next = makeNext();
    simulateBody(req, "[]");
    await mw(req, res, next);
    return { res, next };
  };

  it("dispatches to the global prefix when no explicit prefix is passed", async () => {
    setGlobalPrefix("@demo");
    registerUnderGlobalPrefix("greet");
    // Registered under "@demo" — the prefix the middleware must now use.
    expect([...getFunctionsForPrefix("@demo").keys()]).toEqual(["greet"]);

    const { res } = await post(createRPCMiddleware(), "/@demo/greet");

    expect(res.statusCode).toBe(200);
    expect(res.chunks.join("")).toContain("ok");
  });

  it("no longer falls through to next() for the global prefix", async () => {
    setGlobalPrefix("@demo");
    registerUnderGlobalPrefix("greet");
    const { next } = await post(createRPCMiddleware(), "/@demo/greet");

    expect(next).not.toHaveBeenCalled();
  });

  it("does not dispatch the global prefix under the default prefix", async () => {
    setGlobalPrefix("@demo");
    registerUnderGlobalPrefix("greet");
    // `/__rpc` is not this middleware's prefix any more, so the outer gate
    // treats it as a non-RPC path and falls through rather than 404-ing.
    const { next, res } = await post(createRPCMiddleware(), "/__rpc/greet");

    expect(next).toHaveBeenCalled();
    expect(res.chunks.join("")).not.toContain("ok");
  });

  it("lets an explicit prefix win over the global prefix", async () => {
    setGlobalPrefix("@demo");
    createServerFunction(
      "greet",
      vi.fn(async () => ({ data: "explicit" })) as never,
      { rpcPrefix: "@explicit" },
    );

    const { res } = await post(
      createRPCMiddleware({ rpcPrefix: "@explicit" }),
      "/@explicit/greet",
    );

    expect(res.chunks.join("")).toContain("explicit");
  });

  it("still uses the default prefix when no global prefix is set", async () => {
    // The overwhelmingly common case (every example, every other test): must
    // be unchanged by the F1 fix.
    setGlobalPrefix(undefined);
    createServerFunction(
      "greet",
      vi.fn(async () => ({ data: "default" })) as never,
    );
    expect([...getFunctionsForPrefix("__rpc").keys()]).toEqual(["greet"]);

    const { res } = await post(createRPCMiddleware(), "/__rpc/greet");

    expect(res.chunks.join("")).toContain("default");
  });

  it("keeps the boundary check on the global prefix", async () => {
    // `__rpc` boundary safety must hold for a resolved prefix too, not just
    // the default one: a sibling segment must not dispatch.
    setGlobalPrefix("@demo");
    registerUnderGlobalPrefix("greet");
    const next = makeNext();

    await createRPCMiddleware()(
      makeReq({ originalUrl: "/@demo-evil/greet", method: "POST" }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it("validates the input against the function schema before dispatch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    createServerFunction("validated", fn, {
      contentType: "application/json",
      schema: schema({ email: field.string() }),
      hint: "a single function-wide hint",
    });
    const mw = createRPCMiddleware({ allowHeaderless: true });
    const ok = makeReq({
      originalUrl: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const okRes = makeRes();
    simulateBody(ok, JSON.stringify({ email: "a@b.c" }));
    await mw(ok, okRes, makeNext());
    // The handler receives the *validated* value, so the type flows through.
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), {
      email: "a@b.c",
    });
    expect(okRes.status).toHaveBeenCalledWith(200);

    const bad = makeReq({
      originalUrl: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const badRes = makeRes();
    simulateBody(bad, JSON.stringify({ email: 5 }));
    await mw(bad, badRes, makeNext());
    expect(badRes.status).toHaveBeenCalledWith(422);
    expect(fn).toHaveBeenCalledTimes(1);
    // The function-wide hint leads, and rpc's documentation pointer is kept —
    // so one `hint` costs neither per-field repetition nor the wiki link.
    expect(JSON.parse(badRes.chunks.join("")).hint).toMatch(
      /^a single function-wide hint — .*wiki\/server-functions\.md#input-validation$/,
    );

    // Without a function-wide hint, the pointer stands alone.
    const plain = vi.fn();
    createServerFunction("validated", plain, {
      contentType: "application/json",
      schema: schema({ age: field.number() }),
    });
    const plainReq = makeReq({
      originalUrl: "/__rpc/validated",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const plainRes = makeRes();
    simulateBody(plainReq, JSON.stringify({ email: 5 }));
    await mw(plainReq, plainRes, makeNext());
    expect(JSON.parse(plainRes.chunks.join("")).hint).toBe(
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
    const req = makeReq({
      originalUrl: "/__rpc/array-payload",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    // The outer array means two arguments: the schema therefore sees `1`,
    // while a direct `fn([1, 2])` passes one array argument. The wire shape of
    // the latter is `[[1, 2]]`, which is asserted below for every adapter.
    simulateBody(req, JSON.stringify([[1, 2]]));
    await mw(req, res, makeNext());
    expect(fn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.parse(res.chunks.join(""))).toEqual({ error: "Bad Request" });
  });
});

/* ─── onDispatch ────────────────────────────────────────────────────────────
 * The hook shipped on express first and the other four adapters did not, so this
 * is the only place it is covered end to end. The behaviours below were each
 * found by running the page, not by reading the code — two of them (the missing
 * records for the pre-`try` returns, and the cross-bundle `isRPCError`) were
 * invisible in review and only showed up when a real request went through.
 */

describe("express onDispatch", () => {
  const seen: DispatchContext[] = [];
  const mw = (options: Record<string, unknown> = {}) =>
    createRPCMiddleware({
      rpcPrefix: "__rpc",
      allowHeaderless: true,
      onDispatch: (ctx: DispatchContext) => {
        seen.push(ctx);
      },
      ...options,
    });

  beforeEach(() => {
    seen.length = 0;
  });

  const call = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } =
      {},
  ) => {
    const req = makeReq({
      originalUrl: url,
      method: init.method ?? "POST",
      // No `host` override: the fixture supplies a *matched* pair
      // (host app.example.com + origin https://app.example.com), and changing
      // one without the other is a 403 before the dispatch even starts.
      headers: { "content-type": "application/json", ...init.headers },
    });
    const res = makeRes();
    const next = makeNext();
    if (init.body !== undefined) simulateBody(req, init.body);
    else (req as unknown as { end: () => void }).end();
    await mw()(req, res, next);
    return { res, body: res.chunks.join("") };
  };

  beforeEach(() => {
    createServerFunction("ok-fn", vi.fn(async () => "done") as never);
    createServerFunction(
      "boom-fn",
      vi.fn(async () => {
        throw new Error("kaboom");
      }) as never,
    );
    createServerFunction("get-fn", vi.fn(async () => "tick") as never, {
      method: "GET",
    });
    createServerFunction("validated", vi.fn(async () => "never") as never, {
      schema: schema({ a: field.number() }),
    });
  });

  it("is not constructed at all without a hook, so the error body is unchanged", async () => {
    const req = makeReq({
      originalUrl: "/__rpc/nope",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    await createRPCMiddleware({ allowHeaderless: true })(req, res, makeNext());
    // No `id` key: the correlation id is opt-in, and adding a field to every
    // production error body for nobody's benefit is not a trade worth making.
    expect(JSON.parse(res.chunks.join(""))).toEqual({
      error: "Function not found",
    });
  });

  it("records a successful dispatch", async () => {
    await call("/__rpc/ok-fn", { body: "[]" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      prefix: "__rpc",
      functionName: "ok-fn",
      originTier: "origin",
      method: "POST",
      declaredMethod: "POST",
      status: 200,
      outcome: "ok",
    });
  });

  it("records the function-not-found return, which happens before the try block", async () => {
    // This one was silently skipped by a `finally` alone: the 404 and 403
    // returns are before the `try`, and they are the two a record matters most
    // for. The first version of this feature missed both and the page showed a
    // stale record from the previous request.
    await call("/__rpc/nope", { body: "[]" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      functionName: "nope",
      status: 404,
      outcome: "client-error",
    });
  });

  it("lists the sibling names, which is what turns 404 into a question", async () => {
    await call("/__rpc/typo", { body: "[]" });
    expect(seen[0].registeredNames).toContain("ok-fn");
  });

  it("records the origin rejection, which also happens before the try", async () => {
    const req = makeReq({
      originalUrl: "/__rpc/ok-fn",
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.test",
      },
    });
    const res = makeRes();
    await mw()(req, res, makeNext());
    expect(res.statusCode).toBe(403);
    expect(seen[0]).toMatchObject({
      status: 403,
      originTier: "origin",
      functionName: "",
    });
  });

  it("records a method mismatch with the declared method", async () => {
    await call("/__rpc/get-fn", { body: "[]" });
    expect(seen[0]).toMatchObject({
      status: 405,
      declaredMethod: "GET",
    });
  });

  it("records a content-type mismatch with both sides of it", async () => {
    const req = makeReq({
      originalUrl: "/__rpc/ok-fn",
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    const res = makeRes();
    await mw({ allowHeaderless: true })(req, res, makeNext());
    expect(seen[0]).toMatchObject({
      status: 415,
      declaredContentType: "application/json",
      actualContentType: "text/plain",
      contentTypeMatched: false,
    });
  });

  it("falls back to the default contentType for a function with no options", async () => {
    // `serverFunction.options?.contentType` — the optional chain, not just the
    // `??`. A hand-registered entry with no `options` at all reaches it.
    getFunctionsForPrefix("__rpc").set("bare", {
      handler: vi.fn(async () => "bare") as never,
    } as never);
    const req = makeReq({
      originalUrl: "/__rpc/bare",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, "[]");
    await mw()(req, res, makeNext());
    expect(seen[0]).toMatchObject({
      declaredContentType: "application/json",
      status: 200,
    });
  });

  it("records a request that somehow has no method, without dropping the record", async () => {
    const req = makeReq({
      originalUrl: "/__rpc/ok-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    delete (req as { method?: string }).method;
    const res = makeRes();
    simulateBody(req, "[]");
    await mw()(req, res, makeNext());
    expect(seen[0]).toMatchObject({ method: "", status: 405 });
  });

  it("records a declared contentType, not just the default", async () => {
    createServerFunction("text-fn", vi.fn(async () => "hi") as never, {
      contentType: "text/plain",
    });
    const req = makeReq({
      originalUrl: "/__rpc/text-fn",
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    const res = makeRes();
    simulateBody(req, "[]");
    await mw()(req, res, makeNext());
    expect(seen[0]).toMatchObject({
      declaredContentType: "text/plain",
      actualContentType: "text/plain",
      contentTypeMatched: true,
      status: 200,
    });
  });

  it("records a validation rejection and classifies it as an RPCError", async () => {
    await call("/__rpc/validated", { body: '[{"a":"x"}]' });
    expect(seen[0]).toMatchObject({
      status: 422,
      outcome: "client-error",
      argShape: "[{a:string}]",
    });
    // Was `false` before the registered-symbol brand: tsdown gives each entry
    // its own copy of the class, so a ValidationError raised inside
    // dist/server is not `instanceof` the RPCError inside dist/express.
    expect(seen[0].error).toMatchObject({
      name: "ValidationError",
      isRPCError: true,
      code: "VALIDATION",
    });
  });

  it("records an unexpected throw as a server error", async () => {
    await call("/__rpc/boom-fn", { body: "[]" });
    expect(seen[0]).toMatchObject({ status: 500, outcome: "server-error" });
    expect(seen[0].error?.isRPCError).toBe(false);
  });

  it("never puts an argument value in the record", async () => {
    await call("/__rpc/validated", {
      body: '[{"a":1},{"password":"correct-horse"}]',
    });
    expect(JSON.stringify(seen[0])).not.toContain("correct-horse");
    expect(seen[0].argShape).toContain("number");
  });

  it("puts the correlation id on a failure body, and the record agrees with it", async () => {
    const { body } = await call("/__rpc/nope", { body: "[]" });
    const sent = JSON.parse(body);
    expect(sent.id).toMatch(/^[0-9a-f]{16}$/);
    expect(seen[0].id).toBe(sent.id);
  });

  it("does not put an id on a success body", async () => {
    const { body } = await call("/__rpc/ok-fn", { body: "[]" });
    expect(JSON.parse(body)).toEqual({ data: "done" });
  });

  it("does not take down the request when the hook throws", async () => {
    const exploding = createRPCMiddleware({
      rpcPrefix: "__rpc",
      allowHeaderless: true,
      onDispatch: () => {
        throw new Error("log exploded");
      },
    });
    const req = makeReq({
      originalUrl: "/__rpc/ok-fn",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, "[]");
    await exploding(req, res, makeNext());
    expect(res.statusCode).toBe(200);
  });
});

/* ─── the schema on both call paths ─────────────────────────────────────────
 * A `schema` is enforced by the adapter in dispatch *and* by the function
 * itself, because the function is also called directly — by SSR, by
 * server-to-server code and by tests. The two bugs this prevents were measured:
 * a direct call ran the handler on unchecked input, and the schema's transforms
 * never ran on that path at all.
 */

describe("schema on the direct call path", () => {
  /**
   * A coercing schema, hand-rolled, so the test does not need a validator
   * library to prove that the schema's **Output** — not its Input — is what
   * reaches the handler.
   */
  const coercing: StandardSchemaV1<string, number> = {
    "~standard": {
      version: 1,
      vendor: "test-coercing",
      validate: (value) => {
        const n = Number(value);
        return Number.isNaN(n)
          ? { issues: [{ message: "not a number", path: [] }] }
          : { value: n };
      },
    },
  };

  it("rejects a bad input instead of entering the handler", async () => {
    const handler = vi.fn(async (_s: AbortSignal, input: { a: number }) =>
      input.a
    );
    const add = createServerFunction("direct-add", handler as never, {
      schema: schema({ a: field.number() }),
    });
    await expect(add({ a: "x" } as never).data).rejects.toThrow(
      /Validation failed/,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("applies the schema's transform, so the handler sees the Output not the Input", async () => {
    // This is the sharper half: over HTTP this returned 42; called directly it
    // returned "240", because only the schema's output ever replaced the raw
    // argument and nothing replaced it on this path.
    const add = createServerFunction(
      "direct-coerce",
      async (_s, input) => input + 1,
      {
        schema: coercing,
      },
    );
    expect(await add("41").data).toBe(42);
  });

  it("agrees with the HTTP path on the same input", async () => {
    const add = createServerFunction(
      "direct-parity",
      async (_s, input) => input,
      {
        schema: schema({ a: field.number() }),
      },
    );
    const req = makeReq({
      originalUrl: "/__rpc/direct-parity",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = makeRes();
    simulateBody(req, '[{"a":"x"}]');
    await createRPCMiddleware({ allowHeaderless: true })(req, res, makeNext());
    // The status agrees with the direct path below, which is the point of the
    // test: behaviour must not depend on how the function was invoked.
    expect(res.statusCode).toBe(422);

    await expect(add({ a: "x" } as never).data).rejects.toThrow(
      /Validation failed/,
    );
    // …and the direct path throws the same 422-bearing error, so a caller
    // branching on the status behaves identically either way.
    await expect(add({ a: "x" } as never).data).rejects.toSatisfy(
      (e: unknown) => clientErrorStatus(e) === 422,
    );
  });

  it("leaves a function with no schema untouched", async () => {
    const fn = createServerFunction(
      "direct-plain",
      async (_s: AbortSignal, input: string) => input,
    );
    expect(await fn("anything").data).toBe("anything");
    // A function with no schema must not grow a schema-shaped signature.
    expect(fn.length).toBe(0);
  });
});

describe("schema arity warning", () => {
  const S = () => schema({ a: field.number() });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("warns when a schema is attached to a handler taking more than one argument", () => {
    // The schema covers `args[0]` and only that, so on a two-argument handler
    // the second parameter is unchecked while the author believes it is not.
    // Silence is the dangerous outcome, so it is worth a warning.
    // The first parameter is annotated to the schema's Output, because a
    // handler annotated with a type the schema does not produce is a type error
    // for a reason that has nothing to do with arity. The second is the
    // unvalidated one this warning is about.
    createServerFunction(
      "arity-warns",
      async (_s: AbortSignal, _input: { a: number }, _extra: JsonValue) => "x",
      { schema: S() },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("only validates the first");
    expect(warn.mock.calls[0][0]).toContain("arity-warns");
  });

  it("says nothing for the ordinary single-argument case", () => {
    createServerFunction("arity-quiet", async (_s, _input) => "x", {
      schema: S(),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing when there is no schema at all", () => {
    createServerFunction(
      "arity-no-schema",
      async (_s: AbortSignal, _a: string, _b: string) => "x",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when a default parameter hides the second one", () => {
    // `fn.length` under-reports with a default or rest parameter, so this is a
    // false *negative* — the safe direction. A false positive would train people
    // to ignore the warning, which is worse than missing one.
    createServerFunction(
      "arity-default",
      async (_s: AbortSignal, _input: { a: number }, _b: JsonValue = 1) => "x",
      { schema: S() },
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
