import { loadConfigFromFile, mergeConfig } from "vite";
import { resolve } from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { getClientModules, scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { createRPCMiddleware } from "@thednp/rpc/express";
//#region src/options.ts
const defaultRPCOptions = {
	rpcPrefix: "__rpc",
	adapter: "express"
};
//#endregion
//#region src/constants.ts
/** Warning message when a specified RPC config file cannot be resolved on disk. @param configFile - The requested config filename. @param configFilePath - The resolved absolute path */
const CONFIG_FILE_NOT_FOUND = (configFile, configFilePath) => `  ⚠︎ The specified RPC config file ${configFile} cannot be found at ${configFilePath}, loading the defaults..`;
const NO_CONFIG_FOUND = ` ⚡︎ No RPC config found, loading the defaults..`;
const FAILED_LOAD_CONFIG = ` ⚠︎ Failed to load RPC config:`;
//#endregion
//#region src/index.ts
/**
* Loads and transforms a single RPC config file using Vite's config loader.
* @param env - Vite config environment
* @param file - Config file path (e.g. "rpc.config.ts")
* @returns The loaded config augmented with the configFile path, or null on failure
*/
const loadConfigFile = async (env, file) => {
	const result = await loadConfigFromFile(env, file);
	return result ? {
		...result,
		config: {
			...result.config,
			configFile: file
		}
	} : null;
};
/**
* Type-safe helper to create an RPC configuration object.
* Merges the provided partial config with built-in defaults.
* @param uniConfig - System-wide RPC configuration overrides
* @returns Complete RPC plugin options with defaults applied
*/
const defineConfig = (uniConfig) => {
	return mergeConfig(defaultRPCOptions, uniConfig);
};
let RPCConfig;
/**
* Loads the RPC configuration by searching for config files in the project root.
* Searches in order: `rpc.config.ts`, `rpc.config.js`, `rpc.config.mjs`, `rpc.config.mts`,
* `.rpcrc.ts`, `.rpcrc.js`. Falls back to defaults if none found.
* @param configFile - Optional explicit config file path; skips file search when provided
* @returns Resolved RPC plugin options
*/
const loadRPCConfig = async (configFile) => {
	try {
		const env = {
			command: "serve",
			root: process.cwd(),
			mode: process.env.NODE_ENV || "development"
		};
		const defaultConfigFiles = [
			"rpc.config.ts",
			"rpc.config.js",
			"rpc.config.mjs",
			"rpc.config.mts",
			".rpcrc.ts",
			".rpcrc.js"
		];
		if (configFile) {
			const configFilePath = resolve(env.root, configFile);
			if (!existsSync(configFilePath)) {
				console.warn(CONFIG_FILE_NOT_FOUND(configFile, configFilePath));
				RPCConfig = defaultRPCOptions;
				return defaultRPCOptions;
			}
			const result = await loadConfigFile(env, configFile);
			if (result && typeof result === "object") {
				RPCConfig = mergeConfig({
					...defaultRPCOptions,
					configFile: configFilePath
				}, result.config);
				return RPCConfig;
			}
			RPCConfig = defaultRPCOptions;
		}
		if (RPCConfig !== void 0) return RPCConfig;
		for (const file of defaultConfigFiles) {
			const configFilePath = resolve(env.root, file);
			if (!existsSync(configFilePath)) continue;
			const result = await loadConfigFile(env, file);
			if (result) {
				RPCConfig = mergeConfig({
					...defaultRPCOptions,
					configFile: configFilePath
				}, result.config);
				return RPCConfig;
			}
		}
		RPCConfig = defaultRPCOptions;
		console.warn(NO_CONFIG_FOUND);
	} catch (error) {
		RPCConfig = defaultRPCOptions;
		console.warn(FAILED_LOAD_CONFIG, error);
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
function rpcPlugin(devOptions = {}) {
	let options;
	let config;
	let viteServer;
	let isOxc = true;
	return {
		name: "vite-plugin-universal-rpc",
		enforce: "pre",
		async configResolved(resolvedConfig) {
			const uniConfig = await loadRPCConfig();
			options = mergeConfig(uniConfig, devOptions);
			config = resolvedConfig;
		},
		async configureServer(server) {
			viteServer = server;
			const { adapter: _adapter, ...rest } = options;
			if (serverFunctionsMap.size === 0) await scanForServerFiles(config, viteServer);
			server.middlewares.use(createRPCMiddleware(rest));
		},
		async buildStart() {
			const viteVersion = this.meta?.viteVersion;
			isOxc = Number(viteVersion[0]) >= 8;
			if (!viteServer && config) await scanForServerFiles(config);
		},
		async transform(code, id, ops) {
			if (!code.includes("createServerFunction") || ops?.ssr || code.includes("createServerFunction") && typeof process === "undefined") return null;
			if (serverFunctionsMap.size === 0) await scanForServerFiles(config);
			const vite = await import("vite");
			const transformer = isOxc ? "transformWithOxc" : "transformWithEsbuild";
			const langProp = isOxc ? "lang" : "loader";
			const source = getClientModules({
				rpcPrefix: options.rpcPrefix,
				adapter: options.adapter
			});
			const result = await vite[transformer](source, id, {
				[langProp]: "js",
				sourcemap: true
			});
			return {
				code: result.code,
				map: result.map ? typeof result.map === "string" ? JSON.parse(result.map) : result.map : null
			};
		}
	};
}
//#endregion
export { rpcPlugin as default, defineConfig, loadRPCConfig };

//# sourceMappingURL=index.mjs.map