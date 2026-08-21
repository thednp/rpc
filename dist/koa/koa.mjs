import { escapeRegExp, formatError, hasContentTypeMismatch, provideRequestContext, safeURL, scanForServerFiles } from "@thednp/rpc/server";
const defaultRPCOptions = {
	rpcPrefix: "__rpc",
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
//#region src/koa/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to a Koa app.
* Dynamically imports loadRPCConfig and registers the middleware.
* @param app - Koa application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to a Koa app for development mode.
* Bridges Koa's context-based middleware to Vite's Connect-compatible middleware stack
* by forwarding Koa body, wrapping res.end, and delegating back to Koa on 404 or unhandled routes.
* @param app - Koa application instance
* @param vite - Running Vite dev server
*/
function attachVite(app, vite) {
	app.use(async (ctx, next) => {
		const req = ctx.req;
		const res = ctx.res;
		const requestBody = ctx.request?.body;
		if (requestBody !== void 0) Object.assign(req, { body: requestBody });
		const originalEnd = res.end.bind(res);
		let viteHandled = false;
		res.end = function(...args) {
			viteHandled = true;
			return originalEnd(args[0]);
		};
		await new Promise((resolve) => {
			vite.middlewares(req, res, () => resolve(void 0));
		});
		res.end = originalEnd;
		if (!viteHandled || res.statusCode === 404) await next();
	});
}
/**
* Reads and parses the HTTP request body from a Koa context.
* If koa-body or another body parser already consumed the stream,
* uses the pre-parsed body from `ctx.request.body`.
* @param ctx - Koa context
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = (ctx) => {
	const contentType = ctx.request.headers["content-type"]?.toLowerCase() || "";
	return new Promise((resolve, reject) => {
		const isJSON = contentType.includes("json");
		const isMultipart = contentType.includes("multipart/form-data");
		const isUrlEncoded = contentType.includes("urlencoded");
		const reqBody = ctx.request.body;
		if (reqBody !== void 0) {
			resolve({
				contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
				data: isMultipart ? reqBody : isJSON ? reqBody : isUrlEncoded ? reqBody : String(reqBody)
			});
			return;
		}
		let body = "";
		const toggleListeners = (add) => {
			const method = add ? "on" : "off";
			ctx.req[method]("data", onData);
			ctx.req[method]("end", onEnd);
			ctx.req[method]("error", onError);
		};
		const onData = (chunk) => {
			body += chunk.toString();
		};
		const onEnd = () => {
			toggleListeners();
			const isJSON = contentType.includes("json");
			const isMultipart = contentType.includes("multipart/form-data");
			const isUrlEncoded = contentType.includes("urlencoded");
			try {
				const data = isMultipart ? { raw: body } : isUrlEncoded ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
				resolve({
					contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
					data: isMultipart ? data : data
				});
			} catch (_er) {
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
* Issues an HTTP redirect on a Koa context. Koa's `ctx.redirect(location)`
* defaults to `302` and sets the `Location` header; the status code must be
* overridden *after* the call (setting it before is ignored, see
* koajs/koa#857). Defaults to `303 See Other` for convention
* (Post/Redirect/Get).
* @param ctx - Koa context
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
*/
const redirect = (ctx, location, status = 303) => {
	ctx.redirect(location);
	ctx.status = status;
};
//#endregion
//#region src/koa/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates a Koa middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
* Koa URL is normalized via `new URL()` to strip query strings before matching.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns A Koa middleware function
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
	const middlewareHandler = async (ctx, next) => {
		const url = safeURL(ctx.url).pathname;
		if (!handler) return next();
		if (pathMatcher && !pathMatcher.test(url)) return next();
		if (prefixRegex && !prefixRegex.test(url)) return next();
		rpcPrefix = rpcPrefix ?? "__rpc";
		if (getFunctionsForPrefix(rpcPrefix).size === 0) await scanForServerFiles({
			rpcPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
		await handler(ctx, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Koa RPC middleware that routes incoming requests to registered server functions.
* Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
* to the matching function, and sets the JSON-serialized result on ctx.body.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns A Koa middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = rpcPrefix || "__rpc";
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${prefix}/`;
	return createMiddleware({
		...options,
		handler: async (ctx, _next) => {
			const reqUrl = safeURL(ctx.url);
			const url = reqUrl.pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const origin = options.origin;
			const requestOrigin = ctx.headers.origin;
			if (origin && requestOrigin && requestOrigin !== origin) {
				ctx.status = 403;
				ctx.body = { error: REQUEST_FORBIDDEN };
				return;
			}
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = getFunctionsForPrefix(prefix).get(functionName);
			if (!serverFunction) {
				ctx.status = 404;
				ctx.body = { error: FUNCTION_NOT_FOUND };
				return;
			}
			try {
				const method = serverFunction.options?.method || "POST";
				if (ctx.method.toUpperCase() !== method) {
					ctx.status = 405;
					ctx.body = { error: METHOD_NOT_ALLOWED };
					return;
				}
				let args = [];
				if (method === "GET") {
					const raw = reqUrl.searchParams.get("args");
					if (raw) {
						const parsed = JSON.parse(raw);
						if (!Array.isArray(parsed)) {
							ctx.status = 400;
							ctx.body = { error: BAD_REQUEST };
							return;
						}
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", ctx.headers["content-type"])) {
						ctx.status = 415;
						ctx.body = { error: UNSUPPORTED_MEDIA_TYPE };
						return;
					}
					const body = await readBody(ctx);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const requestEvent = {
					request: ctx.req,
					response: ctx,
					nativeEvent: ctx,
					locals: ctx.state,
					functionName,
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
						redirect(ctx, location, status);
					},
					send: (status, body, headers) => {
						requestEvent.sent = {
							status,
							body,
							headers
						};
						if (headers) for (const [name, value] of Object.entries(headers)) ctx.set(name, value);
						ctx.status = status;
						ctx.body = body;
					}
				};
				const { data: resultData, cancel } = provideRequestContext(requestEvent, () => serverFunction.handler(...args));
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				ctx.req.on("close", onClose);
				const result = await resultData;
				ctx.req.off("close", onClose);
				if (!requestEvent.redirected && !requestEvent.sent) {
					ctx.status = 200;
					ctx.body = { data: result };
				}
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				ctx.status = 500;
				ctx.body = formatError(err, isProduction);
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect };

//# sourceMappingURL=koa.mjs.map