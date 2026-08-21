import { escapeRegExp, formatError, hasContentTypeMismatch, provideRequestContext, scanForServerFiles } from "@thednp/rpc/server";
import { HTTPResponse, redirect as redirect$1 } from "h3";
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
//#region src/h3/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to an h3 app.
* Dynamically imports loadRPCConfig and registers the middleware.
* @param app - h3 application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to an h3 app for development mode.
* Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into h3.
* @param app - h3 application instance
* @param vite - Running Vite dev server
*/
const attachVite = (app, vite) => {
	app.use(viteMiddleware(vite));
};
/**
* Creates an h3-compatible middleware from a Vite dev server middleware stack.
* Bridges the Connect/Express middleware interface to h3's event-based request/response model.
* Supports both Node.js and web runtimes with separate polyfill paths.
* @param vite - Running Vite dev server
* @returns An h3 middleware function
*/
const viteMiddleware = (vite) => {
	return (event, next) => new Promise((resolve) => {
		const node = event.runtime?.node;
		if (node?.req && node?.res) {
			const nodeReq = node.req;
			const nodeRes = node.res;
			let settled = false;
			const settle = (value) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			nodeRes.once("close", () => settle(new Response(null)));
			nodeRes.once("finish", () => settle(new Response(null)));
			vite.middlewares(nodeReq, nodeRes, () => {
				if (nodeRes.writableEnded || nodeRes.headersSent) settle(new Response(null));
				else settle(next());
			});
			return;
		}
		let sent = false;
		const headers = new Headers();
		const req = {
			url: event.url.pathname + event.url.search,
			method: event.req.method,
			headers: Object.fromEntries(event.req.headers)
		};
		vite.middlewares(req, {
			setHeader(name, value) {
				headers.set(name, String(value));
				return this;
			},
			writeHead(status) {
				return this;
			},
			end(body) {
				sent = true;
				resolve(new HTTPResponse(body == null ? "" : body, { headers }));
				return this;
			}
		}, () => {
			if (!sent) resolve(next());
		});
	});
};
/**
* Reads and parses the HTTP request body from an h3 event.
* Supports JSON, text, urlencoded, and multipart content types.
* @param event - h3 event object
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = async (event) => {
	const contentType = event.req.headers.get("content-type")?.toLowerCase() || "";
	const isJSON = contentType.includes("json");
	const isMultipart = contentType.includes("multipart/form-data");
	const isUrlEncoded = contentType.includes("urlencoded");
	const text = await event.req.text();
	if (isJSON) return {
		contentType: "application/json",
		data: JSON.parse(text)
	};
	return {
		contentType: isMultipart ? "multipart/form-data" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
		data: isMultipart ? { raw: text } : isUrlEncoded ? Object.fromEntries(new URLSearchParams(text)) : String(text)
	};
};
/**
* Issues an HTTP redirect. h3's `redirect()` returns an `HTTPResponse`
* object that the handler must return (it never writes directly). Defaults
* to `303 See Other` for convention (Post/Redirect/Get).
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
* @returns An h3 `HTTPResponse` to return from the handler
*/
const redirect = (location, status = 303) => {
	return redirect$1(location, status, status === 303 ? "See Other" : void 0);
};
//#endregion
//#region src/h3/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates an h3 middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
* h3 URL is normalized via `event.url` (query strings are not part of the pathname).
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns An h3 middleware function
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
	const middlewareHandler = async (event, next) => {
		const url = event.url.pathname;
		if (!handler) return next();
		if (pathMatcher && !pathMatcher.test(url)) return next();
		if (prefixRegex && !prefixRegex.test(url)) return next();
		rpcPrefix = rpcPrefix ?? "__rpc";
		ensurePrefixFromGlobal(rpcPrefix);
		if (getFunctionsForPrefix(rpcPrefix).size === 0) await scanForServerFiles({
			rpcPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
		return handler(event, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the h3 RPC middleware that routes incoming requests to registered server functions.
* Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
* to the matching function, and returns the JSON-serialized result.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns An h3 middleware function
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
		handler: async (event, _next) => {
			const url = event.url.pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const origin = options.origin;
			const requestOrigin = event.req.headers.get("origin") ?? void 0;
			if (origin && requestOrigin && requestOrigin !== origin) {
				event.res.status = 403;
				return { error: REQUEST_FORBIDDEN };
			}
			const functionName = url.replace(prefixReplace, "");
			ensurePrefixFromGlobal(prefix);
			const serverFunction = getFunctionsForPrefix(prefix).get(functionName);
			if (!serverFunction) {
				event.res.status = 404;
				return { error: FUNCTION_NOT_FOUND };
			}
			try {
				const method = serverFunction.options?.method || "POST";
				if (event.req.method.toUpperCase() !== method) {
					event.res.status = 405;
					return { error: METHOD_NOT_ALLOWED };
				}
				let args = [];
				if (method === "GET") {
					const raw = event.url.searchParams.get("args");
					if (raw) {
						const parsed = JSON.parse(raw);
						if (!Array.isArray(parsed)) {
							event.res.status = 400;
							return { error: BAD_REQUEST };
						}
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", event.req.headers.get("content-type") ?? void 0)) {
						event.res.status = 415;
						return { error: UNSUPPORTED_MEDIA_TYPE };
					}
					const body = await readBody(event);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const requestEvent = {
					request: event.req,
					response: event.res,
					nativeEvent: event,
					locals: event.context,
					functionName,
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
					},
					send: (status, body, headers) => {
						requestEvent.sent = {
							status,
							body,
							headers
						};
					}
				};
				const fnResult = provideRequestContext(requestEvent, () => serverFunction.handler(...args));
				const onClose = () => fnResult.cancel(CLIENT_DISCONNECTED);
				const nodeReq = event.runtime?.node?.req;
				if (nodeReq) nodeReq.on("close", onClose);
				const result = await fnResult.data;
				if (nodeReq) nodeReq.off("close", onClose);
				if (requestEvent.redirected) return redirect(requestEvent.redirected.location, requestEvent.redirected.status);
				if (requestEvent.sent) {
					const { status, body, headers } = requestEvent.sent;
					event.res.status = status;
					if (headers) for (const [name, value] of Object.entries(headers)) event.res.headers.set(name, value);
					return body;
				}
				return { data: result };
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				event.res.status = 500;
				return formatError(err, isProduction);
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect, viteMiddleware };

//# sourceMappingURL=h3.mjs.map