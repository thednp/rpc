import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
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
* Formats an error for the RCP middleware response.
* In development the full message and stack are included so developers
* can quickly identify issues. In production only the generic
* "Internal Server Error" is sent, preventing information disclosure.
*/
const formatError = (err, isProduction) => {
	if (!isProduction) {
		if (err instanceof RPCError) {
			const payload = {
				error: err.message || "Internal Server Error",
				code: err.code
			};
			if (err.data !== void 0) payload.data = err.data;
			return payload;
		}
		return { error: (err instanceof Error ? err.message : String(err)) || "Internal Server Error" };
	}
	return { error: INTERNAL_SERVER_ERROR };
};
//#endregion
//#region src/hono/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to a Hono app.
* Dynamically imports loadRPCConfig and registers the middleware.
* @param app - Hono application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to a Hono app for development mode.
* Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into Hono.
* @param app - Hono application instance
* @param vite - Running Vite dev server
*/
const attachVite = (app, vite) => {
	app.use(viteMiddleware(vite));
};
/**
* Creates a Hono-compatible middleware from a Vite dev server middleware stack.
* Bridges the Connect/Express middleware interface to Hono's context-based request/response model.
* Supports both Node.js and Bun runtimes with separate polyfill paths.
* @param vite - Running Vite dev server
* @returns A Hono middleware function
* @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
*/
const viteMiddleware = (vite) => {
	return createMiddleware$1((c, next) => {
		return new Promise((resolve) => {
			if (typeof Bun === "undefined") {
				vite.middlewares(c.env.incoming, c.env.outgoing, () => resolve(next()));
				return;
			}
			{
				let sent = false;
				const headers = new Headers();
				vite.middlewares({
					url: new URL(c.req.path, "http://localhost").pathname,
					method: c.req.raw.method,
					headers: Object.fromEntries(c.req.raw.headers)
				}, {
					setHeader(name, value) {
						headers.set(name, value);
						return this;
					},
					end(body) {
						sent = true;
						resolve(c.body(body, c.res.status, headers));
					}
				}, () => sent || resolve(next()));
			}
		});
	});
};
/**
* Reads and parses the HTTP request body from a Hono context.
* Supports JSON and text content types, with pre-parsed body detection for server-side environments.
* @param c - Hono request context
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = async (c) => {
	const contentType = c.req.header("content-type")?.toLowerCase() || "";
	const isJSON = contentType.includes("json");
	const isMultipart = contentType.includes("multipart/form-data");
	const incoming = c.env.incoming;
	if (incoming?.body !== void 0) {
		const reqBody = incoming.body;
		return {
			contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : "text/plain",
			data: isMultipart ? reqBody : isJSON ? reqBody : String(reqBody)
		};
	}
	if (isJSON) return {
		contentType: "application/json",
		data: await c.req.json()
	};
	const text = await c.req.text();
	return {
		contentType: isMultipart ? "multipart/form-data" : "text/plain",
		data: isMultipart ? { raw: text } : String(text)
	};
};
//#endregion
//#region src/hono/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates a Hono middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
* Uses Hono's factory `createMiddleware` to wrap the handler.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns A Hono middleware function
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
	const middlewareHandler = createMiddleware$1(async (c, next) => {
		const url = new URL(c.req.path, "http://localhost").pathname;
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) {
			await next();
			return;
		}
		if (pathMatcher && !pathMatcher.test(url)) {
			await next();
			return;
		}
		if (prefixRegex && !prefixRegex.test(url)) {
			await next();
			return;
		}
		return await handler(c, next);
	});
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Hono RPC middleware that routes incoming requests to registered server functions.
* Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
* to the matching function, and returns the JSON-serialized result.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns A Hono middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${rpcPrefix}/`;
	return createMiddleware({
		...options,
		handler: async (c, _next) => {
			const { path: reqPath } = c.req;
			if (prefixRegex && !prefixRegex.test(reqPath)) return;
			const origin = options.origin;
			const requestOrigin = c.req.header("origin");
			if (origin && requestOrigin && requestOrigin !== origin) return c.json({ error: REQUEST_FORBIDDEN }, 403);
			const functionName = reqPath.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) return c.json({ error: FUNCTION_NOT_FOUND }, 404);
			try {
				const method = serverFunction.options?.method || "POST";
				if (c.req.method.toUpperCase() !== method) return c.json({ error: METHOD_NOT_ALLOWED }, 405);
				let args = [];
				if (method === "GET") {
					const raw = c.req.query("args");
					if (raw) args = JSON.parse(raw);
				} else {
					const body = await readBody(c);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const fnResult = serverFunction.handler(...args);
				const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
				c.env.incoming?.on("close", onAbort);
				const result = await fnResult.data;
				c.env.incoming?.off("close", onAbort);
				return c.json({ data: result }, 200);
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				return c.json(formatError(err, isProduction), 500);
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, viteMiddleware };

//# sourceMappingURL=hono.mjs.map