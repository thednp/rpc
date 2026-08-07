import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
//#region src/tools.ts
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
//#endregion
//#region src/constants.ts
const FUNCTION_NOT_FOUND = "Function not found";
const METHOD_NOT_ALLOWED = "Method Not Allowed";
const REQUEST_FORBIDDEN = "Forbidden";
const INTERNAL_SERVER_ERROR = "Internal Server Error";
const CLIENT_DISCONNECTED = "client disconnected";
/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
//#endregion
//#region src/server-helpers.ts
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
//#endregion
//#region src/options.ts
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
		const reqBody = ctx.request.body;
		if (reqBody !== void 0) {
			resolve({
				contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : "text/plain",
				data: isMultipart ? reqBody : isJSON ? reqBody : String(reqBody)
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
			try {
				const data = isMultipart ? { raw: body } : JSON.parse(body);
				resolve({
					contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : "text/plain",
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
	const rpcPrefix = options.rpcPrefix;
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
		const url = new URL(ctx.url, "http://localhost").pathname;
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) return next();
		if (pathMatcher && !pathMatcher.test(url)) return next();
		if (prefixRegex && !prefixRegex.test(url)) return next();
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
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${rpcPrefix}/`;
	return createMiddleware({
		...options,
		handler: async (ctx, _next) => {
			const reqUrl = new URL(ctx.url, "http://localhost");
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
			const serverFunction = serverFunctionsMap.get(functionName);
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
					if (raw) args = JSON.parse(raw);
				} else {
					const body = await readBody(ctx);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const { data: resultData, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				ctx.req.on("close", onClose);
				const result = await resultData;
				ctx.req.off("close", onClose);
				ctx.status = 200;
				ctx.body = { data: result };
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
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };

//# sourceMappingURL=koa.mjs.map