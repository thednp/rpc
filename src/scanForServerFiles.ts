import type { ViteDevServer } from "vite";
import type { ClientFunctionWithOptions, ScanConfig } from "./types.d.ts";
import { createServer, normalizePath } from "vite";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { serverFunctionsMap } from "./functionsMap.ts";
import { walkGlobFiles } from "./server-helpers.ts";
import {
  DUPLICATE_FUNCTION_NAME,
  ERROR_LOADING_FILE,
  NO_SERVER_FUNCTION_FOUND,
} from "./constants.ts";

let isScanned = false;

/** Absolute ids (normalized) of the scanned server function files. */
export const scannedServerFiles: Set<string> = new Set<string>();

const EXACT_NAMES = ["server.ts", "server.js", "server.mjs", "server.mts"];

/**
 * Scans `src/api/` (or an explicit `scanRoot`) for server function files
 * and populates the global `serverFunctionsMap` with their exported functions.
 * Uses Vite's SSR module loading to resolve and execute each file.
 *
 * Supports two matching modes via `config.serverFiles`:
 *   `"exact"` — classic `server.ts|js|mjs|mts` names in the api directory
 *   `"glob"` — recursively walking `scanRoot` to match `*.server.{ts,js,mjs,mts}`
 * @param initialCfg - Optional Vite config overrides (root, base, server, serverFiles, scanRoot)
 * @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
 */
export const scanForServerFiles = async (
  initialCfg?: ScanConfig,
  devServer?: ViteDevServer,
): Promise<void> => {
  if (isScanned && !devServer) {
    return;
  }
  const config = (!initialCfg && !devServer) || !initialCfg
    ? {
      root: process.cwd(),
      base: process.env.BASE || "/",
      server: { middlewareMode: true },
    }
    : {
      ...initialCfg,
    };

  let server = devServer;
  if (!server) {
    server = await createServer({
      server: { ...config.server, ws: false },
      appType: "custom",
      base: config.base || "/",
      root: config.root || process.cwd(),
      // The internal server is only used to load the server function files:
      // skip the project config so its plugins (including this one) do not
      // re-trigger a nested scan via `configureServer`.
      configFile: false,
      // The internal server never serves a page or HMR, so no dependency
      // optimization or WebSocket server is needed. Without `ws: false`, the
      // middleware-mode server creates a standalone HMR WebSocket on port
      // 24678, and concurrent scans (e.g. the Express middleware's lazy scan
      // racing the plugin scan) fail with EADDRINUSE. Without `noDiscovery`,
      // the default optimizers scan the project entry and pre-bundle the whole
      // `vite` package (imported by the linked @thednp/rpc dist files),
      // hanging startup at 2+ GB RSS.
      optimizeDeps: { noDiscovery: true },
      ssr: { optimizeDeps: { noDiscovery: true } },
    });
  }

  const root = config.root || process.cwd();
  const resolvedScanRoot = resolve(
    root,
    (config as ScanConfig).scanRoot ?? join(root, "src", "api"),
  );
  const serverFiles: "exact" | "glob" = (config as ScanConfig).serverFiles ??
    "exact";

  // Names registered during this scan run, used for duplicate detection
  // (see the registration loop below).
  const seenNames = new Set<string>();

  let files: string[];
  try {
    if (serverFiles === "glob") {
      files = await walkGlobFiles(resolvedScanRoot);
    } else {
      files = (await readdir(resolvedScanRoot, { withFileTypes: true }))
        .filter((f) => EXACT_NAMES.includes(f.name))
        .map((f) => join(resolvedScanRoot, f.name));
    }
  } catch (_e) {
    files = [];
  }

  try {
    for (const file of files) {
      scannedServerFiles.add(normalizePath(file));
      let moduleExports: Record<string, ClientFunctionWithOptions>;
      try {
        moduleExports = (await server.ssrLoadModule(file)) as Record<
          string,
          ClientFunctionWithOptions
        >;
      } catch (error) {
        console.error(ERROR_LOADING_FILE, file, error);
        continue;
      }
      const moduleEntries = Object.entries(moduleExports);
      if (!moduleEntries.length) {
        console.warn(NO_SERVER_FUNCTION_FOUND);
        return;
      }

      // `createServerFunction` auto-registers its name into the map at module
      // load, so the global map cannot be used for duplicate detection across
      // scans (dev re-scans the same modules via the same or fresh Vite graphs).
      // Track names seen in THIS scan run only: a name repeated within one scan
      // (e.g. two files exporting the same function name) is a genuine conflict.
      for (const [exportName, exportValue] of moduleEntries) {
        const registeredName = exportValue.name;
        if (seenNames.has(registeredName)) {
          if (process.env.NODE_ENV !== "production") {
            throw new Error(DUPLICATE_FUNCTION_NAME(registeredName));
          }
          console.warn(DUPLICATE_FUNCTION_NAME(registeredName));
          continue;
        }
        seenNames.add(registeredName);
        serverFunctionsMap.set(registeredName, {
          name: registeredName,
          handler: exportValue,
          options: exportValue?.options,
          exportName,
        });
      }
    }
  } finally {
    if (!devServer && server) {
      await server.close();
    }
    isScanned = true;
  }
};
