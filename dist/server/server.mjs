import { createServer } from "vite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
//#region src/functionsMap.ts
const serverFunctionsMap = /* @__PURE__ */ new Map();
//#endregion
//#region src/scanForServerFiles.ts
let isScanned = false;
const scanForServerFiles = async (initialCfg, devServer) => {
	if (isScanned && !devServer) return;
	const config = !initialCfg && !devServer || !initialCfg ? {
		root: process.cwd(),
		base: process.env.BASE || "/",
		server: { middlewareMode: true }
	} : {
		...initialCfg,
		root: process.cwd()
	};
	let server = devServer;
	if (!server) server = await createServer({
		server: config.server,
		appType: "custom",
		base: config.base,
		root: config.root
	});
	const svFiles = [
		"server.ts",
		"server.js",
		"server.mjs",
		"server.mts"
	];
	const apiDir = join(config.root, "src", "api");
	let files;
	try {
		files = (await readdir(apiDir, { withFileTypes: true })).filter((f) => svFiles.some((fn) => f.name.includes(fn))).map((f) => join(apiDir, f.name));
	} catch (_e) {
		files = [];
	}
	try {
		for (const file of files) try {
			const moduleExports = await server.ssrLoadModule(file);
			const moduleEntries = Object.entries(moduleExports);
			if (!moduleEntries.length) {
				console.warn("No server function found.");
				return;
			}
			for (const [exportName, exportValue] of moduleEntries) {
				const registeredName = exportValue.name;
				serverFunctionsMap.set(registeredName, {
					name: registeredName,
					handler: exportValue,
					options: exportValue?.options,
					exportName
				});
			}
		} catch (error) {
			console.error("Error loading file:", file, error);
		}
	} finally {
		if (!devServer && server) await server.close();
		isScanned = true;
	}
};
//#endregion
//#region src/options.ts
const defaultServerFnOptions = { contentType: "application/json" };
const defaultRPCOptions = {
	rpcPreffix: "__rpc",
	adapter: "express"
};
const defaultMiddlewareOptions = {
	rpcPreffix: void 0,
	path: void 0
};
//#endregion
//#region src/createFunction.ts
function createServerFunction(name, handler, fnOptions = {}) {
	const options = Object.assign({}, defaultServerFnOptions, fnOptions);
	const wrappedFunction = (...args) => {
		const controller = new AbortController();
		const cancel = (reason) => controller.abort(reason);
		const fetcher = async () => {
			if (controller.signal.aborted) throw new Error("Operation aborted");
			return await handler(controller.signal, ...args);
		};
		return {
			data: fetcher(),
			cancel
		};
	};
	Object.defineProperties(wrappedFunction, {
		name: {
			value: name,
			enumerable: true,
			configurable: true
		},
		options: {
			value: options,
			enumerable: true,
			configurable: true
		}
	});
	serverFunctionsMap.set(name, {
		name,
		handler: wrappedFunction,
		options
	});
	return wrappedFunction;
}
//#endregion
//#region src/getClientModules.ts
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/;
function validateIdentifier(name, label) {
	if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`);
	return name;
}
function validatePathSegment(segment, label) {
	if (!SAFE_PATH_SEGMENT.test(segment)) throw new Error(`Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/`);
	return segment;
}
const getModule = (fnName, fnEntry, options) => {
	const safeFnName = validatePathSegment(fnName, "function name");
	const safeFnEntry = validateIdentifier(fnEntry, "export name");
	const safePrefix = validatePathSegment(options.rpcPreffix, "rpcPreffix");
	let body = "";
	let headers = "{}";
	switch (options.contentType) {
		case "text/plain":
			body = `args[0]`;
			headers = `{ 'Content-Type': 'text/plain' }`;
			break;
		default:
			body = `JSON.stringify(args)`;
			headers = `{ 'Content-Type': 'application/json' }`;
	}
	return `
export const ${safeFnEntry} = (...args) => {
  const body = ${body};
  const headers = ${headers};
  const preffix = "${safePrefix}";
  const name = "${safeFnName}";
  return innerModule(body, headers, preffix, name);
}`.trim();
};
const getClientModules = (initialOptions) => {
	validatePathSegment(initialOptions.rpcPreffix, "rpcPreffix");
	return `

import { innerModule } from "@thednp/rpc/helpers";
${Array.from(serverFunctionsMap.entries()).filter(([, entry]) => entry.exportName).map(([registeredName, entry]) => getModule(registeredName, entry.exportName, {
		...initialOptions,
		...entry.options || {}
	})).join("\n")}
`.trim();
};
//#endregion
export { createServerFunction, defaultMiddlewareOptions, defaultRPCOptions, defaultServerFnOptions, getClientModules, scanForServerFiles, serverFunctionsMap };

//# sourceMappingURL=server.mjs.map