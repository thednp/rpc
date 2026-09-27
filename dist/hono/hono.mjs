import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { clientErrorMessage, clientErrorStatus, escapeRegExp, formatError, hasContentTypeMismatch, isClientHttpError, isOriginRequestAllowed, provideRequestContext, resolveRPCPrefix, safeURL, scanForServerFiles } from "@thednp/rpc/server";
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
/**
* Recognises an error that should produce a `4xx` response rather than a `500`.
*
* Matches the `status` / `statusCode` convention used by h3's `HTTPError`, the
* `http-errors` objects Express's `body-parser` throws, and anything else that
* carries a numeric 4xx. Shared by all five adapters so a host-framework
* signal and an rpc-raised one are handled by the same rule.
* @param err - The caught error
* @returns True when the error denotes a client (4xx) fault
*/
const readClientStatus = (err) => {
	const candidate = err;
	const status = candidate?.status ?? candidate?.statusCode;
	return typeof status === "number" && status >= 400 && status < 500 ? status : void 0;
};
/**
* Recognises an error that should produce a `4xx` response rather than a `500`.
* Matches the `status` / `statusCode` convention used by h3's `HTTPError`, the
* `http-errors` objects Express's `body-parser` throws, and anything else
* carrying a numeric 4xx. Shared by all five adapters so a host-framework
* signal and an rpc-raised one are handled by the same rule.
* @param err - The caught error
* @returns True when the error denotes a client (4xx) fault
*/
const isClientHttpError$1 = (err) => readClientStatus(err) !== void 0;
//#endregion
//#region src/hono/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to a Hono app.
* Dynamically imports loadRPCConfig and registers the middleware.
* @param app - Hono application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const options = await loadRPCConfig();
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
				if (!c.env) {
					resolve(next());
					return;
				}
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
	const isUrlEncoded = contentType.includes("urlencoded");
	const incoming = c.env?.incoming;
	if (incoming?.body !== void 0) {
		const reqBody = incoming.body;
		return {
			contentType: isMultipart ? "multipart/form-data" : isJSON ? "application/json" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
			data: isMultipart ? reqBody : isJSON ? reqBody : isUrlEncoded ? reqBody : String(reqBody)
		};
	}
	if (isJSON) try {
		return {
			contentType: "application/json",
			data: await c.req.json()
		};
	} catch (err) {
		throw isClientHttpError$1(err) ? err : httpError(400, "Invalid JSON body");
	}
	const text = await c.req.text();
	return {
		contentType: isMultipart ? "multipart/form-data" : isUrlEncoded ? "application/x-www-form-urlencoded" : "text/plain",
		data: isMultipart ? { raw: text } : isUrlEncoded ? Object.fromEntries(new URLSearchParams(text)) : String(text)
	};
};
/**
* Issues an HTTP redirect on a Hono context. Hono's `c.redirect(location,
* status)` returns a `Response` object that the handler must return (it never
* writes directly). Defaults to `303 See Other` for convention
* (Post/Redirect/Get).
* @param c - Hono context
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
* @returns A Hono `Response` to return from the handler
*/
const redirect = (c, location, status = 303) => {
	return c.redirect(location, status);
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
	const resolvedPrefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(resolvedPrefix)}/`) : null;
	const pathMatcher = path ? typeof path === "string" ? new RegExp(path) : path : null;
	const middlewareHandler = createMiddleware$1(async (c, next) => {
		const url = safeURL(c.req.path).pathname;
		if (!handler) return next();
		if (pathMatcher && !pathMatcher.test(url)) return next();
		if (prefixRegex && !prefixRegex.test(url)) return next();
		if (getFunctionsForPrefix(resolvedPrefix).size === 0) await scanForServerFiles({
			rpcPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
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
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
	const prefixReplace = `/${prefix}/`;
	return createMiddleware({
		...options,
		rpcPrefix: prefix,
		handler: async (c, _next) => {
			const { path: reqPath } = c.req;
			if (prefixRegex && !prefixRegex.test(reqPath)) return;
			if (!isOriginRequestAllowed(options.origin, c.req.header("origin"), c.req.header("sec-fetch-site"))) return c.json({ error: REQUEST_FORBIDDEN }, 403);
			const functionName = reqPath.replace(prefixReplace, "");
			const serverFunction = getFunctionsForPrefix(prefix).get(functionName);
			if (!serverFunction) return c.json({ error: FUNCTION_NOT_FOUND }, 404);
			try {
				const method = serverFunction.options?.method || "POST";
				if (c.req.method.toUpperCase() !== method) return c.json({ error: METHOD_NOT_ALLOWED }, 405);
				let args = [];
				if (method === "GET") {
					const raw = c.req.query("args");
					if (raw) {
						let parsed;
						try {
							parsed = JSON.parse(raw);
						} catch {
							return c.json({ error: BAD_REQUEST }, 400);
						}
						if (!Array.isArray(parsed)) return c.json({ error: BAD_REQUEST }, 400);
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", c.req.header("content-type"))) return c.json({ error: UNSUPPORTED_MEDIA_TYPE }, 415);
					const body = await readBody(c);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				const requestEvent = {
					request: c.req,
					response: c.res,
					nativeEvent: c,
					locals: {},
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
				const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
				c.env?.incoming?.on("close", onAbort);
				const result = await fnResult.data;
				c.env?.incoming?.off("close", onAbort);
				if (requestEvent.redirected) return c.redirect(requestEvent.redirected.location, requestEvent.redirected.status);
				if (requestEvent.sent) {
					const { status, body, headers } = requestEvent.sent;
					return c.body(JSON.stringify(body), status, {
						"content-type": "application/json",
						...headers
					});
				}
				return c.json({ data: result }, 200);
			} catch (err) {
				if (isClientHttpError(err)) {
					const status = clientErrorStatus(err);
					return c.json({ error: clientErrorMessage(status) }, status);
				}
				console.error(String(err));
				const isProduction = process.env.NODE_ENV === "production";
				return c.json(formatError(err, isProduction), 500);
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect, viteMiddleware };

//# sourceMappingURL=hono.mjs.map