import { describe, expect, it } from "vitest";
import {
  formatError,
  hasContentTypeMismatch,
  isFormContentType,
  isOriginAllowed,
  RPCError,
  safeURL,
  walkGlobFiles,
} from "../src/server-helpers.ts";

describe("isOriginAllowed", () => {
  it("should allow everything when no allowlist is configured", () => {
    expect(isOriginAllowed(undefined, "https://evil.com")).toBe(true);
    expect(isOriginAllowed(undefined, undefined)).toBe(true);
  });

  it("should allow headerless requests when an allowlist is configured", () => {
    expect(isOriginAllowed("https://app.example.com", undefined)).toBe(true);
    expect(
      isOriginAllowed(["https://app.example.com"], undefined),
    ).toBe(true);
  });

  it("should match a single string exactly", () => {
    expect(
      isOriginAllowed("https://app.example.com", "https://app.example.com"),
    )
      .toBe(true);
    expect(isOriginAllowed("https://app.example.com", "https://evil.com"))
      .toBe(false);
  });

  it("should match any entry of an allowlist array", () => {
    const allowed = ["https://app.example.com", "https://admin.example.com"];
    expect(isOriginAllowed(allowed, "https://app.example.com")).toBe(true);
    expect(isOriginAllowed(allowed, "https://admin.example.com")).toBe(true);
    expect(isOriginAllowed(allowed, "https://evil.com")).toBe(false);
  });

  it("should treat a one-element array like the equivalent string", () => {
    expect(
      isOriginAllowed(["https://app.example.com"], "https://app.example.com"),
    )
      .toBe(true);
  });

  it('should reject Origin: "null" when an allowlist is set', () => {
    expect(isOriginAllowed("https://app.example.com", "null")).toBe(false);
    expect(isOriginAllowed(["https://app.example.com"], "null")).toBe(false);
  });

  it("should not match on prefix or substring", () => {
    expect(
      isOriginAllowed(
        "https://app.example.com",
        "https://app.example.com.evil.com",
      ),
    ).toBe(false);
    expect(
      isOriginAllowed("https://app.example.com", "https://app.example.com:443"),
    ).toBe(false);
  });

  it("should be case-sensitive, matching the serialized Origin form", () => {
    expect(
      isOriginAllowed(
        "https://app.example.com",
        "HTTPS://APP.EXAMPLE.COM",
      ),
    ).toBe(false);
  });

  it("should deny any request carrying an Origin when given an empty allowlist", () => {
    expect(isOriginAllowed([], "https://app.example.com")).toBe(false);
    // …but headerless requests still pass, same as with any other allowlist
    expect(isOriginAllowed([], undefined)).toBe(true);
  });

  it("should be exported from the server barrel", async () => {
    const barrel = await import("../src/server.ts");
    expect(typeof barrel.isOriginAllowed).toBe("function");
  });
});

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
