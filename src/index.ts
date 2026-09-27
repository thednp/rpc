/** @module Main entrypoint for the RPC Vite plugin. Exports `rpcPlugin` (default) and `loadRPCConfig`. For a Vite-free `defineConfig`, use `@thednp/rpc/config`. */
import type { ConfigEnv, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { loadConfigFromFile, mergeConfig } from "vite";
// Namespace import: `transformWithOxc` only exists on Vite 8+, and the
// `isOxc` version check exists precisely to stay compatible with older
// resolutions. A namespace import keeps both members optional instead of
// turning a missing named export into a module link-time error.
import * as vite from "vite";
import { resolve } from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { defaultRPCOptions } from "./options.ts";
import type { RpcPluginOptions, ScanConfig } from "./types.d.ts";
import {
  CONFIG_FILE_NOT_FOUND,
  FAILED_LOAD_CONFIG,
  NO_CONFIG_FOUND,
} from "./constants.ts";

import { getClientModules } from "./getClientModules.ts";
// DEV server only
import {
  scanForServerFiles,
  scannedServerFiles,
} from "./scanForServerFiles.ts";
import { serverFunctionsMap } from "./functionsMap.ts";

import { setGlobalPrefix } from "@thednp/rpc/server";
import { createRPCMiddleware } from "@thednp/rpc/express";

/**
 * Loads and transforms a single RPC config file using Vite's config loader.
 * @param env - Vite config environment
 * @param file - Config file path (e.g. "rpc.config.ts")
 * @returns The loaded config augmented with the configFile path, or null on failure
 */
const loadConfigFile = async (env: ConfigEnv, file: string) => {
  const result = await loadConfigFromFile(env, file) as {
    path: string;
    config: Partial<RpcPluginOptions>;
    dependencies: string[];
  } | null;
  return result
    ? { ...result, config: { ...result.config, configFile: file } }
    : /* istanbul ignore next */ null;
};

let RPCConfig: RpcPluginOptions;

/**
 * Merges a loaded config file over the built-in defaults, recording the
 * resolved file path. Assigns the module-level `RPCConfig` cache.
 * @param config - The config object exported by the config file
 * @param configFilePath - Absolute path of the config file that was loaded
 * @returns The merged RPC plugin options
 */
const mergeLoaded = (
  config: Partial<RpcPluginOptions>,
  configFilePath: string,
): RpcPluginOptions => {
  RPCConfig = mergeConfig(
    { ...defaultRPCOptions, configFile: configFilePath },
    config,
  ) as RpcPluginOptions;
  return RPCConfig;
};

/**
 * Loads the RPC configuration by searching for config files in the project root.
 * Searches in order: `rpc.config.ts`, `rpc.config.js`, `rpc.config.mjs`, `rpc.config.mts`,
 * `.rpcrc.ts`, `.rpcrc.js`. Falls back to defaults if none found.
 * @param configFile - Optional explicit config file path; skips file search when provided
 * @param opts - Optional settings; `silent` suppresses the "no config found" warning
 * @returns Resolved RPC plugin options
 */
const loadRPCConfig: (
  configFile?: string | { silent?: boolean },
  opts?: { silent?: boolean },
) => Promise<RpcPluginOptions> = async (configFile?, opts?) => {
  // `loadRPCConfig({ silent: true })` is a documented call form. Without this
  // normalisation the options object is treated as a config path, `resolve`
  // throws on the non-string, and the catch below silently downgrades the
  // resolved config to the defaults.
  if (typeof configFile === "object" && configFile !== null) {
    opts = configFile;
    configFile = undefined;
  }
  try {
    // istanbul ignore next
    const env: ConfigEnv & { root: string } = {
      command: "serve",
      root: process.cwd(),
      mode: process.env.NODE_ENV || "development",
    };
    const defaultConfigFiles = [
      "rpc.config.ts",
      "rpc.config.js",
      "rpc.config.mjs",
      "rpc.config.mts",
      ".rpcrc.ts",
      ".rpcrc.js",
    ];

    // If specific config file provided
    if (configFile) {
      const configFilePath = resolve(env.root, configFile);
      if (!existsSync(configFilePath)) {
        console.warn(CONFIG_FILE_NOT_FOUND(configFile, configFilePath));
        RPCConfig = defaultRPCOptions;
        setGlobalPrefix(defaultRPCOptions.rpcPrefix);
        return defaultRPCOptions as RpcPluginOptions;
      }

      const result = await loadConfigFile(env, configFile);
      // istanbul ignore else
      if (result && typeof result === "object") {
        setGlobalPrefix(
          mergeLoaded(result.config, configFilePath).rpcPrefix,
        );
        return RPCConfig;
      }
      // istanbul ignore next - this is a necessary fallback here
      RPCConfig = defaultRPCOptions;
    }

    if (RPCConfig !== undefined) {
      setGlobalPrefix(RPCConfig.rpcPrefix);

      return RPCConfig;
    }

    // Try default config files
    for (const file of defaultConfigFiles) {
      const configFilePath = resolve(env.root, file);
      // istanbul ignore else
      if (!existsSync(configFilePath)) {
        continue;
      }

      const result = await loadConfigFile(env, file);
      // istanbul ignore else
      if (result) {
        // Every return path must publish the prefix, not just the explicit
        // `configFile` and no-config ones: this discovery path is the common
        // case (an `rpc.config.ts` exists), so skipping it left functions
        // registering under the default while the middleware dispatched on
        // the configured prefix.
        setGlobalPrefix(
          mergeLoaded(result.config, configFilePath).rpcPrefix,
        );
        return RPCConfig;
      }
    }
    RPCConfig = defaultRPCOptions;
    // Last call load defaults no matter what
    if (!opts?.silent) console.warn(NO_CONFIG_FOUND);
  } catch (error) {
    // Falls back to the defaults. Note this also resets the cache, so a
    // failed load downgrades a previously loaded config for the rest of the
    // process — the documented contract (and the tests) require the fallback,
    // so the stale value is not preserved here.
    RPCConfig = defaultRPCOptions;
    console.warn(FAILED_LOAD_CONFIG, error);
  }

  setGlobalPrefix(RPCConfig.rpcPrefix);

  return RPCConfig;
};

/**
 * Vite plugin that enables automatic RPC generation.
 * Transforms server function imports into fetch-based client stubs during development and production builds.
 * In dev mode, attaches the RPC middleware to Vite's Connect server.
 * @param devOptions - Development-only overrides (merged on top of config file values)
 * @returns A Vite plugin object
 */
function rpcPlugin(
  devOptions: Partial<RpcPluginOptions> = {},
): Plugin {
  // `rpcPrefix` is required on RpcPluginOptions but defaulted here, so the
  // resolved options always carry one for the scan and the client stubs.
  let options: RpcPluginOptions & { rpcPrefix: string } = mergeConfig(
    defaultRPCOptions,
    devOptions,
  ) as RpcPluginOptions;
  let config: ResolvedConfig;
  let viteServer: ViteDevServer;
  let isOxc = true;

  return {
    name: "vite-plugin-universal-rpc",
    enforce: "pre",
    // Plugin methods
    async configResolved(resolvedConfig) {
      const uniConfig = await loadRPCConfig(undefined, {
        silent: devOptions.silent,
      });
      options = mergeConfig(uniConfig, devOptions) as RpcPluginOptions;

      config = resolvedConfig;
    },
    async configureServer(server) {
      viteServer = server;
      // istanbul ignore else
      if (serverFunctionsMap.size === 0) {
        const scanCfg: ScanConfig = {
          ...config,
          serverFiles: options.serverFiles,
          scanRoot: options.scanRoot,
          rpcPrefix: options.rpcPrefix,
        };
        await scanForServerFiles(scanCfg, viteServer);
      }

      // in dev mode we always use the express/connect middleware, since the
      // Vite dev server is Connect-based — there is no adapter to select.
      server.middlewares.use(createRPCMiddleware(options));
    },

    async buildStart() {
      const viteVersion = this.meta?.viteVersion;
      isOxc = Number.parseInt(viteVersion, 10) >= 8;

      // Prepare the server functions
      if (!viteServer && config) {
        const scanCfg: ScanConfig = {
          ...config,
          serverFiles: options.serverFiles,
          scanRoot: options.scanRoot,
          rpcPrefix: options.rpcPrefix,
        };
        await scanForServerFiles(scanCfg);
      }
    },
    async transform(code: string, id: string, ops?: { ssr?: boolean }) {
      // Only transform files with server functions for client builds: any
      // other file is unchanged, and a file loaded on the server (SSR) is
      // left as-is.
      if (!code.includes("createServerFunction") || ops?.ssr) {
        return null;
      }

      if (serverFunctionsMap.size === 0) {
        const scanCfg: ScanConfig = {
          ...config,
          serverFiles: options.serverFiles,
          scanRoot: options.scanRoot,
          rpcPrefix: options.rpcPrefix,
        };
        await scanForServerFiles(scanCfg);
      }

      // Only transform modules that were scanned as server function files:
      // pages or docs mentioning `createServerFunction` in prose must not
      // be rewritten into the generated client bundle.
      const idPath = vite.normalizePath(id.split("?")[0]);
      if (!scannedServerFiles.has(idPath)) {
        return null;
      }

      const transformer = isOxc ? "transformWithOxc" : "transformWithEsbuild";
      const langProp = isOxc ? "lang" : "loader";
      const source = getClientModules({ rpcPrefix: options.rpcPrefix });

      const result = await vite[transformer](source, id, {
        [langProp]: "js",
        sourcemap: true,
        // target: "es2023"
      });

      return {
        code: result.code,
        map: result.map
          ? typeof result.map === "string"
            ? JSON.parse(result.map)
            : /* istanbul ignore next @preserve */ result.map
          : /* istanbul ignore next @preserve */ null,
      };
    },
  } satisfies Plugin;
}

export { rpcPlugin as default };
export { loadRPCConfig };
export type * from "./types.d.ts";
export {};
