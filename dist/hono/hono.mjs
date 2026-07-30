import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
//#region src/options.ts
const defaultRPCOptions = {
	rpcPrefix: "__rpc",
	adapter: "express"
};
const defaultMiddlewareOptions = {
	rpcPrefix: void 0,
	path: void 0
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
const INTERNAL_SERVER_ERROR = "Internal Server Error";
const CLIENT_DISCONNECTED = "client disconnected";
/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
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
	const isJSON = (c.req.header("content-type")?.toLowerCase() || "").includes("json");
	const incoming = c.env.incoming;
	if (incoming?.body !== void 0) {
		const reqBody = incoming.body;
		return {
			contentType: isJSON ? "application/json" : "text/plain",
			data: isJSON ? reqBody : String(reqBody)
		};
	}
	if (isJSON) return {
		contentType: "application/json",
		data: await c.req.json()
	};
	const text = await c.req.text();
	return {
		contentType: "text/plain",
		data: String(text)
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
			const functionName = reqPath.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) return c.json({ error: FUNCTION_NOT_FOUND }, 404);
			try {
				const body = await readBody(c);
				const args = Array.isArray(body.data) ? body.data : [body.data];
				const fnResult = serverFunction.handler(...args);
				const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
				c.env.incoming.on("close", onAbort);
				const result = await fnResult.data;
				c.env.incoming.off("close", onAbort);
				return c.json({ data: result }, 200);
			} catch (err) {
				console.error(String(err));
				return c.json({ error: INTERNAL_SERVER_ERROR }, 500);
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, viteMiddleware };

//# sourceMappingURL=hono.mjs.map