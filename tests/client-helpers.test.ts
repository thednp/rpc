import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fieldErrorHint,
  fieldErrors,
  fieldErrorText,
  getClientStub,
  handleResponse,
  innerModule,
  RPCResponseError,
  unwrapEnvelope,
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

  it("carries the parsed error body on a non-2xx response", async () => {
    // The server sends its most useful errors *in* the body — a 400 from a
    // schema violation carries the issue paths and the per-field hints. Throwing
    // only `statusText` would leave the caller unable to tell which field failed,
    // which is the whole point of validating at the boundary.
    const body = {
      error: "Validation failed",
      code: "VALIDATION",
      data: {
        issues: [{
          path: "email",
          message: "expected a string",
          hint: "use .optional()",
        }],
      },
      hint: "see the docs",
    };
    const response = new Response(JSON.stringify(body), {
      status: 400,
      statusText: "Bad Request",
    });
    const err = await handleResponse(response).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RPCResponseError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual(body);
    expect(err.issues).toEqual(body.data.issues);
    expect(err.hint).toBe("see the docs");
  });

  it("preserves the legacy message so existing matchers keep working", async () => {
    const response = new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
    await expect(handleResponse(response)).rejects.toThrow(
      "Fetch error: Not Found",
    );
  });

  it("tolerates a non-JSON error body", async () => {
    const response = new Response("<html>gateway error</html>", {
      status: 502,
      statusText: "Bad Gateway",
    });
    const err = await handleResponse(response).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(RPCResponseError);
    expect(err.body).toBeUndefined();
    expect(err.issues).toBeUndefined();
    expect(err.hint).toBeUndefined();
  });

  it("reports no issues for a 400 that is not a validation failure", async () => {
    const response = new Response(JSON.stringify({ error: "Bad Request" }), {
      status: 400,
      statusText: "Bad Request",
    });
    const err = await handleResponse(response).then(() => null, (e) => e);
    expect(err.issues).toBeUndefined();
  });

  it("reports no hint when the body carries none", () => {
    expect(
      new RPCResponseError(400, "Bad Request", { code: "VALIDATION" }).hint,
    )
      .toBeUndefined();
    expect(
      new RPCResponseError(400, "Bad Request", { hint: 42 }).hint,
    ).toBeUndefined();
    expect(
      new RPCResponseError(400, "Bad Request", { code: "VALIDATION", data: {} })
        .issues,
    ).toBeUndefined();
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

describe("unwrapEnvelope", () => {
  it("should extract data from { data } envelope", () => {
    expect(unwrapEnvelope<string>({ data: "hello" })).toBe("hello");
  });

  it("should extract nested data from { data } envelope", () => {
    const obj = { data: { name: "artae", count: 42 } };
    expect(unwrapEnvelope<typeof obj.data>(obj)).toEqual({
      name: "artae",
      count: 42,
    });
  });

  it("should return the input as-is when no data property", () => {
    expect(unwrapEnvelope<string>("just a string")).toBe("just a string");
  });

  it("should return the input as-is for primitive values", () => {
    expect(unwrapEnvelope<number>(42)).toBe(42);
    expect(unwrapEnvelope<boolean>(true)).toBe(true);
    expect(unwrapEnvelope<null>(null)).toBe(null);
  });

  it("should handle undefined data property", () => {
    const obj = { data: undefined };
    expect(unwrapEnvelope<undefined>(obj)).toBeUndefined();
  });

  it("should handle data property with null value", () => {
    expect(unwrapEnvelope<null>({ data: null })).toBeNull();
  });

  it("should unwrap falsy data values", () => {
    expect(unwrapEnvelope<boolean>({ data: false })).toBe(false);
    expect(unwrapEnvelope<number>({ data: 0 })).toBe(0);
    expect(unwrapEnvelope<string>({ data: "" })).toBe("");
  });

  it("should throw on a top-level error body", () => {
    expect(() => unwrapEnvelope({ error: "Function not found" })).toThrow(
      "Function not found",
    );
  });

  it("should stringify a non-string top-level error", () => {
    expect(() => unwrapEnvelope({ error: { code: 401 } })).toThrow(
      "[object Object]",
    );
  });

  it("should NOT throw for validation-as-data ({ data: { error } })", () => {
    const result = unwrapEnvelope<{ error: string }>({
      data: { error: "a is required" },
    });
    expect(result).toEqual({ error: "a is required" });
  });

  it("should return non-envelope objects as-is", () => {
    expect(unwrapEnvelope<{ foo: number }>({ foo: 1 })).toEqual({ foo: 1 });
  });
});

/* ─── field errors ──────────────────────────────────────────────────────────
 * These replaced the per-app `getError` / `isValiError` pair that the examples
 * used to carry, so they are the reason a zod rejection and an arktype
 * rejection can be rendered by the same three lines.
 */

describe("fieldErrors", () => {
  const body = (issues: unknown[], extra: object = {}) => ({
    error: "Validation failed",
    code: "VALIDATION",
    data: { issues },
    ...extra,
  });

  it("groups messages by the path the server rendered", () => {
    const err = new RPCResponseError(
      400,
      "Bad Request",
      body([
        { path: "a", message: "one" },
        { path: "b", message: "two" },
        { path: "a", message: "three" },
      ]),
    );
    expect(fieldErrors(err)).toEqual({
      a: ["one", "three"],
      b: ["two"],
    });
  });

  it("keeps a nested path as the dotted string the server produced", () => {
    const err = new RPCResponseError(
      400,
      "Bad Request",
      body([
        { path: "address.city", message: "required" },
      ]),
    );
    expect(fieldErrors(err)).toEqual({ "address.city": ["required"] });
  });

  it("keys a top-level scalar failure on the empty path", () => {
    const err = new RPCResponseError(
      400,
      "Bad Request",
      body([
        { path: "", message: "not a number" },
      ]),
    );
    expect(fieldErrors(err)).toEqual({ "": ["not a number"] });
  });

  it("is validator-agnostic: it reads the normalised shape, not a library's", () => {
    // Four libraries, four message wordings, one shape. The examples render all
    // four through this function and none of them knows which produced the body.
    for (
      const message of [
        "Invalid type: Expected number but received NaN",
        "Invalid input: expected int, received number",
        "age must be an integer (was 3.7)",
        "Expected an integer, actual 3.7",
      ]
    ) {
      const err = new RPCResponseError(
        400,
        "Bad Request",
        body([
          { path: "age", message },
        ]),
      );
      expect(fieldErrors(err)).toEqual({ age: [message] });
    }
  });

  it("treats a missing path as the root, since the spec makes it optional", () => {
    const err = new RPCResponseError(
      400,
      "Bad Request",
      body([
        { message: "no path at all" },
      ]),
    );
    expect(fieldErrors(err)).toEqual({ "": ["no path at all"] });
  });

  it("returns an empty object for a production rejection, which is stripped", () => {
    expect(fieldErrors(
      new RPCResponseError(400, "Bad Request", {
        error: "Bad Request",
      }),
    )).toEqual({});
  });

  it("returns an empty object for anything that is not a validation failure", () => {
    expect(fieldErrors(new Error("boom"))).toEqual({});
    expect(fieldErrors(null)).toEqual({});
    expect(fieldErrors(new RPCResponseError(500, "Server Error", {}))).toEqual(
      {},
    );
  });
});

describe("fieldErrorText", () => {
  const err = new RPCResponseError(400, "Bad Request", {
    error: "Validation failed",
    code: "VALIDATION",
    data: {
      issues: [{ path: "a", message: "one" }, { path: "a", message: "two" }],
    },
  });

  it("joins a field's messages, ready for textContent", () => {
    expect(fieldErrorText(err, "a")).toBe("one; two");
  });

  it("returns an empty string for a field that passed, so it needs no guard", () => {
    // The old `getError` returned `undefined` here and every call site had to
    // guard before assigning.
    expect(fieldErrorText(err, "b")).toBe("");
    expect(fieldErrorText(new Error("x"), "a")).toBe("");
  });
});

describe("fieldErrorHint", () => {
  it("prefers the field's own hint", () => {
    const err = new RPCResponseError(400, "Bad Request", {
      error: "Validation failed",
      code: "VALIDATION",
      data: { issues: [{ path: "a", message: "m", hint: "per-field" }] },
      hint: "function-wide",
    });
    expect(fieldErrorHint(err, "a")).toBe("per-field");
  });

  it("falls back to the function-wide hint, which is the more common form", () => {
    // This was the bug: a function-wide `hint` is sent once at the top of the
    // body, so reading `issue.hint` directly found nothing and the advice never
    // reached the page even though the server had sent it.
    const err = new RPCResponseError(400, "Bad Request", {
      error: "Validation failed",
      code: "VALIDATION",
      data: { issues: [{ path: "a", message: "m" }] },
      hint: "function-wide",
    });
    expect(fieldErrorHint(err, "a")).toBe("function-wide");
  });

  it("is empty when a matching issue carries no hint of its own", () => {
    const err = new RPCResponseError(400, "Bad Request", {
      error: "Validation failed",
      code: "VALIDATION",
      data: { issues: [{ path: "a", message: "m" }] },
    });
    // A hit without a hint, then no body hint either: the `?? ""` on the find
    // result has to be reached, not short-circuited past.
    expect(fieldErrorHint(err, "a")).toBe("");
  });

  it("matches a path-less issue against the root field", () => {
    // `path` is optional in the spec, so `fieldErrorHint(err, "")` has to find
    // an issue that omitted it rather than skipping past it.
    const err = new RPCResponseError(400, "Bad Request", {
      error: "Validation failed",
      code: "VALIDATION",
      data: { issues: [{ message: "m", hint: "root advice" }] },
    });
    expect(fieldErrorHint(err, "")).toBe("root advice");
  });

  it("is empty when there is no hint at all, and for a non-rpc error", () => {
    expect(fieldErrorHint(new Error("x"), "a")).toBe("");
    expect(
      fieldErrorHint(
        new RPCResponseError(400, "Bad Request", {
          error: "Validation failed",
          code: "VALIDATION",
          data: { issues: [{ path: "a", message: "m" }] },
        }),
        "a",
      ),
    ).toBe("");
  });
});

describe("fieldErrors with a production body", () => {
  /**
   * A production rejection carries `path` and `hint` but not the validator
   * library's `message`, so every helper here has to work without one. These
   * exercise the shapes a production body can actually contain.
   */
  const withIssues = (
    issues: { path: string; message?: string; hint?: string }[],
    bodyHint?: string,
  ) =>
    new RPCResponseError(422, "Unprocessable Content", {
      error: "Unprocessable Content",
      code: "VALIDATION",
      data: { issues },
      ...(bodyHint ? { hint: bodyHint } : {}),
    });

  it("falls back to the hint when there is no message", () => {
    const err = withIssues([{ path: "email", hint: "use .optional()" }]);
    expect(fieldErrors(err)).toEqual({ email: ["use .optional()"] });
  });

  it("keeps a bare path as a key, because the path is all a production body sends", () => {
    // The common case for an author who wrote no `hints`: the issue carries
    // nothing but its path. Dropping it would discard the only signal
    // production sends — which field failed — and make the whole disclosure
    // change pointless for exactly the authors it helps most. So the key
    // appears with empty text: enough to mark the input invalid, and
    // `fieldErrorText` correctly has nothing to render for it.
    const err = withIssues([{ path: "age" }]);
    expect(fieldErrors(err)).toEqual({ age: [""] });
    expect(fieldErrorText(err, "age")).toBe("");
    expect("age" in fieldErrors(err)).toBe(true);
  });

  it("mixes a bare path and a hinted issue in one body", () => {
    const err = withIssues([{ path: "a" }, { path: "b", hint: "fix b" }]);
    expect(fieldErrors(err)).toEqual({ a: [""], b: ["fix b"] });
  });

  it("still surfaces the function-wide hint in production", () => {
    const err = withIssues(
      [{ path: "a" }],
      "check the highlighted fields",
    );
    expect(fieldErrorHint(err, "a")).toBe("check the highlighted fields");
  });

  it("prefers a per-field hint over the function-wide one", () => {
    const err = withIssues([{ path: "a", hint: "field-specific" }], "general");
    expect(fieldErrorHint(err, "a")).toBe("field-specific");
    expect(fieldErrorHint(err, "b")).toBe("general");
  });
});
