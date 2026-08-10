import { describe, expect, it, vi } from "vitest";
import {
  formatError,
  hasContentTypeMismatch,
  isFormContentType,
  RPCError,
  safeURL,
  walkGlobFiles,
} from "../src/server-helpers.ts";

describe("formatError", () => {
  it("should return generic error in production", () => {
    expect(formatError(new Error("secret"), true)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should not leak exception message in dev", () => {
    expect(formatError(new Error("secret"), false)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should include code and data for RPCError in dev", () => {
    expect(
      formatError(
        new RPCError("validation failed", "VALIDATION", { field: "x" }),
        false,
      ),
    ).toEqual({
      error: "validation failed",
      code: "VALIDATION",
      data: { field: "x" },
    });
  });

  it("should keep code for RPCError but drop data in production", () => {
    expect(
      formatError(
        new RPCError("validation failed", "VALIDATION", { field: "x" }),
        true,
      ),
    ).toEqual({ error: "Internal Server Error" });
  });

  it("should default code to INTERNAL for RPCError", () => {
    expect(formatError(new RPCError("boom"), false)).toEqual({
      error: "boom",
      code: "INTERNAL",
    });
  });

  it("should return generic error for non-Error values in dev", () => {
    expect(formatError("string failure", false)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should fall back to generic error for empty RPCError message in dev", () => {
    expect(formatError(new RPCError(""), false)).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL",
    });
  });
});

describe("safeURL", () => {
  it("should parse a well-formed path", () => {
    expect(safeURL("/__rpc/foo?x=1").pathname).toBe("/__rpc/foo");
  });

  it("should fall back to the base root for a malformed request-target instead of throwing", () => {
    expect(() => safeURL("/\\")).not.toThrow();
    expect(safeURL("/\\").pathname).toBe("/");
    expect(() => safeURL("//")).not.toThrow();
    expect(safeURL("//").pathname).toBe("/");
    expect(() => safeURL("/\\/")).not.toThrow();
    expect(safeURL("/\\/").pathname).toBe("/");
  });

  it("should respect a custom base", () => {
    expect(safeURL("/\\", "https://example.com").pathname).toBe("/");
  });
});

describe("walkGlobFiles", () => {
  it("should find *.server.* files recursively and ignore others", async () => {
    const files = await walkGlobFiles(
      `${import.meta.dirname}/fixtures/glob-recursive/api`,
    );
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["a.server.ts", "b.server.ts"]);
  });

  it("should return an empty array for a missing directory", async () => {
    expect(await walkGlobFiles("/nonexistent/definitely-missing")).toEqual([]);
  });
});

describe("isFormContentType", () => {
  it("should recognize multipart/form-data", () => {
    expect(isFormContentType("multipart/form-data")).toBe(true);
  });

  it("should recognize application/x-www-form-urlencoded", () => {
    expect(isFormContentType("application/x-www-form-urlencoded")).toBe(true);
  });

  it("should reject json and text", () => {
    expect(isFormContentType("application/json")).toBe(false);
    expect(isFormContentType("text/plain")).toBe(false);
  });
});

describe("hasContentTypeMismatch", () => {
  it("should match json declared against json header", () => {
    expect(
      hasContentTypeMismatch("application/json", "application/json"),
    ).toBe(false);
  });

  it("should reject json declared against urlencoded header", () => {
    expect(
      hasContentTypeMismatch(
        "application/json",
        "application/x-www-form-urlencoded",
      ),
    ).toBe(true);
  });

  it("should reject text declared against json header", () => {
    expect(
      hasContentTypeMismatch("text/plain", "application/json"),
    ).toBe(true);
  });

  it("should strip boundary/charset parameters before comparing", () => {
    expect(
      hasContentTypeMismatch(
        "multipart/form-data",
        "multipart/form-data; boundary=----xyz",
      ),
    ).toBe(false);
    expect(
      hasContentTypeMismatch(
        "application/json",
        "application/json; charset=utf-8",
      ),
    ).toBe(false);
  });

  it("should be lenient between the two forms", () => {
    expect(
      hasContentTypeMismatch(
        "multipart/form-data",
        "application/x-www-form-urlencoded",
      ),
    ).toBe(false);
    expect(
      hasContentTypeMismatch(
        "application/x-www-form-urlencoded",
        "multipart/form-data",
      ),
    ).toBe(false);
  });

  it("should reject a form-declared function that gets json", () => {
    expect(
      hasContentTypeMismatch("multipart/form-data", "application/json"),
    ).toBe(true);
  });

  it("should exempt requests without a Content-Type header", () => {
    expect(hasContentTypeMismatch("application/json", undefined)).toBe(false);
    expect(hasContentTypeMismatch("multipart/form-data", "")).toBe(false);
  });

  it("should be case-insensitive", () => {
    expect(
      hasContentTypeMismatch("application/json", "APPLICATION/JSON"),
    ).toBe(false);
  });
});
