import { loadConfigFromFile, mergeConfig } from "vite";
import { join, resolve } from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRPCMiddleware } from "@thednp/rpc/express";
//#region src/options.ts
const defaultPrefix = "__rpc";
const defaultRPCOptions = {
	rpcPrefix: defaultPrefix,
	adapter: "express",
	serverFiles: "exact",
	scanRoot: void 0
};
//#endregion
//#region src/constants.ts
const NO_SERVER_FUNCTION_FOUND = "No server function found.";
const ERROR_LOADING_FILE = "Error loading file:";
/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
const INVALID_IDENTIFIER = (label, name) => `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;
/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
const INVALID_PATH_SEGMENT = (label, segment) => `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/`;
/** Warning message when a specified RPC config file cannot be resolved on disk. @param configFile - The requested config filename. @param configFilePath - The resolved absolute path */
const CONFIG_FILE_NOT_FOUND = (configFile, configFilePath) => `  ⚠︎ The specified RPC config file ${configFile} cannot be found at ${configFilePath}, loading the defaults..`;
const NO_CONFIG_FOUND = ` ⚡︎ No RPC config found, loading the defaults..`;
const FAILED_LOAD_CONFIG = ` ⚠︎ Failed to load RPC config:`;
/** Error template for duplicate server function names across files. @param name - The duplicate registered name */
const DUPLICATE_FUNCTION_NAME = (name) => `Duplicate server function "${name}" detected. Each server function must have a unique name. Remove or rename the duplicate.`;
//#endregion
//#region src/functionsMap.ts
/**
* Global symbol under which the shared `serverFunctionsByPrefix` map is stored
* on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
* across the bundled entry copies (`index.mjs`, `server.mjs`, `express.mjs`,
* ...) and dev-server hot reloads, exactly like the request-context storage in
* `context.ts`. Without this, `scanForServerFiles` (bundled into the plugin)
* would populate a map copy the adapter middleware could not read.
*/
const functionsMapSymbol = Symbol.for("thednp.rpc.functionsMap");
/**
* Map of rpcPrefix -> Map of function names -> ServerFnEntry
* Enables multiple RPC instances with different prefixes to coexist
* without name collisions.
*/
const serverFunctionsByPrefix = globalThis[functionsMapSymbol] ??= /* @__PURE__ */ new Map();
/**
* Gets or creates the function map for a specific prefix.
* @param prefix - The RPC prefix (e.g., "__rpc", "v1:rpc", "admin:rpc")
* @returns Map of function names to ServerFnEntry for that prefix
*/
const getFunctionsForPrefix = (prefix) => {
	if (!serverFunctionsByPrefix.has(prefix)) serverFunctionsByPrefix.set(prefix, /* @__PURE__ */ new Map());
	return serverFunctionsByPrefix.get(prefix);
};
/**
* Backward compatibility: default map for the default prefix.
* Legacy code can still use serverFunctionsMap.set(name, entry).
*/
const serverFunctionsMap = {
	get: (key) => getFunctionsForPrefix(defaultPrefix).get(key),
	set: (key, value) => getFunctionsForPrefix(defaultPrefix).set(key, value),
	has: (key) => getFunctionsForPrefix(defaultPrefix).has(key),
	delete: (key) => getFunctionsForPrefix(defaultPrefix).delete(key),
	clear: () => getFunctionsForPrefix(defaultPrefix).clear(),
	get size() {
		return getFunctionsForPrefix(defaultPrefix).size;
	},
	entries: () => getFunctionsForPrefix(defaultPrefix).entries(),
	keys: () => getFunctionsForPrefix(defaultPrefix).keys(),
	values: () => getFunctionsForPrefix(defaultPrefix).values(),
	forEach: (callback) => getFunctionsForPrefix(defaultPrefix).forEach(callback),
	[Symbol.iterator]: () => getFunctionsForPrefix(defaultPrefix)[Symbol.iterator]()
};
//#endregion
//#region src/validate.ts
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/;
const CREDENTIALS_VALUES = [
	"same-origin",
	"include",
	"omit"
];
/**
* Validates that a string is a safe JavaScript identifier.
* Used to prevent code injection when interpolating export names into generated client code.
* @param name - The string to validate
* @param label - Human-readable label for error messages (e.g. "export name")
* @returns The validated name if it passes
* @throws Error if the name contains characters outside /^[A-Za-z_$][A-Za-z0-9_$]*$/
*/
function validateIdentifier(name, label) {
	if (!SAFE_IDENTIFIER.test(name)) throw new Error(INVALID_IDENTIFIER(label, name));
	return name;
}
/**
* Validates that a string is a safe path segment for RPC routing.
* Allows alphanumeric characters, underscores, dollar signs, at signs,
* colons, hyphens, and forward slashes.
* @param segment - The string to validate
* @param label - Human-readable label for error messages (e.g. "rpcPrefix")
* @returns The validated segment if it passes
* @throws Error if the segment contains disallowed characters
*/
function validatePathSegment(segment, label) {
	if (!SAFE_PATH_SEGMENT.test(segment)) throw new Error(INVALID_PATH_SEGMENT(label, segment));
	return segment;
}
/**
* Validates and normalizes the credentials option.
* Accepts "same-origin", "include", or "omit"; defaults to "same-origin" when undefined.
* @param value - Credentials value to validate
* @returns The validated credentials string
* @throws Error if the value is not one of the accepted credentials
*/
function validateCredentials(value) {
	const creds = value || "same-origin";
	if (!CREDENTIALS_VALUES.includes(creds)) throw new Error(`Invalid credentials: "${value}" must be one of ${CREDENTIALS_VALUES.join(", ")}`);
	return creds;
}
/**
* Validates and normalizes the HTTP method option for a server function.
* Accepts "GET" or "POST" (case-insensitive); defaults to "POST" when undefined.
* @param value - Method value to validate
* @returns The validated uppercase method string
* @throws Error if the value is not "GET" or "POST"
*/
function validateMethod(value) {
	const method = (value || "POST").toUpperCase();
	if (method !== "GET" && method !== "POST") throw new Error(`Invalid method: "${value}" must be one of GET, POST`);
	return method;
}
//#endregion
//#region src/getClientModules.ts
/**
* Generates a JavaScript client module string for a single server function.
* All interpolated values are validated to prevent code injection.
* @param fnName - Registered RPC function name (validated as path segment)
* @param fnEntry - Export name used in the generated module (validated as identifier)
* @param options - Content type, credentials, and RPC prefix settings
* @returns A string of JavaScript code exporting the client stub
*/
const getModule = (fnName, fnEntry, options) => {
	const safeFnName = validatePathSegment(fnName, "function name");
	const safeFnEntry = validateIdentifier(fnEntry, "export name");
	const safePrefix = validatePathSegment(options.rpcPrefix, "rpcPrefix");
	const credentials = validateCredentials(options.credentials);
	const method = validateMethod(options.method);
	const contentType = options.contentType ?? "application/json";
	const opts = [];
	if (method !== "POST") opts.push(`method: "${method}"`);
	if (credentials !== "same-origin") opts.push(`credentials: "${credentials}"`);
	if (contentType !== "application/json") opts.push(`contentType: "${contentType}"`);
	return `
 export const ${safeFnEntry} = getClientStub("${safePrefix}", "${safeFnName}"${opts.length ? `, { ${opts.join(", ")} }` : ""});`.trim();
};
/**
* Generates the complete client-side module bundle by iterating all registered server functions
* for a specific prefix and producing fetch-based stubs for each. The result is transformed by Vite
* (or Oxc) during the dev server or production build.
* @param initialOptions - Plugin options containing rpcPrefix and optional adapter
* @returns A string of JavaScript code with all client RPC modules and their import dependencies
*/
const getClientModules = (initialOptions) => {
	validatePathSegment(initialOptions.rpcPrefix, "rpcPrefix");
	const prefixMap = getFunctionsForPrefix(initialOptions.rpcPrefix);
	return `

import { getClientStub } from "@thednp/rpc/helpers";
${Array.from(prefixMap.entries()).filter(([, entry]) => entry.exportName).map(([registeredName, entry]) => getModule(registeredName, entry.exportName, {
		...initialOptions,
		...entry.options || {}
	})).join("\n")}`.trim();
};
//#endregion
//#region src/server-helpers.ts
const GLOB_REGEX = /^.+\.server\.(ts|js|mjs|mts)$/;
/**
* Recursively walks `dir` and collects absolute paths to files whose
* basename matches the `*.server.{ts,js,mjs,mts}` glob pattern.
*/
const walkGlobFiles = async (dir) => {
	const results = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (_e) {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isFile() && GLOB_REGEX.test(entry.name)) results.push(fullPath);
			else if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return results;
};
//#endregion
//#region src/scanForServerFiles.ts
let isScanned = false;
/** Absolute ids (normalized) of the scanned server function files. */
const scannedServerFiles = /* @__PURE__ */ new Set();
const EXACT_NAMES = [
	"server.ts",
	"server.js",
	"server.mjs",
	"server.mts"
];
/**
* Scans `src/api/` (or an explicit `scanRoot`) for server function files
* and populates the server functions map (scoped by rpcPrefix) with their exported functions.
* Uses Vite's SSR module loading to resolve and execute each file.
*
* Supports two matching modes via `config.serverFiles`:
*   `"exact"` — classic `server.ts|js|mjs|mts` names in the api directory
*   `"glob"` — recursively walking `scanRoot` to match `*.server.{ts,js,mjs,mts}`
* @param initialCfg - Optional Vite config overrides (root, base, server, serverFiles, scanRoot)
* @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
*/
const scanForServerFiles = async (initialCfg, devServer) => {
	if (isScanned && !devServer) return;
	const { createServer, normalizePath } = await import("vite");
	const config = !initialCfg && !devServer || !initialCfg ? {
		root: process.cwd(),
		base: process.env.BASE || "/",
		server: { middlewareMode: true }
	} : { ...initialCfg };
	let server = devServer;
	if (!server) server = await createServer({
		server: {
			...config.server,
			ws: false
		},
		appType: "custom",
		base: config.base || "/",
		root: config.root || process.cwd(),
		configFile: false,
		optimizeDeps: { noDiscovery: true },
		ssr: { optimizeDeps: { noDiscovery: true } }
	});
	const root = config.root || process.cwd();
	const resolvedScanRoot = resolve(root, config.scanRoot ?? join(root, "src", "api"));
	const serverFiles = config.serverFiles ?? "exact";
	const seenNames = /* @__PURE__ */ new Set();
	let files;
	try {
		if (serverFiles === "glob") files = await walkGlobFiles(resolvedScanRoot);
		else files = (await readdir(resolvedScanRoot, { withFileTypes: true })).filter((f) => EXACT_NAMES.includes(f.name)).map((f) => join(resolvedScanRoot, f.name));
	} catch (_e) {
		files = [];
	}
	try {
		for (const file of files) {
			scannedServerFiles.add(normalizePath(file));
			let moduleExports;
			try {
				moduleExports = await server.ssrLoadModule(file);
			} catch (error) {
				console.error(ERROR_LOADING_FILE, file, error);
				continue;
			}
			const moduleEntries = Object.entries(moduleExports);
			if (!moduleEntries.length) {
				console.warn(NO_SERVER_FUNCTION_FOUND);
				return;
			}
			for (const [exportName, exportValue] of moduleEntries) {
				const registeredName = exportValue.name;
				const prefix = exportValue.options?.rpcPrefix || config.rpcPrefix || "__rpc";
				const seenKey = `${prefix}:${registeredName}`;
				if (seenNames.has(seenKey)) {
					if (process.env.NODE_ENV !== "production") throw new Error(DUPLICATE_FUNCTION_NAME(registeredName));
					console.warn(DUPLICATE_FUNCTION_NAME(registeredName));
					continue;
				}
				seenNames.add(seenKey);
				const prefixMap = getFunctionsForPrefix(prefix);
				const existing = prefixMap.get(registeredName);
				if (existing) existing.exportName = exportName;
				else prefixMap.set(registeredName, {
					name: registeredName,
					handler: exportValue,
					options: exportValue.options,
					exportName
				});
			}
		}
	} finally {
		if (!devServer && server) await server.close();
		isScanned = true;
	}
};
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
	let options = mergeConfig(defaultRPCOptions, devOptions);
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
			if (serverFunctionsMap.size === 0) {
				const scanCfg = {
					...config,
					serverFiles: options.serverFiles,
					scanRoot: options.scanRoot,
					rpcPrefix: options.rpcPrefix
				};
				await scanForServerFiles(scanCfg, viteServer);
			}
			server.middlewares.use(createRPCMiddleware(rest));
		},
		async buildStart() {
			const viteVersion = this.meta?.viteVersion;
			isOxc = Number(viteVersion[0]) >= 8;
			if (!viteServer && config) {
				const scanCfg = {
					...config,
					serverFiles: options.serverFiles,
					scanRoot: options.scanRoot,
					rpcPrefix: options.rpcPrefix
				};
				await scanForServerFiles(scanCfg);
			}
		},
		async transform(code, id, ops) {
			if (!code.includes("createServerFunction") || ops?.ssr || code.includes("createServerFunction") && typeof process === "undefined") return null;
			const vite = await import("vite");
			if (serverFunctionsMap.size === 0) {
				const scanCfg = {
					...config,
					serverFiles: options.serverFiles,
					scanRoot: options.scanRoot,
					rpcPrefix: options.rpcPrefix
				};
				await scanForServerFiles(scanCfg);
			}
			const idPath = vite.normalizePath(id.split("?")[0]);
			if (!scannedServerFiles.has(idPath)) return null;
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