import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClientStub,
  handleResponse,
  innerModule,
} from "../src/client-helpers.ts";

describe("handleResponse", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return data for successful response", async () => {
    const response = new Response(JSON.stringify({ data: "hello" }), {
      status: 200,
    });
    const result = await handleResponse(response);
    expect(result).toBe("hello");
  });

  it("should throw if response has error field", async () => {
    const response = new Response(JSON.stringify({ error: "not found" }), {
      status: 200,
    });
    await expect(handleResponse(response)).rejects.toThrow("not found");
  });

  it("should warn and return undefined for 499 status", async () => {
    const response = new Response(null, {
      status: 499,
      statusText: "Canceled",
    });
    const result = await handleResponse(response);
    expect(console.warn).toHaveBeenCalledWith("Request was cancelled");
    expect(result).toBeUndefined();
  });

  it("should warn and return undefined for 408 status", async () => {
    const response = new Response(null, { status: 408, statusText: "Timeout" });
    const result = await handleResponse(response);
    expect(console.warn).toHaveBeenCalledWith("Request was cancelled");
    expect(result).toBeUndefined();
  });

  it("should throw for other error status", async () => {
    const response = new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
    await expect(handleResponse(response)).rejects.toThrow(
      "Fetch error: Not Found",
    );
  });

  it("should throw for 500 status", async () => {
    const response = new Response(null, {
      status: 500,
      statusText: "Internal Server Error",
    });
    await expect(handleResponse(response)).rejects.toThrow(
      "Fetch error: Internal Server Error",
    );
  });
});

describe("innerModule", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return { data, cancel } shape", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );

    const result = innerModule(
      '"test"',
      { "Content-Type": "application/json" },
      "same-origin",
      "__rpc",
      "say-hi",
    );
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("cancel");
    expect(result.data).toBeInstanceOf(Promise);
    expect(typeof result.cancel).toBe("function");
  });

  it("should make fetch call with correct arguments", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );

    const result = innerModule(
      '{"a":1}',
      { "Content-Type": "application/json" },
      "same-origin",
      "__rpc",
      "say-hi",
    );
    await result.data;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/__rpc/say-hi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: '{"a":1}',
      signal: expect.any(AbortSignal),
    });
  });

  it("should resolve data from successful fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "hello world" }), { status: 200 }),
    );

    const result = innerModule("{}", {}, "same-origin", "__rpc", "echo");
    await expect(result.data).resolves.toBe("hello world");
  });

  it("should throw on error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );

    const result = innerModule("{}", {}, "same-origin", "__rpc", "missing");
    await expect(result.data).rejects.toThrow("Fetch error: Not Found");
  });

  it("should warn on 499 cancellation response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 499, statusText: "Canceled" }),
    );

    const result = innerModule("{}", {}, "same-origin", "__rpc", "fn");
    await result.data;
    expect(console.warn).toHaveBeenCalledWith("Request was cancelled");
  });

  it("should make GET fetch call with args in query string", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );

    const result = innerModule(
      '["a",1]',
      {},
      "same-origin",
      "__rpc",
      "public-fn",
      "GET",
    );
    await result.data;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/__rpc/public-fn?args=${encodeURIComponent('["a",1]')}`,
      {
        method: "GET",
        headers: {},
        credentials: "same-origin",
        body: undefined,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("should reject data when cancel is called", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
          } else {
            signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              );
            }, { once: true });
          }
        }),
    );

    const result = innerModule("{}", {}, "same-origin", "__rpc", "fn");
    result.cancel("user cancelled");
    await expect(result.data).rejects.toThrow("The operation was aborted");
  });
});

describe("getClientStub", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create stub via getClientStub and call admin prefix", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "admin-ok" }), { status: 200 }),
    );
    const adminGetUser = getClientStub("admin:rpc", "get-user");
    const { data } = adminGetUser("123");
    await expect(data).resolves.toBe("admin-ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin:rpc/get-user",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("should support GET via getClientStub", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );
    const fn = getClientStub("admin:rpc", "stats", { method: "GET" });
    await fn("a", 1).data;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/admin:rpc/stats?args="),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("should support text/plain via getClientStub", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );
    const fn = getClientStub("__rpc", "echo", { contentType: "text/plain" });
    await fn("hello").data;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { "Content-Type": "text/plain" } }),
    );
  });

  it("should support urlencoded via getClientStub", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );
    const fn = getClientStub("__rpc", "echo", {
      contentType: "application/x-www-form-urlencoded",
    });
    await fn({ a: "1" }).data;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
  });

  it("should support multipart via getClientStub", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "ok" }), { status: 200 }),
    );
    const fd = new FormData();
    fd.append("file", new Blob(["hi"]));
    const fn = getClientStub("__rpc", "upload", {
      contentType: "multipart/form-data",
    });
    await fn(fd).data;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: {} }),
    );
  });
});
