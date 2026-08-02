import type { ViteDevServer } from "vite";
import type { ClientFunctionWithOptions, ScanConfig } from "./types.d.ts";
import { createServer } from "vite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { serverFunctionsMap } from "./functionsMap.ts";
import { ERROR_LOADING_FILE, NO_SERVER_FUNCTION_FOUND } from "./constants.ts";

let isScanned = false;
/**
 * Scans `src/api/` for server function files (`server.ts`, `server.js`, `server.mjs`, `server.mts`)
 * and populates the global `serverFunctionsMap` with their exported functions.
 * Uses Vite's SSR module loading to resolve and execute each file.
 * @param initialCfg - Optional Vite config overrides (root, base, server)
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
      root: process.cwd(),
    };

  let server = devServer;
  if (!server) {
    server = await createServer({
      server: config.server,
      appType: "custom",
      base: config.base,
      root: config.root,
    });
  }

  const svFiles = ["server.ts", "server.js", "server.mjs", "server.mts"];
  const apiDir = join(config.root, "src", "api");
  let files: string[];
  try {
    files = (await readdir(apiDir, { withFileTypes: true }))
      .filter((f) => svFiles.includes(f.name))
      .map((f) => join(apiDir, f.name));
  } catch (_e) {
    files = [];
  }

  try {
    for (const file of files) {
      try {
        const moduleExports = (await server.ssrLoadModule(file)) as Record<
          string,
          ClientFunctionWithOptions
        >;
        const moduleEntries = Object.entries(moduleExports);
        if (!moduleEntries.length) {
          console.warn(NO_SERVER_FUNCTION_FOUND);
          return;
        }

        for (const [exportName, exportValue] of moduleEntries) {
          // const registeredName = exportValue?.name ?? exportName;
          const registeredName = exportValue.name;
          serverFunctionsMap.set(registeredName, {
            name: registeredName,
            handler: exportValue,
            options: exportValue?.options,
            exportName,
          });
        }
      } catch (error) {
        console.error(ERROR_LOADING_FILE, file, error);
      }
    }
  } finally {
    if (!devServer && server) {
      await server.close();
    }
    isScanned = true;
  }
};
