import { createServer } from "vite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
//#region src/functionsMap.ts
const serverFunctionsMap = /* @__PURE__ */ new Map();
//#endregion
//#region src/constants.ts
const OPERATION_ABORTED = "Operation aborted";
const NO_SERVER_FUNCTION_FOUND = "No server function found.";
const ERROR_LOADING_FILE = "Error loading file:";
/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
const INVALID_IDENTIFIER = (label, name) => `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;
/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
const INVALID_PATH_SEGMENT = (label, segment) => `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/`;
//#endregion
//#region src/scanForServerFiles.ts
let isScanned = false;
/**
* Scans `src/api/` for server function files (`server.ts`, `server.js`, `server.mjs`, `server.mts`)
* and populates the global `serverFunctionsMap` with their exported functions.
* Uses Vite's SSR module loading to resolve and execute each file.
* @param initialCfg - Optional Vite config overrides (root, base, server)
* @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
*/
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
		files = (await readdir(apiDir, { withFileTypes: true })).filter((f) => svFiles.includes(f.name)).map((f) => join(apiDir, f.name));
	} catch (_e) {
		files = [];
	}
	try {
		for (const file of files) try {
			const moduleExports = await server.ssrLoadModule(file);
			const moduleEntries = Object.entries(moduleExports);
			if (!moduleEntries.length) {
				console.warn(NO_SERVER_FUNCTION_FOUND);
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
			console.error(ERROR_LOADING_FILE, file, error);
		}
	} finally {
		if (!devServer && server) await server.close();
		isScanned = true;
	}
};
//#endregion
//#region src/options.ts
const defaultServerFnOptions = {
	contentType: "application/json",
	credentials: "same-origin",
	method: "POST"
};
const defaultRPCOptions = {
	rpcPrefix: "__rpc",
	adapter: "express"
};
const defaultMiddlewareOptions = {
	rpcPrefix: void 0,
	path: void 0,
	origin: void 0
};
//#endregion
//#region src/createFunction.ts
/**
* Creates a server-side RPC function.
* Registers the function in the server functions map and returns a client-compatible
* wrapper that exposes `data` (Promise) and `cancel` (function) for request lifecycle control.
* @param name - Unique identifier used by the RPC router to dispatch requests
* @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
* @param fnOptions - Optional contentType and credentials settings
* @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
*/
function createServerFunction(name, handler, fnOptions = {}) {
	const options = Object.assign({}, defaultServerFnOptions, fnOptions);
	const wrappedFunction = (...args) => {
		const controller = new AbortController();
		const cancel = (reason) => controller.abort(reason);
		const fetcher = async () => {
			if (controller.signal.aborted) throw new Error(OPERATION_ABORTED);
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
			configurable: false
		},
		options: {
			value: options,
			enumerable: true,
			configurable: false
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
//#region src/validate.ts
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/;
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
* Allows alphanumeric characters, underscores, dollar signs, hyphens, and forward slashes.
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
	if (method === "GET") {
		body = `JSON.stringify(args)`;
		headers = `{}`;
	}
	return `
export const ${safeFnEntry} = (...args) => {
  const body = ${body};
  const headers = ${headers};
  const prefix = "${safePrefix}";
  const name = "${safeFnName}";
  const credentials = "${credentials}";
  const method = "${method}";
  return innerModule(body, headers, credentials, prefix, name, method);
}`.trim();
};
/**
* Generates the complete client-side module bundle by iterating all registered server functions
* and producing fetch-based stubs for each. The result is transformed by Vite (or Oxc) during
* the dev server or production build.
* @param initialOptions - Plugin options containing rpcPrefix and optional adapter
* @returns A string of JavaScript code with all client RPC modules and their import dependencies
*/
const getClientModules = (initialOptions) => {
	validatePathSegment(initialOptions.rpcPrefix, "rpcPrefix");
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