import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { scanForServerFiles } from "../src/scanForServerFiles.ts";

import { serverFunctionsMap } from "../src/functionsMap.ts";

beforeEach(() => {
  serverFunctionsMap.clear();
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
        { root: "examples/express", base: "/" },
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
        { root: "examples/express", base: "/" },
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
        { root: "examples/express", base: "/" },
        mockDevServer,
      );
      expect(console.warn).toHaveBeenCalledWith("No server function found.");
      warnSpy.mockRestore();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
