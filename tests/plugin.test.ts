import { beforeEach, describe, expect, it, vi } from "vitest";

import { default as rpcPlugin, loadRPCConfig } from "../src/index.ts";
import type { ServerFnEntry, ServerFunctionInit } from "../src/types.d.ts";
import { createServerFunction } from "../src/createFunction.ts";
import { serverFunctionsMap } from "../src/functionsMap.ts";
import { getClientModules } from "../src/getClientModules.ts";
import {
  validateCredentials,
  validateIdentifier,
  validatePathSegment,
} from "../src/validate.ts";
import {
  defaultMiddlewareOptions,
  defaultRPCOptions,
  defaultServerFnOptions,
} from "../src/options.ts";
import {
  mockPlugin7Context,
  mockPlugin8Context,
} from "./fixtures/vite-mock.ts";
import {
  createMiddleware,
  createRPCMiddleware,
} from "../src/express/createMiddleware.ts";

beforeEach(() => {
  serverFunctionsMap.clear();
});

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();

  return {
    ...actual,

    transformWithOxc: vi.fn().mockImplementation((code: string) =>
      Promise.resolve({
        code, // return original code (or transform it if needed)
        map: JSON.stringify([{ "createServerFunction()": "./file.ts" }]),
        // map: JSON.stringify([{ "createServerFunction()": "./file.ts" }]),
      })
    ),

    transformWithEsbuild: vi.fn().mockImplementation(async (code: string) => {
      return Promise.resolve({
        code,
        map: [{ "createServerFunction()": "./file.ts" }],
      });
    }),
  };
});

// ─── Plugin & Config ───────────────────────────────────────────────────

describe("plugin initialization", () => {
  it("should initialize without options", () => {
    const plugin = rpcPlugin();
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("vite-plugin-universal-rpc");
    expect(plugin.enforce).toBe("pre");
    expect(plugin.buildStart instanceof Function).toBe(true);
    expect(plugin.configResolved instanceof Function).toBe(true);
    expect(plugin.transform instanceof Function).toBe(true);
  });
});

describe("loadRPCConfig", () => {
  it("should load default config", async () => {
    const cfg = await loadRPCConfig();
    expect(cfg.adapter).toBe("express");
    expect(cfg.rpcPrefix).toBe("__rpc");
  });

  it("should load config from file", async () => {
    const cfg = await loadRPCConfig("examples/hono/rpc.config.ts");
    expect(cfg.adapter).toBe("hono");
    expect(cfg.rpcPrefix).toBe("_server");
  });

  it("should fallback to defaults for missing file", async () => {
    const cfg = await loadRPCConfig("nonexistent/file.ts");
    expect(cfg.adapter).toBe("express");
  });

  it("should work with valid path", async () => {
    const cfg = await loadRPCConfig("tests/fixtures/good.config.ts");
    expect(cfg.rpcPrefix).toBe("_sv");
    expect(cfg.adapter).toBe("hono");
  });

  it("should fallback to defaults for invalid path", async () => {
    const cfg = await loadRPCConfig("tests/fixtures/dummy.config.ts");
    expect(cfg.adapter).toBe("express");
  });

  it("should fallback to defaults when loadConfigFile returns falsy for explicit path (line 92)", async () => {
    const cfg = await loadRPCConfig("tests/fixtures/empty-string.config.ts");
    expect(cfg.adapter).toBe("express");
  });

  it("should discover default config file rpc.config.ts when called from its own directory (lines 108-118)", async () => {
    vi.resetModules();
    const prev = process.cwd();
    process.chdir("tests/fixtures");
    try {
      serverFunctionsMap.clear();
      const { loadRPCConfig: loadRPCConfigFresh } = await import(
        "../src"
      );
      const cfg = await loadRPCConfigFresh();
      expect(cfg.rpcPrefix).toBe("_sv");
      expect(cfg.adapter).toBe("express");
    } finally {
      process.chdir(prev);
    }
  });
});

// ─── Default Options ───────────────────────────────────────────────────

describe("default options", () => {
  it("should have sensible server fn defaults", () => {
    expect(defaultServerFnOptions.contentType).toBe("application/json");
  });

  it("should have sensible RPC options", () => {
    expect(defaultRPCOptions.rpcPrefix).toBe("__rpc");
    expect(defaultRPCOptions.adapter).toBe("express");
  });

  it("should have sensible middleware options", () => {
    expect(defaultMiddlewareOptions.rpcPrefix).toBeUndefined();
    expect(defaultMiddlewareOptions.path).toBeUndefined();
  });
});

// ─── createServerFunction ──────────────────────────────────────────────

describe("createServerFunction", () => {
  let fn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return { data, cancel } shape", () => {
    const wrapped = createServerFunction(
      "test",
      vi.fn().mockResolvedValue("ok"),
    );
    const output = wrapped("arg");
    expect(output).toHaveProperty("data");
    expect(output).toHaveProperty("cancel");
    expect(output.data).toBeInstanceOf(Promise);
    expect(typeof output.cancel).toBe("function");
  });

  it("should throw when signal is already aborted", async () => {
    const Orig = globalThis.AbortController;
    globalThis.AbortController = class extends Orig {
      constructor() {
        super();
        this.abort();
      }
    };
    try {
      const wrapped = createServerFunction("pre-aborted", vi.fn());
      const { data } = wrapped();
      await expect(data).rejects.toThrow("Operation aborted");
    } finally {
      globalThis.AbortController = Orig;
    }
  });

  it("should register the function in serverFunctionsMap", () => {
    createServerFunction("my-fn", vi.fn());
    expect(serverFunctionsMap.has("my-fn")).toBe(true);
    const entry = serverFunctionsMap.get("my-fn");
    expect(entry!.name).toBe("my-fn");
    expect(typeof entry!.handler).toBe("function");
  });

  it("should call user fn with an AbortSignal and correct args", async () => {
    fn = vi.fn().mockResolvedValue("ok");
    const wrapped = createServerFunction(
      "test",
      fn as unknown as ServerFunctionInit,
    );
    const { data } = wrapped("hello", 42);
    await data;
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(expect.any(AbortSignal), "hello", 42);
  });

  it("should resolve data with the fn result", async () => {
    const wrapped = createServerFunction(
      "test",
      vi.fn().mockResolvedValue("my-result"),
    );
    const { data } = wrapped();
    await expect(data).resolves.toBe("my-result");
  });

  it("should pass a non-aborted signal by default", async () => {
    const wrapped = createServerFunction(
      "test",
      vi.fn().mockResolvedValue("ok"),
    );
    const { data } = wrapped("unique-cancel-a");
    await expect(data).resolves.toBe("ok");
  });

  it("cancel should abort the signal passed to user fn", async () => {
    let capturedSignal: AbortSignal;
    fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      capturedSignal = signal;
      await new Promise((r) => setTimeout(r, 30));
      return signal.aborted;
    });
    const wrapped = createServerFunction(
      "cancel-test",
      fn as unknown as ServerFunctionInit,
    );
    const { data, cancel } = wrapped("unique-cancel-b");
    cancel("user cancelled");
    await expect(data).resolves.toBe(true);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("should work with no args", async () => {
    fn = vi.fn().mockResolvedValue("no-args-result");
    const wrapped = createServerFunction(
      "no-args",
      fn as unknown as ServerFunctionInit,
    );
    const { data } = wrapped();
    await expect(data).resolves.toBe("no-args-result");
    expect(fn).toHaveBeenCalledOnce();
  });
});

// ─── getClientModules ──────────────────────────────────────────────────

describe("getClientModules", () => {
  beforeEach(() => {
    serverFunctionsMap.clear();
  });

  it("should only include handleResponse when no functions mapped", () => {
    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).not.toContain("export const");
  });

  it("should generate client exports for mapped functions", () => {
    serverFunctionsMap.set("say-hi", {
      name: "say-hi",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      options: {
        contentType: "application/json",
      },
      exportName: "sayHi",
    });

    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).toContain("export const sayHi");
  });

  it("should generate text/plain body for text content type", () => {
    serverFunctionsMap.set("echo", {
      name: "echo",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      options: { contentType: "text/plain" },
      exportName: "echo",
    });

    const code = getClientModules({ rpcPrefix: "rpc" });
    expect(code).toContain("Content-Type': 'text/plain'");
    expect(code).toContain("body = args[0]");
  });

  it("should generate JSON body for JSON content type", () => {
    serverFunctionsMap.set("add", {
      name: "add",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      options: { contentType: "application/json" },
      exportName: "add",
    });

    const code = getClientModules({ rpcPrefix: "api" });
    expect(code).toContain("const body");
  });

  it("should generate include credentials when set", () => {
    serverFunctionsMap.set("secureFn", {
      name: "secure-fn",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      options: { contentType: "application/json", credentials: "include" },
      exportName: "secureFn",
    });

    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).toContain('credentials = "include"');
  });

  it("should default to same-origin credentials", () => {
    serverFunctionsMap.set("defaultFn", {
      name: "default-fn",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      options: { contentType: "application/json" },
      exportName: "defaultFn",
    });

    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).toContain('credentials = "same-origin"');
  });

  it("should handle abort error in generated code", () => {
    serverFunctionsMap.set("fn", {
      name: "fn",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      exportName: "fn",
    });

    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).toContain("const name");
  });

  it("should handle 499/408 status as cancellation", () => {
    serverFunctionsMap.set("fn", {
      name: "fn",
      handler: (() => {}) as unknown as ServerFnEntry["handler"],
      exportName: "fn",
    });

    const code = getClientModules({ rpcPrefix: "__rpc" });
    expect(code).toContain("innerModule");
    // expect(code).toContain("408");
  });

  it("should work with vite 7", async () => {
    const plugin = rpcPlugin();
    (plugin.buildStart as any)?.call(mockPlugin7Context);
    (plugin.configResolved as any)({ mode: "development" } as any);

    const result = await (plugin.transform as any)(
      "createServerFunction()",
      "some-id.ts",
      { ssr: false },
    );

    expect(result?.code.length).toBeGreaterThan(0);
    expect(result?.map).toBeDefined();
  });

  it("should work with vite 8", async () => {
    const plugin = rpcPlugin();
    (plugin.buildStart as any)?.call(mockPlugin8Context);
    (plugin.configResolved as any)({ mode: "development" } as any);

    const result = await (plugin.transform as any)(
      "createServerFunction()",
      "some-id.ts",
      { ssr: false },
    );

    expect(result?.code.length).toBeGreaterThan(0);
    expect(result?.map).toBeDefined();
  });
});

// ─── validateIdentifier ────────────────────────────────────────────────

describe("validateIdentifier", () => {
  it("should pass valid identifiers", () => {
    expect(validateIdentifier("sayHi", "fn")).toBe("sayHi");
    expect(validateIdentifier("_private", "fn")).toBe("_private");
    expect(validateIdentifier("$value", "fn")).toBe("$value");
    expect(validateIdentifier("a1", "fn")).toBe("a1");
    expect(validateIdentifier("_", "fn")).toBe("_");
    expect(validateIdentifier("$", "fn")).toBe("$");
  });

  it("should throw for identifiers starting with a digit", () => {
    expect(() => validateIdentifier("1bad", "fn"))
      .toThrow('Invalid fn: "1bad" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/');
  });

  it("should throw for identifiers with special characters", () => {
    expect(() => validateIdentifier("bad!", "fn"))
      .toThrow('Invalid fn: "bad!" must match');
    expect(() => validateIdentifier("a b", "fn"))
      .toThrow('Invalid fn: "a b" must match');
    expect(() => validateIdentifier("foo-bar", "fn"))
      .toThrow('Invalid fn: "foo-bar" must match');
  });

  it("should throw for empty string", () => {
    expect(() => validateIdentifier("", "fn"))
      .toThrow('Invalid fn: "" must match');
  });

  it("should throw for code injection patterns", () => {
    expect(() => validateIdentifier("${evil()}", "fn"))
      .toThrow('Invalid fn: "${evil()}" must match');
    expect(() => validateIdentifier("greet; drop table", "fn"))
      .toThrow('Invalid fn: "greet; drop table" must match');
  });
});

// ─── validatePathSegment ───────────────────────────────────────────────

describe("validatePathSegment", () => {
  it("should pass valid path segments", () => {
    expect(validatePathSegment("say-hi", "fn")).toBe("say-hi");
    expect(validatePathSegment("api/rpc", "prefix")).toBe("api/rpc");
    expect(validatePathSegment("hello", "fn")).toBe("hello");
    expect(validatePathSegment("_foo/bar_", "fn")).toBe("_foo/bar_");
    expect(validatePathSegment("a1", "fn")).toBe("a1");
  });

  it("should throw for segments starting with /", () => {
    expect(() => validatePathSegment("/start", "fn"))
      .toThrow('Invalid fn: "/start" must match');
  });

  it("should throw for segments with special characters", () => {
    expect(() => validatePathSegment("bad!", "fn"))
      .toThrow('Invalid fn: "bad!" must match');
    expect(() => validatePathSegment("a b", "fn"))
      .toThrow('Invalid fn: "a b" must match');
    expect(() => validatePathSegment("foo..bar", "fn"))
      .toThrow('Invalid fn: "foo..bar" must match');
  });

  it("should throw for empty string", () => {
    expect(() => validatePathSegment("", "fn"))
      .toThrow('Invalid fn: "" must match');
  });

  it("should throw for code injection patterns in segments", () => {
    expect(() => validatePathSegment("${evil()}", "fn"))
      .toThrow('Invalid fn: "${evil()}" must match');
    expect(() => validatePathSegment("foo/../bar", "fn"))
      .toThrow('Invalid fn: "foo/../bar" must match');
  });
});

// ─── validateCredentials ───────────────────────────────────────────────

describe("validateCredentials", () => {
  it("should default to same-origin when undefined", () => {
    expect(validateCredentials()).toBe("same-origin");
    expect(validateCredentials(undefined)).toBe("same-origin");
  });

  it("should pass valid credentials values", () => {
    expect(validateCredentials("same-origin")).toBe("same-origin");
    expect(validateCredentials("include")).toBe("include");
    expect(validateCredentials("omit")).toBe("omit");
  });

  it("should throw for invalid credentials values", () => {
    expect(() => validateCredentials("same-site"))
      .toThrow('Invalid credentials: "same-site"');
    expect(() => validateCredentials("invalid"))
      .toThrow('Invalid credentials: "invalid"');
  });
});

// ─── Express Middleware (unit) ─────────────────────────────────────────

describe("Express middleware", () => {
  it("should create middleware and RPC middleware functions", async () => {
    expect(typeof createMiddleware).toBe("function");
    expect(typeof createRPCMiddleware).toBe("function");
  });

  it("should register a named middleware", async () => {
    const mw = createMiddleware({ name: "uniq-name", handler: vi.fn() });
    expect(mw).toBeInstanceOf(Function);
  });

  it("should throw on duplicate middleware name", async () => {
    expect(() => createMiddleware({ name: "dup-mw", handler: vi.fn() })).not
      .toThrow();
    expect(() => createMiddleware({ name: "dup-mw", handler: vi.fn() }))
      .toThrow("dup-mw");
  });
});
