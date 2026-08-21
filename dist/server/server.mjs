import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/options.ts
const defaultServerFnOptions = {
	contentType: "application/json",
	credentials: "same-origin",
	method: "POST"
};
const defaultPrefix = "__rpc";
const defaultRPCOptions = {
	rpcPrefix: defaultPrefix,
	adapter: "express",
	serverFiles: "exact",
	scanRoot: void 0
};
const defaultMiddlewareOptions = {
	rpcPrefix: void 0,
	path: void 0,
	origin: void 0
};
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
//#region src/constants.ts
const OPERATION_ABORTED = "Operation aborted";
const NO_SERVER_FUNCTION_FOUND = "No server function found.";
const ERROR_LOADING_FILE = "Error loading file:";
const INTERNAL_SERVER_ERROR = "Internal Server Error";
/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
const INVALID_IDENTIFIER = (label, name) => `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;
/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
const INVALID_PATH_SEGMENT = (label, segment) => `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/`;
/** Error template for duplicate server function names across files. @param name - The duplicate registered name */
const DUPLICATE_FUNCTION_NAME = (name) => `Duplicate server function "${name}" detected. Each server function must have a unique name. Remove or rename the duplicate.`;
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
/**
* A typed error thrown from server functions.
* The middleware serializes the `message` and `code` in the response,
* allowing clients to recognise and handle specific error conditions.
*/
var RPCError = class extends Error {
	/** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
	code;
	/** Optional diagnostic payload */
	data;
	constructor(message, code = "INTERNAL", data) {
		super(message);
		this.name = "RPCError";
		this.code = code;
		this.data = data;
	}
};
/**
* Formats an error for the RPC middleware response.
* In development the full `RPCError` payload is included so developers
* can quickly identify issues. Unexpected exceptions never expose their
* message — only the generic "Internal Server Error" is sent, preventing
* information disclosure; server-side diagnostics are preserved via the
* middleware's `console.error` logging.
*/
const formatError = (err, isProduction) => {
	if (isProduction) return { error: INTERNAL_SERVER_ERROR };
	if (err instanceof RPCError) {
		const payload = {
			error: err.message || "Internal Server Error",
			code: err.code
		};
		if (err.data !== void 0) payload.data = err.data;
		return payload;
	}
	return { error: INTERNAL_SERVER_ERROR };
};
/**
* Checks whether a content type maps to a form encoding
* (`multipart/form-data` or `application/x-www-form-urlencoded`).
* Form-declared functions accept either encoding so native browser
* submissions (urlencoded) keep working without JavaScript.
*/
const isFormContentType = (contentType) => contentType === "multipart/form-data" || contentType === "application/x-www-form-urlencoded";
/**
* Detects whether an incoming request's `Content-Type` header conflicts
* with the function's declared content type. JSON and text functions are
* enforced strictly (exact match wins), while form functions accept both
* form encodings because the nojs fallback submits urlencoded forms to
* multipart-declared endpoints. Requests without a `Content-Type` header
* (curl, GET, legacy clients) are exempt from enforcement.
* @param declared - The declared `contentType` from the server function options
* @param rawHeader - The raw `Content-Type` request header, if present
*/
const hasContentTypeMismatch = (declared, rawHeader) => {
	if (!rawHeader) return false;
	const incomingType = rawHeader.trim().toLowerCase().split(";")[0].trim();
	if (isFormContentType(declared)) return !isFormContentType(incomingType);
	return incomingType !== declared;
};
/**
* Escapes special regex metacharacters in a string.
* Used to safely embed user-configurable values (like rpcPrefix) into regular expressions,
* preventing ReDoS and regex injection attacks.
* @param s - The raw string to escape
* @returns The escaped string safe for use in new RegExp()
*/
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const SAFE_URL_BASE = "http://localhost";
/**
* Parses a raw request URL against a fixed base without ever throwing.
* Malformed request-targets (e.g. `/\`, `//`, `/\/`) make the WHATWG URL
* parser throw `TypeError: Invalid URL`; the adapters call this while
* building the per-request URL **before** their dispatch `try` block, so an
* unhandled rejection there crashes raw `node:http` hosts (and Express 4).
* On failure we fall back to the base root: the resulting pathname never
* matches the RPC prefix, so the request is treated as non-RPC and falls
* through to `next()` / 404 instead of crashing the process.
* @param rawUrl - Raw request URL (path + optional query string)
* @param base - Optional base URL, defaults to a fixed localhost origin
* @returns A URL object; never throws
*/
const safeURL = (rawUrl, base = SAFE_URL_BASE) => {
	try {
		return new URL(rawUrl, base);
	} catch {
		return new URL("/", base);
	}
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
//#region src/createFunction.ts
/**
* Creates a server-side RPC function.
* Registers the function in the server functions map (scoped by rpcPrefix) and returns
* a client-compatible wrapper that exposes `data` (Promise) and `cancel` (function)
* for request lifecycle control.
* @param name - Unique identifier used by the RPC router to dispatch requests
* @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
* @param fnOptions - Optional contentType, credentials, and rpcPrefix settings
* @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
*/
function createServerFunction(name, handler, fnOptions = {}) {
	const options = Object.assign({}, defaultServerFnOptions, fnOptions);
	const rpcPrefix = fnOptions.rpcPrefix || "__rpc";
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
	getFunctionsForPrefix(rpcPrefix).set(name, {
		name,
		handler: wrappedFunction,
		options
	});
	return wrappedFunction;
}
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
//#region src/context.ts
/** @module Server-side request context. Exports the `RequestEvent` shape, `provideRequestContext` to establish it around a dispatch, `getRequestContext` to read it from anywhere inside the async tree, `redirect` and `sendResponse` for framework-level short-circuits, and `getRequestMeta` for normalized request access. Never import this module in client code — it is server-only. */
/**
* Global symbol under which the shared `AsyncLocalStorage` instance is stored
* on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
* across module copies and dev-server hot reloads, mirroring
* `solid-js/web`'s own request-context storage.
*/
const requestContextSymbol = Symbol.for("thednp.rpc.requestContext");
const requestContextStorage = globalThis[requestContextSymbol] ??= new AsyncLocalStorage();
/**
* Runs `cb` with `init` as the current request context. Use inside the
* adapters around server-function dispatch (the async tree under `cb` can then
* read the context via {@link getRequestContext}).
* @param init - The request context for the duration of `cb`
* @param cb - The work that needs access to the request context
*/
const provideRequestContext = (init, cb) => requestContextStorage.run(init, cb);
/**
* Returns the current request context, or throws when called outside of a
* request (e.g. module scope or a background task).
* @throws When no request context is established
*/
const getRequestContext = () => {
	const ctx = requestContextStorage.getStore();
	if (!ctx) throw new Error("RequestEvent is not available outside of a request");
	return ctx;
};
/**
* Redirects the current request to `location`. Reads the adapter-bound
* `redirect` from the current request context — callable from anywhere inside
* a server-function tree (no `res` threading needed).
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to `303 See Other`
* @throws When called outside of a request
*/
const redirect = (location, status = 303) => {
	getRequestContext().redirect(location, status);
};
/**
* Sends a raw JSON response for the current request, bypassing the standard
* `{ data }` shape. Reads the adapter-bound `send` from the current request
* context — callable from anywhere inside a server-function tree. Any code in
* the async tree of a dispatch can call this (e.g. custom middleware) to
* short-circuit with a specific status code (401, 413, 429, ...).
* @param status - HTTP status code
* @param body - JSON-serializable response body
* @param headers - Optional response headers
* @throws When called outside of a request
*/
const sendResponse = (status, body, headers) => {
	getRequestContext().send(status, body, headers);
};
const pickHeader = (headers, name) => {
	const value = headers[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0];
};
/** Normalizes any headers shape into a plain lower-cased record. */
const toHeaderRecord = (headers) => {
	if (!headers) return {};
	if (typeof headers.forEach === "function") {
		const record = {};
		headers.forEach((value, key) => {
			record[key] = value;
		});
		return record;
	}
	return headers;
};
/**
* Reads normalized, adapter-agnostic request metadata from the current request
* context. Works with Express `req`, Fastify `req`, Koa `ctx.req`,
* Hono `c.req` and h3 `event.req` by feature-detecting the request shape
* (`originalUrl`/`url`/`path`, raw `headers` map vs `Headers`-like API).
* @param event - The request context to read, typically the result of
*   {@link getRequestContext}
*/
const getRequestMeta = (event) => {
	const req = event.request;
	const method = (req?.method ?? "GET").toUpperCase();
	const rawUrl = req?.originalUrl ?? req?.url ?? req?.path ?? "";
	const url = safeURL(rawUrl);
	const headers = toHeaderRecord(req?.headers);
	const hostHeader = pickHeader(headers, "host");
	return {
		method,
		pathname: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers,
		host: hostHeader,
		ip: req?.ip ?? req?.socket?.remoteAddress,
		protocol: req?.protocol ?? url.protocol.replace(":", "")
	};
};
//#endregion
export { RPCError, createServerFunction, defaultMiddlewareOptions, defaultPrefix, defaultRPCOptions, defaultServerFnOptions, escapeRegExp, formatError, getClientModules, getFunctionsForPrefix, getRequestContext, getRequestMeta, hasContentTypeMismatch, isFormContentType, provideRequestContext, redirect, safeURL, scanForServerFiles, scannedServerFiles, sendResponse, serverFunctionsByPrefix, serverFunctionsMap, walkGlobFiles };

//# sourceMappingURL=server.mjs.map