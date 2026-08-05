/** @module Main entrypoint for the RPC Vite plugin. Exports `rpcPlugin` (default), `defineConfig`, and `loadRPCConfig`. */
import type { ConfigEnv, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { loadConfigFromFile, mergeConfig } from "vite";
import { resolve } from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { defaultRPCOptions } from "./options.ts";
import type { RpcPluginOptions } from "./types.d.ts";
import {
  CONFIG_FILE_NOT_FOUND,
  FAILED_LOAD_CONFIG,
  NO_CONFIG_FOUND,
} from "./constants.ts";

import {
  getClientModules,
  scanForServerFiles,
  serverFunctionsMap,
} from "@thednp/rpc/server";

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

/**
 * Type-safe helper to create an RPC configuration object.
 * Merges the provided partial config with built-in defaults.
 * @param uniConfig - System-wide RPC configuration overrides
 * @returns Complete RPC plugin options with defaults applied
 */
const defineConfig: (c: Partial<RpcPluginOptions>) => RpcPluginOptions = (
  uniConfig: Partial<RpcPluginOptions>,
) => {
  return mergeConfig(defaultRPCOptions, uniConfig) as RpcPluginOptions;
};

let RPCConfig: RpcPluginOptions;

/**
 * Loads the RPC configuration by searching for config files in the project root.
 * Searches in order: `rpc.config.ts`, `rpc.config.js`, `rpc.config.mjs`, `rpc.config.mts`,
 * `.rpcrc.ts`, `.rpcrc.js`. Falls back to defaults if none found.
 * @param configFile - Optional explicit config file path; skips file search when provided
 * @returns Resolved RPC plugin options
 */
const loadRPCConfig: (f?: string) => Promise<RpcPluginOptions> = async (
  configFile?: string,
) => {
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
        return defaultRPCOptions as RpcPluginOptions;
      }

      const result = await loadConfigFile(env, configFile);
      // istanbul ignore else
      if (result && typeof result === "object") {
        RPCConfig = mergeConfig(
          {
            ...defaultRPCOptions,
            configFile: configFilePath,
          },
          result.config,
        ) as RpcPluginOptions;

        return RPCConfig;
      }
      // istanbul ignore next - this is a necessary fallback here
      RPCConfig = defaultRPCOptions;
    }

    if (RPCConfig !== undefined) {
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
        RPCConfig = mergeConfig(
          {
            ...defaultRPCOptions,
            configFile: configFilePath,
          },
          result.config,
        ) as RpcPluginOptions;

        return RPCConfig;
      }
    }
    RPCConfig = defaultRPCOptions;
    // Last call load defaults no matter what
    console.warn(NO_CONFIG_FOUND);
    // return defaultRPCOptions as RpcPluginOptions;
    // RPCConfig = defaultRPCOptions;
  } catch (error) {
    RPCConfig = defaultRPCOptions;
    console.warn(FAILED_LOAD_CONFIG, error);
    // return defaultRPCOptions as RpcPluginOptions;
  }

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
): Plugin<unknown> {
  // Internal type - adapters are handled at runtime
  let options: RpcPluginOptions & { rpcPrefix: string };
  let config: ResolvedConfig;
  let viteServer: ViteDevServer;
  let isOxc = true;

  return {
    name: "vite-plugin-universal-rpc",
    enforce: "pre",
    // Plugin methods
    // config() {
    //   return {
    //     // optimizeDeps: {
    //     //   noDiscovery: true,
    //     //   include: ["@thednp/rpc"],
    //     // },
    //     ssr: {
    //       noExternal: ["@thednp/rpc"],
    //     },
    //   };
    // },
    async configResolved(resolvedConfig) {
      const uniConfig = await loadRPCConfig();
      options = mergeConfig(uniConfig, devOptions) as RpcPluginOptions;

      config = resolvedConfig;
    },
    async configureServer(server) {
      viteServer = server;
      const { adapter: _adapter, ...rest } = options;
      // istanbul ignore else
      if (serverFunctionsMap.size === 0) {
        await scanForServerFiles(config, viteServer);
      }

      // in dev mode we always use express/connect adapter
      server.middlewares.use(createRPCMiddleware(rest));
    },

    async buildStart() {
      const viteVersion = this.meta?.viteVersion;
      isOxc = Number(viteVersion[0]) >= 8;

      // Prepare the server functions
      if (!viteServer && config) {
        await scanForServerFiles(config);
      }
    },
    async transform(code: string, id: string, ops?: { ssr?: boolean }) {
      // Only transform files with server functions for client builds
      if (
        !code.includes("createServerFunction") || // any other file is unchanged
        ops?.ssr || // file loaded on server remains unchanged
        (code.includes("createServerFunction") &&
          typeof process === "undefined") // file loaded in client IS CHANGED
      ) {
        return null;
      }

      if (serverFunctionsMap.size === 0) {
        await scanForServerFiles(config);
      }

      const vite = await import("vite");
      const transformer = isOxc ? "transformWithOxc" : "transformWithEsbuild";
      const langProp = isOxc ? "lang" : "loader";
      const source = getClientModules({
        rpcPrefix: options.rpcPrefix,
        adapter: options.adapter,
      });

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
export { defineConfig, loadRPCConfig };
export type * from "./types.d.ts";
export {};
