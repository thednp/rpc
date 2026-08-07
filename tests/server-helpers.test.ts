import { describe, expect, it } from "vitest";
import { formatError, RPCError, walkGlobFiles } from "../src/server-helpers.ts";

describe("formatError", () => {
  it("should return generic error in production", () => {
    expect(formatError(new Error("secret"), true)).toEqual({
      error: "Internal Server Error",
    });
  });

  it("should leak message in dev", () => {
    expect(formatError(new Error("secret"), false)).toEqual({
      error: "secret",
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

  it("should serialize non-Error values in dev", () => {
    expect(formatError("string failure", false)).toEqual({
      error: "string failure",
    });
  });

  it("should fall back to generic error for empty RPCError message in dev", () => {
    expect(formatError(new RPCError(""), false)).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL",
    });
  });

  it("should fall back to generic error for empty non-Error value in dev", () => {
    expect(formatError("", false)).toEqual({
      error: "Internal Server Error",
    });
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
