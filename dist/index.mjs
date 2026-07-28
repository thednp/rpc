import { loadConfigFromFile, mergeConfig } from "vite";
import { resolve } from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { getClientModules, scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
//#region src/options.ts
const defaultRPCOptions = {
	rpcPreffix: "__rpc",
	adapter: "express"
};
const defaultMiddlewareOptions = {
	rpcPreffix: void 0,
	path: void 0
};
//#endregion
//#region src/express/helpers.ts
const readBody = (req) => {
	return new Promise((resolve, reject) => {
		if (hasPreParsedBody(req) && req.body !== void 0) {
			const isJSON = (req.headers["content-type"]?.toLowerCase() || "").includes("json");
			resolve({
				contentType: isJSON ? "application/json" : "text/plain",
				data: isJSON ? req.body : String(req.body)
			});
			return;
		}
		let body = "";
		const toggleListeners = (add) => {
			const method = add ? "on" : "off";
			req[method]("data", onData);
			req[method]("end", onEnd);
			req[method]("error", onError);
		};
		const onData = (chunk) => {
			body += chunk.toString();
		};
		const onEnd = () => {
			toggleListeners();
			const isJSON = (req.headers["content-type"]?.toLowerCase() || "").includes("json");
			try {
				const data = JSON.parse(body);
				resolve({
					contentType: isJSON ? "application/json" : "text/plain",
					data
				});
			} catch (_e) {
				resolve({
					contentType: "text/plain",
					data: String(body)
				});
			}
		};
		const onError = (err) => {
			toggleListeners();
			reject(err);
		};
		toggleListeners(true);
	});
};
const isExpressRequest = (req) => {
	return "originalUrl" in req;
};
const isExpressResponse = (res) => {
	return "json" in res && "send" in res;
};
const hasPreParsedBody = (req) => {
	return "body" in req;
};
const getRequestDetails = (request) => {
	const rawUrl = isExpressRequest(request) ? request.originalUrl : request.url;
	const url = new URL(rawUrl, "http://localhost");
	return {
		url: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers: request.headers,
		method: request.method
	};
};
const getResponseDetails = (response) => {
	const isResponseSent = response.headersSent || response.writableEnded;
	const setHeader = (name, value) => {
		if (isExpressResponse(response)) response.header(name, value);
		else response.setHeader(name, value);
	};
	const setStatusCode = (code) => {
		if (isExpressResponse(response)) response.status(code);
		else response.statusCode = code;
	};
	const sendResponse = (code, output) => {
		setStatusCode(code);
		setHeader("Content-Type", "application/json");
		if (isExpressResponse(response)) response.send(JSON.stringify(output));
		else response.end(JSON.stringify(output));
	};
	return {
		isResponseSent,
		setHeader,
		statusCode: response.statusCode,
		setStatusCode,
		sendResponse
	};
};
//#endregion
//#region src/tools.ts
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/express/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
const createMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const middlewareName = options.name;
	const rpcPreffix = options.rpcPreffix;
	const path = options.path;
	const handler = options.handler;
	let name = middlewareName;
	if (!name) {
		name = "viteRPCMiddleware-" + middlewareCount;
		middlewareCount += 1;
	}
	if (middlewareStack.has(name)) throw new Error(`The middleware name "${name}" is already used.`);
	middlewareStack.add(name);
	const prefixRegex = rpcPreffix ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`) : null;
	const pathMatcher = path ? typeof path === "string" ? new RegExp(path) : path : null;
	const middlewareHandler = async (req, _res, next) => {
		const { url } = getRequestDetails(req);
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) return next?.();
		if (pathMatcher && !pathMatcher.test(url)) return next?.();
		if (prefixRegex && !prefixRegex.test(url)) return next?.();
		await handler(req, _res, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPreffix: defaultRPCOptions.rpcPreffix }, initialOptions);
	const rpcPreffix = options.rpcPreffix;
	const prefixRegex = rpcPreffix ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`) : null;
	const prefixReplace = `/${rpcPreffix}/`;
	return createMiddleware({
		...options,
		handler: async (req, res, _next) => {
			const { url } = getRequestDetails(req);
			const { sendResponse } = getResponseDetails(res);
			if (prefixRegex && !prefixRegex.test(url)) return;
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) {
				sendResponse(404, { error: "Function not found" });
				return;
			}
			try {
				const body = await readBody(req);
				const args = Array.isArray(body.data) ? body.data : [body.data];
				const { data, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel("client disconnected");
				req.on("close", onClose);
				const result = await data;
				req.off("close", onClose);
				if (!res.headersSent) sendResponse(200, { data: result });
			} catch (err) {
				console.error(String(err));
				sendResponse(500, { error: "Internal Server Error" });
			}
		}
	});
};
//#endregion
//#region src/index.ts
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
* Utility to define `@thednp/rpc` configuration file similar to vite.
* @param uniConfig a system wide RPC configuration
*/
const defineConfig = (uniConfig) => {
	return mergeConfig(defaultRPCOptions, uniConfig);
};
let RPCConfig;
/**
* Utility to load `@thednp/rpc` configuration file system wide.
* @param configFile an optional parameter to specify a file within your project scope
*/
async function loadRPCConfig(configFile) {
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
				console.warn(`  ⚠︎ The specified RPC config file ${configFile} cannot be found at ${configFilePath}, loading the defaults..`);
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
		console.warn(` ⚡︎ No RPC config found, loading the defaults..`);
	} catch (error) {
		RPCConfig = defaultRPCOptions;
		console.warn(` ⚠︎ Failed to load RPC config:`, error);
	}
	return RPCConfig;
}
function rpcPlugin(devOptions = {}) {
	let options;
	let config;
	let viteServer;
	let isOxc = true;
	return {
		name: "vite-plugin-universal-rpc",
		enforce: "pre",
		async configResolved(resolvedConfig) {
			options = mergeConfig(await loadRPCConfig(), devOptions);
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
				rpcPreffix: options.rpcPreffix,
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