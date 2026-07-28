import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResponse, innerModule } from "../src/helpers.ts";

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
      "__rpc",
      "say-hi",
    );
    await result.data;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/__rpc/say-hi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: '{"a":1}',
      signal: expect.any(AbortSignal),
    });
  });

  it("should resolve data from successful fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "hello world" }), { status: 200 }),
    );

    const result = innerModule("{}", {}, "__rpc", "echo");
    await expect(result.data).resolves.toBe("hello world");
  });

  it("should throw on error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );

    const result = innerModule("{}", {}, "__rpc", "missing");
    await expect(result.data).rejects.toThrow("Fetch error: Not Found");
  });

  it("should warn on 499 cancellation response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 499, statusText: "Canceled" }),
    );

    const result = innerModule("{}", {}, "__rpc", "fn");
    await result.data;
    expect(console.warn).toHaveBeenCalledWith("Request was cancelled");
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

    const result = innerModule("{}", {}, "__rpc", "fn");
    result.cancel("user cancelled");
    await expect(result.data).rejects.toThrow("The operation was aborted");
  });
});
