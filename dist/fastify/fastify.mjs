import { clientErrorMessage, clientErrorStatus, escapeRegExp, formatError, hasContentTypeMismatch, isClientHttpError, isOriginRequestAllowed, provideRequestContext, resolveRPCPrefix, safeURL, scanForServerFiles } from "@thednp/rpc/server";
import fp from "fastify-plugin";
//#region src/options.ts
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
//#endregion
//#region src/constants.ts
/** Body of a 404. Deliberately does not name the requested function. */
const FUNCTION_NOT_FOUND = "Function not found";
/** Body of a 405, returned when the HTTP method does not match the function's declared method. */
const METHOD_NOT_ALLOWED = "Method Not Allowed";
/** Body of a 403, returned when the optional origin allowlist rejects the request. */
const REQUEST_FORBIDDEN = "Forbidden";
/** Body of a 415, returned when the request's `Content-Type` does not satisfy the function's declared `contentType`. */
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
const BAD_REQUEST = "Bad Request";
/** Abort reason used when the client disconnects mid-dispatch. */
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
//#region src/server-helpers.ts
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
//#endregion
//#region src/fastify/helpers.ts
/**
* Convenience function to load RPC config and register the RPC plugin to a Fastify instance.
* Dynamically imports loadRPCConfig and registers the fastify-rpc plugin.
* @param app - Fastify instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const options = await loadRPCConfig();
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
* Creates a Fastify `onRequest` hook handler that delegates to Vite's
* connect-compatible middleware stack. Use with `app.addHook("onRequest", ...)`.
*
* @example
* ```ts
* import Fastify from "fastify";
* import { createServer } from "vite";
* import { viteMiddleware } from "@thednp/rpc/fastify";
*
* const app = Fastify();
* const vite = await createServer({ server: { middlewareMode: true } });
* app.addHook("onRequest", viteMiddleware(vite));
* ```
* @param vite - Running Vite dev server
* @returns A Fastify `onRequest` hook handler
*/
function viteMiddleware(vite) {
	return async (request, reply) => {
		reply.hijack();
		await new Promise((resolve, reject) => {
			const next = (err) => err ? reject(err) : resolve();
			vite.middlewares(request.raw, reply.raw, next);
		});
	};
}
/**
* Reads and parses the HTTP request body from a Fastify request.
* If Fastify's body parser already consumed the stream, uses the pre-parsed body from `req.body`.
* @param req - Fastify request object
* @returns A promise resolving to the parsed body with its content type
*/
/**
* Parses a body leniently: JSON when it parses, otherwise the raw string.
* Used for bodies that did not declare JSON — notably a request with no
* `Content-Type` header, which must still arrive parsed if it carries JSON.
* @param body - The raw body text
* @returns The parsed JSON value, or the original string
*/
const parseJsonOrRawText = (body) => {
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
};
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
				const data = isMultipart ? { raw: body } : isUrlEncoded ? Object.fromEntries(new URLSearchParams(body)) : isJSON ? JSON.parse(body) : parseJsonOrRawText(body);
				resolve({
					contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
					data: isMultipart ? data : data
				});
			} catch (_e) {
				reject(httpError(400, "Invalid JSON body"));
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
	const resolvedPrefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(resolvedPrefix)}/`) : null;
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
		if (getFunctionsForPrefix(resolvedPrefix).size === 0) await scanForServerFiles({
			rpcPrefix: resolvedPrefix,
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
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
	const prefixReplace = `/${prefix}/`;
	return createMiddleware({
		...options,
		rpcPrefix: prefix,
		handler: async (req, reply, _done) => {
			const reqUrl = safeURL(req.url);
			const url = reqUrl.pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			if (!isOriginRequestAllowed(options.origin, req.headers.origin, req.headers["sec-fetch-site"])) {
				reply.status(403).send({ error: REQUEST_FORBIDDEN });
				return;
			}
			const functionName = url.replace(prefixReplace, "");
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
						let parsed;
						try {
							parsed = JSON.parse(raw);
						} catch {
							reply.status(400).send({ error: BAD_REQUEST });
							return;
						}
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
				if (isClientHttpError(err)) {
					const status = clientErrorStatus(err);
					reply.status(status).send({ error: clientErrorMessage(status) });
					return;
				}
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				reply.status(500).send(formatError(err, isProduction));
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect, viteMiddleware };

//# sourceMappingURL=fastify.mjs.map