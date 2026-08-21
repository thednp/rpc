import { escapeRegExp, formatError, hasContentTypeMismatch, provideRequestContext, safeURL, scanForServerFiles } from "@thednp/rpc/server";
import fp from "fastify-plugin";
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
			const isUrlEncoded = contentType.includes("urlencoded");
			resolve({
				contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
				data: isMultipart ? reqBody : isJSON ? reqBody : isUrlEncoded ? reqBody : String(reqBody)
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
			const isUrlEncoded = contentType.includes("urlencoded");
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
* Issues an HTTP redirect on a Fastify reply using the native
* `reply.redirect(location, status)` API (Fastify v5 signature: destination
* URL first, status code optional). Defaults to `303 See Other` for
* convention (Post/Redirect/Get).
* @param reply - Fastify reply object
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
*/
const redirect = (reply, location, status = 303) => {
	reply.redirect(location, status);
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
	const middlewareHandler = async (req, reply, done) => {
		const url = safeURL(req.url).pathname;
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
		rpcPrefix = rpcPrefix ?? "__rpc";
		ensurePrefixFromGlobal(rpcPrefix);
		if (getFunctionsForPrefix(rpcPrefix).size === 0) await scanForServerFiles({
			rpcPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
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
	const prefix = rpcPrefix || "__rpc";
	if (rpcPrefix) setGlobalPrefix(rpcPrefix);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${prefix}/`;
	return createMiddleware({
		...options,
		handler: async (req, reply, _done) => {
			const reqUrl = safeURL(req.url);
			const url = reqUrl.pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const origin = options.origin;
			const requestOrigin = req.headers.origin;
			if (origin && requestOrigin && requestOrigin !== origin) {
				reply.status(403).send({ error: REQUEST_FORBIDDEN });
				return;
			}
			const functionName = url.replace(prefixReplace, "");
			ensurePrefixFromGlobal(prefix);
			const serverFunction = getFunctionsForPrefix(prefix).get(functionName);
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
					if (raw) {
						const parsed = JSON.parse(raw);
						if (!Array.isArray(parsed)) {
							reply.status(400).send({ error: BAD_REQUEST });
							return;
						}
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", req.headers["content-type"])) {
						reply.status(415).send({ error: UNSUPPORTED_MEDIA_TYPE });
						return;
					}
					const body = await readBody(req);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const requestEvent = {
					request: req,
					response: reply,
					nativeEvent: req,
					locals: {},
					functionName,
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
						redirect(reply, location, status);
					},
					send: (status, body, headers) => {
						requestEvent.sent = {
							status,
							body,
							headers
						};
						if (headers) for (const [name, value] of Object.entries(headers)) reply.header(name, value);
						reply.status(status).send(body);
					}
				};
				const { data: dataResult, cancel } = provideRequestContext(requestEvent, () => serverFunction.handler(...args));
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.raw.on("close", onClose);
				const data = await dataResult;
				req.raw.off("close", onClose);
				if (!requestEvent.redirected && !requestEvent.sent && !reply.raw.headersSent) reply.status(200).send({ data });
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				reply.status(500).send(formatError(err, isProduction));
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect };

//# sourceMappingURL=fastify.mjs.map