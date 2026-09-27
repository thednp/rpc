import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/options.ts
/**
* Defaults applied to a server function that declares no `method`,
* `credentials`, or `contentType` of its own.
*/
const defaultServerFnOptions = {
	contentType: "application/json",
	credentials: "same-origin",
	method: "POST"
};
/**
* The built-in RPC endpoint prefix, used when neither an explicit prefix nor a
* global one (`getGlobalPrefix`) is supplied. Kept for backward compatibility
* with pre-multi-prefix setups, where every function lived under this one map.
*/
const defaultPrefix = "__rpc";
/**
* Baseline plugin options. `defineConfig` merges a user's partial config over
* these, and `loadRPCConfig` merges a loaded config file over them, so every
* option has a defined value even when a config file omits it.
*/
const defaultRPCOptions = {
	rpcPrefix: defaultPrefix,
	serverFiles: "exact",
	scanRoot: void 0
};
/**
* Baseline middleware options. Note `rpcPrefix` is `undefined` rather than
* `defaultPrefix` on purpose: leaving it unset lets `resolveRPCPrefix` fall
* through to the global prefix, which is what makes a published global prefix
* reach the middleware.
*/
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
/**
* @module User-facing message strings.
*
* Two shapes live here: plain message constants (the exact text an RPC
* response body carries) and message *factories* for the cases that need a
* value interpolated. Both are part of the wire contract for the bodies below,
* so the casing is deliberate — e.g. a client matching on
* `METHOD_NOT_ALLOWED` must see `"Method Not Allowed"`, not `"Method not
* allowed"`. These strings are also what keeps error responses generic: they
* never include the requested function name, so a response cannot be used to
* enumerate what exists.
*/
/** Thrown-name for an operation stopped by its own `cancel()`. */
const OPERATION_ABORTED = "Operation aborted";
/** Warning logged when a scanned server module exports nothing. */
const NO_SERVER_FUNCTION_FOUND = "No server function found.";
/** Error logged when a server function file cannot be loaded by Vite's SSR loader. */
const ERROR_LOADING_FILE = "Error loading file:";
/** Body of a 415, returned when the request's `Content-Type` does not satisfy the function's declared `contentType`. */
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
/** Body of a 413, returned when the request body exceeds the host's configured size limit. */
const PAYLOAD_TOO_LARGE = "Payload Too Large";
/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
const BAD_REQUEST = "Bad Request";
/** Body of a 500. Always generic — never the underlying error, so internals cannot leak. */
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
* Tags an error with an HTTP status for the dispatch to surface.
*
* Used where a malformed *request* is the fault — a body that does not parse
* under a declared JSON `Content-Type`, a GET `?args=` value that is not valid
* JSON. Every host framework rpc supports answers `400` for these (Express
* `entity.parse.failed`, Fastify `FST_ERR_CTP_INVALID_JSON_BODY`, koa-bodyparser,
* and h3's own `readBody`), and treating one as a server fault both misreports
* the fault and turns a trivial client mistake into a log entry.
* @param status - The HTTP status to answer with
* @param message - Internal diagnostic message; never sent to the client
* @returns An `Error` carrying `status`
*/
const httpError = (status, message) => {
	const err = new Error(message);
	err.status = status;
	return err;
};
/**
* Recognises an error that should produce a `4xx` response rather than a `500`.
*
* Matches the `status` / `statusCode` convention used by h3's `HTTPError`, the
* `http-errors` objects Express's `body-parser` throws, and anything else that
* carries a numeric 4xx. Shared by all five adapters so a host-framework
* signal and an rpc-raised one are handled by the same rule.
* @param err - The caught error
* @returns True when the error denotes a client (4xx) fault
*/
const readClientStatus = (err) => {
	const candidate = err;
	const status = candidate?.status ?? candidate?.statusCode;
	return typeof status === "number" && status >= 400 && status < 500 ? status : void 0;
};
/**
* Recognises an error that should produce a `4xx` response rather than a `500`.
* Matches the `status` / `statusCode` convention used by h3's `HTTPError`, the
* `http-errors` objects Express's `body-parser` throws, and anything else
* carrying a numeric 4xx. Shared by all five adapters so a host-framework
* signal and an rpc-raised one are handled by the same rule.
* @param err - The caught error
* @returns True when the error denotes a client (4xx) fault
*/
const isClientHttpError = (err) => readClientStatus(err) !== void 0;
/**
* Reads the status to answer for a client error. Defaults to `400` rather than
* `500` so an unrecognised 4xx is never reported as a server fault.
* @param err - The caught error
* @returns The 4xx status to answer with
*/
const clientErrorStatus = (err) => readClientStatus(err) ?? 400;
const clientErrorMessage = (status) => {
	if (status === 413) return PAYLOAD_TOO_LARGE;
	if (status === 415) return UNSUPPORTED_MEDIA_TYPE;
	return BAD_REQUEST;
};
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
* Decides whether a request may proceed, given the configured origin allowlist
* and the two headers a browser can be made to reveal.
*
* Four tiers, evaluated in order — the first tier with a signal decides:
*
* 1. `origin` option unset → everything passes. No validation is performed.
* 2. `Origin` present → the allowlist decides, exactly as {@link isOriginAllowed}.
* 3. `Origin` absent but `Sec-Fetch-Site` present → allow only `same-origin`
*    and `none`; anything else (including an unrecognised value) is rejected.
* 4. Both absent → passes. This is the deliberate, documented curl/native hole.
*
* Tier 2 must short-circuit ahead of tier 3. `Sec-Fetch-Site` is a coarse
* four-value enum that cannot name a host, so on its own it would reject a
* legitimate request from an allowlisted sibling subdomain (`same-site`). The
* allowlist exists precisely to admit that case, and it can only do so while
* `Origin` survives. `Sec-Fetch-Site` earns a vote only once the precise signal
* has been stripped away by something in the chain — at which point there is
* nothing left to trust, so it fails closed.
*
* Browsers never strip `Origin` themselves, so tier 3 can only fire when a
* proxy, sanitising middleware, or misconfigured CDN removed it. No legitimate
* browser request can regress.
*
* An empty (or whitespace-only) header value counts as **absent**, not as an
* unrecognised signal. No browser emits an empty `Sec-Fetch-Site`, and adapters
* disagree on what their header accessor returns for a missing header (Node's
* `req.headers` yields `undefined`, Hono's `c.req.header()` may yield `""`).
* Normalising here keeps all five adapters behaving identically instead of
* inheriting whichever convention their framework happens to use.
* @param allowed - The configured `origin` option, if any
* @param origin - The raw `Origin` request header, if present
* @param site - The raw `Sec-Fetch-Site` request header, if present
* @returns `true` when the request may proceed
*/
const isOriginRequestAllowed = (allowed, origin, site) => {
	if (!allowed) return true;
	if (origin?.trim()) return isOriginAllowed(allowed, origin);
	if (!site?.trim()) return true;
	return site === "same-origin" || site === "none";
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
/**
* Decides whether a request's `Origin` header is allowed by the configured
* allowlist. Shared by all five adapters so the rule lives in exactly one place.
*
* - No `allowed` value (option unset) → everything passes: no validation.
* - No `requestOrigin` header → passes, preserving curl/native-client access.
* - Otherwise the header must match one of the entries exactly.
*
* A single string and a one-element array behave identically, so widening
* `origin` to `string | string[]` is backward compatible.
*
* `Origin: null` (sandboxed iframes, `file://`, extension pages) is rejected
* whenever an allowlist is set, because it never equals a real origin.
* @param allowed - The configured `origin` option, if any
* @param requestOrigin - The raw `Origin` request header, if present
* @returns `true` when the request may proceed
*/
const isOriginAllowed = (allowed, requestOrigin) => {
	if (!allowed || !requestOrigin) return true;
	return Array.isArray(allowed) ? allowed.includes(requestOrigin) : requestOrigin === allowed;
};
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
const globalPrefixSymbol = Symbol.for("thednp.rpc.globalPrefix");
/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
const getGlobalPrefix = () => globalThis[globalPrefixSymbol];
/**
* Publishes the global RPC prefix, consulted by `resolveRPCPrefix` whenever no
* explicit prefix is supplied. `loadRPCConfig` calls this on every return path
* so a loaded config is the fallback for later registrations and dispatches.
*
* Stored on a `Symbol.for` key on `globalThis` so it stays instance-stable
* across the bundled entry copies (`server.mjs`, `express.mjs`, ...) and dev
* server hot reloads — the same technique as the request-context storage.
* @param prefix - The prefix to publish, or `undefined` to clear it
*/
const setGlobalPrefix = (prefix) => {
	if (prefix) globalThis[globalPrefixSymbol] = prefix;
	else delete globalThis[globalPrefixSymbol];
};
/**
* Resolves the effective RPC prefix: the explicit one when given, otherwise
* the global prefix set by `setGlobalPrefix` / `loadRPCConfig`, otherwise the
* built-in default.
*
* Every adapter resolves its prefix through this single function — in both the
* outer `createMiddleware` gate and the `createRPCMiddleware` dispatch — so the
* two halves of a request can never disagree, and so a prefix registered by
* `createServerFunction` (which resolves the same way) is always the prefix the
* middleware looks up. Resolving the two sides independently is what allowed
* h3 to drift from the other four adapters, and what left the documented
* global-prefix flow returning 404 on all of them.
* @param rpcPrefix - Explicit prefix from config or middleware options
* @returns The prefix to gate on, look up in, and strip from the request path
*/
const resolveRPCPrefix = (rpcPrefix) => rpcPrefix || getGlobalPrefix() || "__rpc";
//#endregion
//#region src/scanForServerFiles.ts
/**
* Scan targets already performed, so a lazy re-scan is not repeated.
*
* Keyed by everything that determines the outcome — the resolved scan root
* (which files are read), the matching mode, and the prefix prefix-less
* functions register under. A single process-wide boolean used to be enough
* only while there was one prefix: the *first* scan suppressed every later
* one, so a second RPC instance on a different prefix asked for a lazy scan,
* got an early return, and answered 404 for every function it owned.
*/
const scannedTargets = /* @__PURE__ */ new Set();
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
	const root = initialCfg?.root || process.cwd();
	const resolvedScanRoot = resolve(root, initialCfg?.scanRoot ?? join(root, "src", "api"));
	const serverFiles = initialCfg?.serverFiles ?? "exact";
	const target = `${resolvedScanRoot}|${serverFiles}|${initialCfg?.rpcPrefix ?? "__rpc"}`;
	if (scannedTargets.has(target) && !devServer) return;
	let createServer;
	let normalizePath;
	try {
		({createServer, normalizePath} = await import("vite"));
	} catch {
		return;
	}
	const config = !initialCfg ? {
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
				continue;
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
		scannedTargets.add(target);
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
	const rpcPrefix = fnOptions.rpcPrefix || getGlobalPrefix() || "__rpc";
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
*
* The generated stubs are plain `fetch` calls, so they are adapter-agnostic —
* only the prefix is needed.
* @param initialOptions - Plugin options containing the rpcPrefix
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
	const headers = toHeaderRecord(req?.headers ?? req?.raw?.headers);
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
export { RPCError, clientErrorMessage, clientErrorStatus, createServerFunction, defaultMiddlewareOptions, defaultPrefix, defaultRPCOptions, defaultServerFnOptions, escapeRegExp, formatError, getClientModules, getFunctionsForPrefix, getGlobalPrefix, getRequestContext, getRequestMeta, hasContentTypeMismatch, httpError, isClientHttpError, isFormContentType, isOriginAllowed, isOriginRequestAllowed, provideRequestContext, redirect, resolveRPCPrefix, safeURL, scanForServerFiles, scannedServerFiles, sendResponse, serverFunctionsByPrefix, serverFunctionsMap, setGlobalPrefix, walkGlobFiles };

//# sourceMappingURL=server.mjs.map