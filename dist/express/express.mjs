import { escapeRegExp, formatError, hasContentTypeMismatch, provideRequestContext, scanForServerFiles } from "@thednp/rpc/server";
//#region src/options.ts
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
const globalPrefixSymbol = Symbol.for("thednp.rpc.globalPrefix");
/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
const getGlobalPrefix = () => globalThis[globalPrefixSymbol];
const setGlobalPrefix = (prefix) => {
	if (prefix) globalThis[globalPrefixSymbol] = prefix;
	else delete globalThis[globalPrefixSymbol];
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
* If the requested prefix is the globally configured one and its map is empty
* but the default map already holds functions (registered before the global
* was known — e.g. Netlify imports `src/api/server.ts` before
* `createRPCMiddleware({rpcPrefix})`), copy them. This implements the
* fallback chain `options.rpcPrefix → global config → default` without
* requiring `vite` at runtime on serverless.
*/
const ensurePrefixFromGlobal = (prefix) => {
	const global = getGlobalPrefix();
	if (!global || prefix !== global) return;
	const target = getFunctionsForPrefix(prefix);
	if (target.size > 0) return;
	const def = getFunctionsForPrefix(defaultPrefix);
	if (def.size === 0) return;
	for (const [name, entry] of def) if (!target.has(name)) target.set(name, entry);
};
//#endregion
//#region src/constants.ts
const FUNCTION_NOT_FOUND = "Function not found";
const METHOD_NOT_ALLOWED = "Method Not Allowed";
const REQUEST_FORBIDDEN = "Forbidden";
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
const BAD_REQUEST = "Bad Request";
const CLIENT_DISCONNECTED = "client disconnected";
/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
//#endregion
//#region src/server-helpers.ts
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
//#region src/express/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to an Express app.
* Dynamically imports loadRPCConfig and creates the middleware with loaded options.
* @param app - Express application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to an Express app for development mode.
* @param app - Express application instance
* @param vite - Running Vite dev server
*/
function attachVite(app, vite) {
	app.use(vite.middlewares);
}
/**
* Reads and parses the HTTP request body from an Express or Node IncomingMessage.
* If a body parser middleware (e.g. express.json()) already consumed the stream,
* uses the pre-parsed body from `req.body`.
* @param req - Express or Node.js IncomingMessage
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = (req) => {
	return new Promise((resolve, reject) => {
		if (hasPreParsedBody(req) && req.body !== void 0) {
			const contentType = req.headers["content-type"]?.toLowerCase() || "";
			const isJSON = contentType.includes("json");
			const isMultipart = contentType.includes("multipart/form-data");
			const isUrlEncoded = contentType.includes("urlencoded");
			resolve({
				contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
				data: isMultipart ? req.body : isJSON ? req.body : isUrlEncoded ? req.body : String(req.body)
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
			const incomingType = req.headers["content-type"]?.toLowerCase() || "";
			const isJSON = incomingType.includes("json");
			const isMultipart = incomingType.includes("multipart/form-data");
			const isUrlEncoded = incomingType.includes("urlencoded");
			try {
				const data = isMultipart ? { raw: body } : isUrlEncoded ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
				resolve({
					contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
					data: isMultipart ? data : data
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
/**
* Type guard that checks whether a request is an Express Request (has `originalUrl`).
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request is an Express Request
*/
const isExpressRequest = (req) => {
	return "originalUrl" in req;
};
/**
* Type guard that checks whether a response is an Express Response (has `json` and `send` methods).
* @param res - A Node ServerResponse or Express Response
* @returns True if the response is an Express Response
*/
const isExpressResponse = (res) => {
	return "json" in res && "send" in res;
};
/**
* Issues an HTTP redirect on an Express or raw Node ServerResponse.
* Uses Express's native `res.redirect(status, location)` when an Express
* Response is provided, otherwise writes the status code and `Location`
* header directly on the raw `ServerResponse` (safe for Connect-compatible
* middlewares and serverless adapters whose mock responses lack `.redirect`).
* Defaults to `303 See Other` for convention (Post/Redirect/Get).
* @param res - Express Response or raw Node ServerResponse
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
*/
const redirect = (res, location, status = 303) => {
	if (isExpressResponse(res)) {
		res.redirect(status, location);
		return;
	}
	res.statusCode = status;
	res.setHeader("Location", location);
	res.end();
};
/**
* Type guard that checks whether a request has a pre-parsed body (`body` property).
* Used to detect if a body-parser middleware already consumed the stream.
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request has a body property
*/
const hasPreParsedBody = (req) => {
	return "body" in req;
};
/**
* Extracts normalized request details from an Express or Node IncomingMessage.
* Parses the URL to extract pathname, search string, and search params.
* @param request - Express or Node.js request object
* @returns Normalized request details including URL, headers, and method
*/
const getRequestDetails = (request) => {
	const rawUrl = isExpressRequest(request) ? request.originalUrl : request.url;
	const url = safeURL(rawUrl);
	return {
		url: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers: request.headers,
		method: request.method
	};
};
/**
* Wraps an Express or Node ServerResponse with a uniform API for setting headers,
* status codes, and sending JSON responses. Handles the Express vs raw Node API differences.
* @param response - Express or Node.js server response object
* @returns A ResponseDetails object with setHeader, setStatusCode, and sendResponse helpers
*/
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
//#region src/express/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates an Express middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated — reusing a name throws an error.
* Prefix and path regexes are compiled once at creation time (hoisted) for performance.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns An Express middleware function
*/
const createMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const middlewareName = options.name;
	let rpcPrefix = options.rpcPrefix;
	const path = options.path;
	const handler = options.handler;
	let name = middlewareName;
	if (!name) {
		name = "viteRPCMiddleware-" + middlewareCount;
		middlewareCount += 1;
	}
	if (middlewareStack.has(name)) throw new Error(MIDDLEWARE_NAME_USED(name));
	middlewareStack.add(name);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const pathMatcher = path ? typeof path === "string" ? new RegExp(path) : path : null;
	const middlewareHandler = async (req, res, next) => {
		const { url } = getRequestDetails(req);
		if (!handler) return next?.();
		if (pathMatcher && !pathMatcher.test(url)) return next?.();
		if (prefixRegex && !prefixRegex.test(url)) return next?.();
		rpcPrefix = rpcPrefix ?? "__rpc";
		ensurePrefixFromGlobal(rpcPrefix);
		if (getFunctionsForPrefix(rpcPrefix).size === 0) await scanForServerFiles({
			rpcPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
		await handler(req, res, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Express RPC middleware that routes incoming requests to registered server functions.
* Reads the request body, dispatches to the matching function via getFunctionsForPrefix,
* and sends the JSON-serialized result. Handles client disconnection via abort signals.
* Supports multi-prefix setups where different middleware instances can route to functions
* registered under different prefixes.
* @param initialOptions - Options including rpcPrefix for URL routing and prefix-scoped function lookup
* @returns An Express middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = rpcPrefix || "__rpc";
	if (rpcPrefix) setGlobalPrefix(rpcPrefix);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${prefix}/`;
	return createMiddleware({
		...options,
		handler: async (req, res, _next) => {
			const { url: path, searchParams } = getRequestDetails(req);
			const { sendResponse } = getResponseDetails(res);
			if (prefixRegex && !prefixRegex.test(path)) return;
			const origin = options.origin;
			const requestOrigin = req.headers.origin;
			if (origin && requestOrigin && requestOrigin !== origin) {
				sendResponse(403, { error: REQUEST_FORBIDDEN });
				return;
			}
			const functionName = path.replace(prefixReplace, "");
			ensurePrefixFromGlobal(prefix);
			const serverFunction = getFunctionsForPrefix(prefix).get(functionName);
			if (!serverFunction) {
				sendResponse(404, { error: FUNCTION_NOT_FOUND });
				return;
			}
			try {
				const method = serverFunction.options?.method || "POST";
				if (req.method?.toUpperCase() !== method) {
					sendResponse(405, { error: METHOD_NOT_ALLOWED });
					return;
				}
				let args = [];
				if (method === "GET") {
					const raw = searchParams.get("args");
					if (raw) {
						const parsed = JSON.parse(raw);
						if (!Array.isArray(parsed)) {
							sendResponse(400, { error: BAD_REQUEST });
							return;
						}
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", req.headers["content-type"])) {
						sendResponse(415, { error: UNSUPPORTED_MEDIA_TYPE });
						return;
					}
					const body = await readBody(req);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const requestEvent = {
					request: req,
					response: res,
					nativeEvent: {
						req,
						res
					},
					locals: res.locals ?? {},
					functionName,
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
						redirect(res, location, status);
					},
					send: (status, body, headers) => {
						requestEvent.sent = {
							status,
							body,
							headers
						};
						const details = getResponseDetails(res);
						if (headers) for (const [name, value] of Object.entries(headers)) details.setHeader(name, value);
						details.sendResponse(status, body);
					}
				};
				const { data, cancel } = provideRequestContext(requestEvent, () => serverFunction.handler(...args));
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.on("close", onClose);
				const result = await data;
				req.off("close", onClose);
				if (!requestEvent.redirected && !requestEvent.sent && !res.headersSent) sendResponse(200, { data: result });
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				sendResponse(500, formatError(err, isProduction));
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, getRequestDetails, getResponseDetails, hasPreParsedBody, isExpressRequest, isExpressResponse, readBody, redirect };

//# sourceMappingURL=express.mjs.map