import fp from "fastify-plugin";
import { escapeRegExp, formatError, hasContentTypeMismatch, provideRequestContext, scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
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
//#region src/constants.ts
const FUNCTION_NOT_FOUND = "Function not found";
const METHOD_NOT_ALLOWED = "Method Not Allowed";
const REQUEST_FORBIDDEN = "Forbidden";
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
const CLIENT_DISCONNECTED = "client disconnected";
/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
//#endregion
//#region src/fastify/helpers.ts
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
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
						redirect(reply, location, status);
					}
				};
				const { data: dataResult, cancel } = provideRequestContext(requestEvent, () => serverFunction.handler(...args));
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.raw.on("close", onClose);
				const data = await dataResult;
				req.raw.off("close", onClose);
				if (!requestEvent.redirected && !reply.raw.headersSent) reply.status(200).send({ data });
			} catch (err) {
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				reply.status(500).send(formatError(err, isProduction));
			}
		}
	});
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
export { rpcPlugin as default };

//# sourceMappingURL=plugin.mjs.map