import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import fp from "fastify-plugin";
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
//#region src/fastify/plugin.ts
/** @module Fastify plugin. Exports the RPC plugin wrapped with `fastify-plugin` for lifecycle-compatible registration. */
const RpcPlugin = (fastify, initialOptions, done) => {
	const rpcMiddleware = createRPCMiddleware(initialOptions);
	fastify.addHook("preHandler", async (request, reply) => {
		const next = () => new Promise((resolve) => {
			rpcMiddleware(request, reply, resolve);
		});
		await next();
	});
	done();
};
const rpcPlugin = fp(RpcPlugin, { name: "uni-rpc-fastify-plugin" });
//#endregion
//#region src/fastify/helpers.ts
/**
* Convenience function to load RPC config and register the RPC plugin to a Fastify instance.
* Dynamically imports loadRPCConfig and registers the fastify-rpc plugin.
* @param app - Fastify instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	await app.register(rpcPlugin, options);
}
/**
* Attaches Vite's dev server middlewares to a Fastify instance for development mode.
* Uses an `onRequest` hook to delegate to Vite's connect-compatible middleware stack.
* @param app - Fastify instance
* @param vite - Running Vite dev server
*/
function attachVite(app, vite) {
	app.addHook("onRequest", async (request, reply) => {
		const next = () => new Promise((resolve) => {
			vite.middlewares(request.raw, reply.raw, resolve);
		});
		await next();
	});
}
/**
* Reads and parses the HTTP request body from a Fastify request.
* If Fastify's body parser already consumed the stream, uses the pre-parsed body from `req.body`.
* @param req - Fastify request object
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = (req) => {
	return new Promise((resolve, reject) => {
		const contentType = req.headers["content-type"]?.toLowerCase() || "";
		const reqBody = req.body;
		if (reqBody !== void 0) {
			const isJSON = contentType.includes("json");
			const isMultipart = contentType.includes("multipart/form-data");
			resolve({
				contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : "text/plain",
				data: isMultipart ? reqBody : isJSON ? reqBody : String(reqBody)
			});
			return;
		}
		const toggleListeners = (add) => {
			const method = add ? "on" : "off";
			req.raw[method]("data", onData);
			req.raw[method]("end", onEnd);
			req.raw[method]("error", onError);
		};
		let body = "";
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
//#endregion
//#region src/fastify/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates a Fastify preHandler hook with optional path and rpcPrefix filtering.
* Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns A Fastify preHandler hook function
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
	const middlewareHandler = async (req, reply, done) => {
		const url = new URL(req.url, "http://localhost").pathname;
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) {
			done();
			return;
		}
		if (pathMatcher && !pathMatcher.test(url)) {
			done();
			return;
		}
		if (prefixRegex && !prefixRegex.test(url)) {
			done();
			return;
		}
		await handler(req, reply, done);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Fastify RPC middleware that routes incoming requests to registered server functions.
* Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
* to the matching function, and sends the JSON-serialized result.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns A Fastify preHandler hook function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${rpcPrefix}/`;
	return createMiddleware({
		...options,
		handler: async (req, reply, _done) => {
			const reqUrl = new URL(req.url, "http://localhost");
			const url = reqUrl.pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const origin = options.origin;
			const requestOrigin = req.headers.origin;
			if (origin && requestOrigin && requestOrigin !== origin) {
				reply.status(403).send({ error: REQUEST_FORBIDDEN });
				return;
			}
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) {
				reply.status(404).send({ error: FUNCTION_NOT_FOUND });
				return;
			}
			try {
				const method = serverFunction.options?.method || "POST";
				if (req.method.toUpperCase() !== method) {
					reply.status(405).send({ error: METHOD_NOT_ALLOWED });
					return;
				}
				let args = [];
				if (method === "GET") {
					const raw = reqUrl.searchParams.get("args");
					if (raw) args = JSON.parse(raw);
				} else {
					const body = await readBody(req);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const { data: dataResult, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.raw.on("close", onClose);
				const data = await dataResult;
				req.raw.off("close", onClose);
				if (!reply.raw.headersSent) reply.status(200).send({ data });
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				reply.status(500).send(formatError(err, isProduction));
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };

//# sourceMappingURL=fastify.mjs.map