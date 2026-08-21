import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { scanForServerFiles } from "../src/scanForServerFiles.ts";
import { createServerFunction } from "../src/createFunction.ts";

import {
  getFunctionsForPrefix,
  serverFunctionsByPrefix,
  serverFunctionsMap,
} from "../src/functionsMap.ts";

beforeEach(() => {
  for (const map of serverFunctionsByPrefix.values()) {
    map.clear();
  }
});

afterEach(() => {
  // Restore cwd if a test changed it
});

const originalCwd = process.cwd();

describe("scanForServerFiles", () => {
  it("should scan real example server files from examples/express", async () => {
    // const { scanForServerFiles } = await import("../src/scanForServerFiles");
    // Change to examples/express so process.cwd() points to the example
    process.chdir("examples/express");
    try {
      await scanForServerFiles();
      expect(serverFunctionsMap.size).toBeGreaterThan(0);
      const names = Array.from(serverFunctionsMap.keys());
      expect(names).toContain("say-hi");
      expect(names).toContain("add-numbers");
      const sayHiEntry = serverFunctionsMap.get("say-hi");
      expect(sayHiEntry?.exportName).toBe("sayHi");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should skip scan when already scanned (isScanned flag)", async () => {
    // isScanned is true from the previous test.
    // Even though beforeEach cleared the maps, calling scanForServerFiles again
    // (without devServer) returns early and doesn't re-populate.
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    // maps are empty (from beforeEach), and scan skips → stay empty
    expect(serverFunctionsMap.size).toBe(0);
    await scanForServerFiles();
    expect(serverFunctionsMap.size).toBe(0); // still empty, scan skipped
  });

  it("should use provided devServer instead of creating a new one", async () => {
    process.chdir("examples/express");
    try {
      const { scanForServerFiles } = await import(
        "../src/scanForServerFiles"
      );
      const ssrLoadModule = vi.fn().mockResolvedValue({
        testFn: vi.fn(),
      });
      const mockDevServer = {
        ssrLoadModule,
        close: vi.fn(),
      } as unknown as ViteDevServer;
      serverFunctionsMap.clear();
      await scanForServerFiles(
        { base: "/" },
        mockDevServer,
      );
      // ssrLoadModule should have been called for each server file in examples/express/src/api
      expect(ssrLoadModule).toHaveBeenCalled();
      // The mock devServer should NOT be closed (only temp servers are closed)
      expect(mockDevServer.close).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should handle ENOENT when src/api does not exist", async () => {
    // Change to a directory without src/api — the root project dir itself
    process.chdir(originalCwd);
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    // isScanned might be true from previous tests, but we can pass devServer
    // to bypass the isScanned check
    const mockDevServer = {
      ssrLoadModule: vi.fn(),
      close: vi.fn(),
    } as unknown as ViteDevServer;
    serverFunctionsMap.clear();
    await scanForServerFiles({ root: originalCwd, base: "/" }, mockDevServer);
    // No modules loaded because no files found
    expect(mockDevServer.ssrLoadModule).not.toHaveBeenCalled();
    // Map should be empty
    expect(serverFunctionsMap.size).toBe(0);
  });

  it("should handle error loading a file gracefully", async () => {
    process.chdir("examples/express");
    try {
      const { scanForServerFiles } = await import(
        "../src/scanForServerFiles"
      );
      const ssrLoadModule = vi.fn().mockRejectedValue(
        new Error("Failed to load module"),
      );
      const mockDevServer = {
        ssrLoadModule,
        close: vi.fn(),
      } as unknown as ViteDevServer;
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const origWarn = console.error;
      serverFunctionsMap.clear();
      await scanForServerFiles(
        { base: "/" },
        mockDevServer,
      );
      // The error should be caught and logged, not thrown
      expect(console.error).toHaveBeenCalled();
      warnSpy.mockRestore();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should warn when module has no exports", async () => {
    process.chdir("examples/express");
    try {
      const { scanForServerFiles } = await import(
        "../src/scanForServerFiles"
      );
      const ssrLoadModule = vi.fn().mockResolvedValue({});
      const mockDevServer = {
        ssrLoadModule,
        close: vi.fn(),
      } as unknown as ViteDevServer;
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      serverFunctionsMap.clear();
      await scanForServerFiles(
        { base: "/" },
        mockDevServer,
      );
      expect(console.warn).toHaveBeenCalledWith("No server function found.");
      warnSpy.mockRestore();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should only load exact server file names (not server.tsx or my-server.ts)", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockResolvedValue({
      testFn: { name: "test-fn" },
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    serverFunctionsMap.clear();
    // scanForServerFiles resolves the api dir from process.cwd()
    process.chdir("tests/fixtures/scan-api");
    try {
      await scanForServerFiles(
        { base: "/" },
        mockDevServer,
      );
      // Only server.ts should be loaded; server.tsx, my-server.ts,
      // and not-server.mjs must be ignored (no partial name matching)
      expect(ssrLoadModule).toHaveBeenCalledTimes(1);
      expect(serverFunctionsMap.get("test-fn")?.exportName).toBe("testFn");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should scan *.server.* files recursively in glob mode", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockImplementation(async (file: string) => {
      if (file.includes("users.server.ts")) {
        return { getUsers: { name: "get-users" } };
      }
      if (file.includes("upload.server.mts")) {
        return { uploadFile: { name: "upload-file" } };
      }
      return { unknownFn: { name: "unknown-fn" } };
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    serverFunctionsMap.clear();
    process.chdir("tests/fixtures/scan-api");
    try {
      await scanForServerFiles(
        {
          base: "/",
          serverFiles: "glob",
        },
        mockDevServer,
      );
      expect(ssrLoadModule).toHaveBeenCalledTimes(2);
      expect(serverFunctionsMap.get("get-users")?.exportName).toBe(
        "getUsers",
      );
      expect(serverFunctionsMap.get("upload-file")?.exportName).toBe(
        "uploadFile",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should use explicit scanRoot in glob mode", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockImplementation(async (file: string) => {
      if (file.includes("users.server.ts")) {
        return { getUsers: { name: "get-users" } };
      }
      return { uploadFile: { name: "upload-file" } };
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    serverFunctionsMap.clear();
    process.chdir("examples/express");
    try {
      await scanForServerFiles(
        {
          base: "/",
          serverFiles: "glob",
          scanRoot: `${originalCwd}/tests/fixtures/scan-api/src/api`,
        },
        mockDevServer,
      );
      expect(ssrLoadModule).toHaveBeenCalledTimes(2);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should register functions under their declared prefix without name collision", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockImplementation(async (file: string) => {
      if (file.includes("users.server.ts")) {
        return {
          login: { name: "login", options: { rpcPrefix: "v1:rpc" } },
        };
      }
      return {
        login: { name: "login", options: { rpcPrefix: "v2:rpc" } },
      };
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    process.chdir("tests/fixtures/scan-api");
    try {
      await scanForServerFiles(
        {
          base: "/",
          serverFiles: "glob",
        },
        mockDevServer,
      );
      // Same registered name under different prefixes is not a duplicate
      expect(ssrLoadModule).toHaveBeenCalledTimes(2);
      expect(getFunctionsForPrefix("v1:rpc").get("login")?.exportName).toBe(
        "login",
      );
      expect(getFunctionsForPrefix("v2:rpc").get("login")?.exportName).toBe(
        "login",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should update exportName on an existing auto-registered function", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    // createServerFunction auto-registers "login" under the default prefix
    const loginFn = createServerFunction("login", vi.fn());
    const ssrLoadModule = vi.fn().mockImplementation(async (file: string) => {
      if (file.includes("users.server.ts")) {
        return { doLogin: loginFn };
      }
      return { otherFn: { name: "other-fn" } };
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    process.chdir("tests/fixtures/scan-api");
    try {
      await scanForServerFiles(
        {
          base: "/",
          serverFiles: "glob",
        },
        mockDevServer,
      );
      // The scan found the already-registered entry and updated exportName
      expect(serverFunctionsMap.get("login")?.exportName).toBe("doLogin");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should throw on duplicate server function names in dev mode", async () => {
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockResolvedValue({
      firstFn: { name: "dup-fn" },
      secondFn: { name: "dup-fn" },
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    serverFunctionsMap.clear();
    process.chdir("tests/fixtures/scan-api");
    try {
      await expect(
        scanForServerFiles(
          { base: "/" },
          mockDevServer,
        ),
      ).rejects.toThrow(
        'Duplicate server function "dup-fn" detected. Each server function must have a unique name. Remove or rename the duplicate.',
      );
      expect(serverFunctionsMap.size).toBe(1);
      expect(serverFunctionsMap.get("dup-fn")?.exportName).toBe("firstFn");
    } finally {
      errorSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it("should warn and keep the first on duplicates in production mode", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const { scanForServerFiles } = await import(
      "../src/scanForServerFiles"
    );
    const ssrLoadModule = vi.fn().mockResolvedValue({
      firstFn: { name: "dup-fn" },
      secondFn: { name: "dup-fn" },
    });
    const mockDevServer = {
      ssrLoadModule,
      close: vi.fn(),
    } as unknown as ViteDevServer;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    serverFunctionsMap.clear();
    process.chdir("tests/fixtures/scan-api");
    try {
      await scanForServerFiles(
        { base: "/" },
        mockDevServer,
      );
      expect(console.warn).toHaveBeenCalledWith(
        'Duplicate server function "dup-fn" detected. Each server function must have a unique name. Remove or rename the duplicate.',
      );
      expect(serverFunctionsMap.size).toBe(1);
      expect(serverFunctionsMap.get("dup-fn")?.exportName).toBe("firstFn");
    } finally {
      warnSpy.mockRestore();
      process.env.NODE_ENV = prevEnv;
      process.chdir(originalCwd);
    }
  });
});
