import { describe, expect, it, vi } from "vitest";
import {
  getRequestContext,
  getRequestMeta,
  provideRequestContext,
  redirect,
  type RequestEvent,
  sendResponse,
} from "../src/context.ts";

describe("provideRequestContext", () => {
  it("should provide the context inside the callback", () => {
    const init: RequestEvent = {
      request: { id: "req1" },
      response: { id: "res1" },
      redirect: () => undefined,
      locals: { user: "alice" },
    };
    provideRequestContext(init, () => {
      expect(getRequestContext()).toBe(init);
    });
    expect(getRequestContext.bind(null)).not.toBe(init);
  });

  it("should propagate locals mutated in the callback", () => {
    provideRequestContext(
      { request: {}, response: {}, redirect: () => undefined, locals: {} },
      () => {
        getRequestContext().locals.user = "bob";
        expect(getRequestContext().locals.user).toBe("bob");
      },
    );
  });

  it("should keep context isolated between nested calls", () => {
    const outer: RequestEvent = {
      request: {},
      response: {},
      redirect: () => undefined,
      locals: {},
    };
    provideRequestContext(outer, () => {
      const inner: RequestEvent = {
        request: {},
        response: {},
        redirect: () => undefined,
        locals: {},
      };
      provideRequestContext(inner, () => {
        expect(getRequestContext()).toBe(inner);
      });
      expect(getRequestContext()).toBe(outer);
    });
  });

  it("should persist across async boundaries within the callback", async () => {
    const init: RequestEvent = {
      request: {},
      response: {},
      redirect: () => undefined,
      locals: {},
    };
    await provideRequestContext(init, async () => {
      await Promise.resolve();
      expect(getRequestContext()).toBe(init);
    });
  });
});

describe("getRequestContext", () => {
  it("should throw outside of a request", () => {
    expect(() => getRequestContext()).toThrowError(
      "RequestEvent is not available outside of a request",
    );
  });
});

describe("redirect", () => {
  it("should delegate to the bound request-context redirect", () => {
    const ctxRedirect = vi.fn();
    provideRequestContext(
      {
        request: {},
        response: {},
        redirect: ctxRedirect,
        locals: {},
      },
      () => {
        redirect("/target");
        redirect("/other", 301);
      },
    );
    expect(ctxRedirect).toHaveBeenCalledWith("/target", 303);
    expect(ctxRedirect).toHaveBeenCalledWith("/other", 301);
  });

  it("should throw when called outside a request", () => {
    expect(() => redirect("/target")).toThrowError(
      "RequestEvent is not available outside of a request",
    );
  });
});

describe("sendResponse", () => {
  it("should delegate to the bound request-context send", () => {
    const ctxSend = vi.fn();
    provideRequestContext(
      {
        request: {},
        response: {},
        redirect: () => undefined,
        send: ctxSend,
        locals: {},
      },
      () => {
        sendResponse(429, { error: "Rate limit exceeded" }, {
          "retry-after": "30",
        });
        sendResponse(401, { error: "Unauthorized" });
      },
    );
    expect(ctxSend).toHaveBeenCalledWith(
      429,
      { error: "Rate limit exceeded" },
      { "retry-after": "30" },
    );
    expect(ctxSend).toHaveBeenCalledWith(
      401,
      { error: "Unauthorized" },
      undefined,
    );
  });

  it("should throw when called outside a request", () => {
    expect(() => sendResponse(400, { error: "bad" })).toThrowError(
      "RequestEvent is not available outside of a request",
    );
  });
});

describe("getRequestMeta", () => {
  it("should normalize an Express-style request (originalUrl + headers map)", () => {
    const meta = getRequestMeta({
      request: {
        method: "POST",
        originalUrl: "/__rpc/greet?x=1",
        headers: { host: "localhost:5173", authorization: "Bearer tok" },
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.method).toBe("POST");
    expect(meta.pathname).toBe("/__rpc/greet");
    expect(meta.search).toBe("?x=1");
    expect(meta.searchParams.get("x")).toBe("1");
    expect(meta.headers).toEqual({
      host: "localhost:5173",
      authorization: "Bearer tok",
    });
    expect(meta.host).toBe("localhost:5173");
  });

  it("should normalize a Headers-like request (h3/hono)", () => {
    const headers = new Headers();
    headers.set("host", "example.com");
    headers.set("authorization", "Bearer tok");
    const meta = getRequestMeta({
      request: {
        method: "GET",
        url: "http://localhost/__rpc/greet?x=1",
        headers,
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.method).toBe("GET");
    expect(meta.pathname).toBe("/__rpc/greet");
    expect(meta.searchParams.get("x")).toBe("1");
    expect(meta.headers).toMatchObject({ host: "example.com" });
    expect(meta.host).toBe("example.com");
  });

  it("should expose the client ip and protocol when available", () => {
    const meta = getRequestMeta({
      request: {
        method: "GET",
        url: "/__rpc/greet",
        headers: { host: "example.com" },
        ip: "203.0.113.7",
        protocol: "https",
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.ip).toBe("203.0.113.7");
    expect(meta.protocol).toBe("https");
  });

  it("should default method and pathname for a bare request", () => {
    const meta = getRequestMeta({
      request: {},
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.method).toBe("GET");
    expect(meta.pathname).toBe("/");
    expect(meta.search).toBe("");
  });

  it("should read the header via Hono header() when headers is a plain map", () => {
    const meta = getRequestMeta({
      request: {
        method: "GET",
        path: "/__rpc/greet",
        headers: { host: "example.com" },
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.pathname).toBe("/__rpc/greet");
    expect(meta.headers).toMatchObject({ host: "example.com" });
  });

  it("should pick the first value from array headers", () => {
    const meta = getRequestMeta({
      request: {
        method: "GET",
        originalUrl: "/__rpc/greet",
        headers: { host: ["first.example.com", "second.example.com"] },
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.host).toBe("first.example.com");
  });

  it("should fall back to the URL protocol when req.protocol is absent", () => {
    const meta = getRequestMeta({
      request: {
        method: "GET",
        url: "https://api.example.com/__rpc/greet",
        headers: { host: "api.example.com" },
      },
      response: {},
      redirect: () => undefined,
      locals: {},
    } as RequestEvent);
    expect(meta.protocol).toBe("https");
    expect(meta.pathname).toBe("/__rpc/greet");
  });
});

describe("functionName on RequestEvent", () => {
  it("should be present when bound by the adapter", () => {
    let seen: string | undefined;
    provideRequestContext(
      {
        request: {},
        response: {},
        redirect: () => undefined,
        functionName: "greet",
        locals: {},
      },
      () => {
        seen = getRequestContext().functionName;
      },
    );
    expect(seen).toBe("greet");
  });
});
