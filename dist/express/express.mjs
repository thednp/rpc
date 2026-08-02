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
//#region src/express/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to an Express app.
* Dynamically imports loadRPCConfig and creates the middleware with loaded options.
* @param app - Express application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to an Express app for development mode.
* @param app - Express application instance
* @param vite - Running Vite dev server
*/
function attachVite(app, vite) {
	app.use(vite.middlewares);
}
/**
* Reads and parses the HTTP request body from an Express or Node IncomingMessage.
* If a body parser middleware (e.g. express.json()) already consumed the stream,
* uses the pre-parsed body from `req.body`.
* @param req - Express or Node.js IncomingMessage
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = (req) => {
	return new Promise((resolve, reject) => {
		if (hasPreParsedBody(req) && req.body !== void 0) {
			const isJSON = (req.headers["content-type"]?.toLowerCase() || "").includes("json");
			resolve({
				contentType: isJSON ? "application/json" : "text/plain",
				data: isJSON ? req.body : String(req.body)
			});
			return;
		}
		let body = "";
		const toggleListeners = (add) => {
			const method = add ? "on" : "off";
			req[method]("data", onData);
			req[method]("end", onEnd);
			req[method]("error", onError);
		};
		const onData = (chunk) => {
			body += chunk.toString();
		};
		const onEnd = () => {
			toggleListeners();
			const isJSON = (req.headers["content-type"]?.toLowerCase() || "").includes("json");
			try {
				const data = JSON.parse(body);
				resolve({
					contentType: isJSON ? "application/json" : "text/plain",
					data
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
* Type guard that checks whether a request is an Express Request (has `originalUrl`).
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request is an Express Request
*/
const isExpressRequest = (req) => {
	return "originalUrl" in req;
};
/**
* Type guard that checks whether a response is an Express Response (has `json` and `send` methods).
* @param res - A Node ServerResponse or Express Response
* @returns True if the response is an Express Response
*/
const isExpressResponse = (res) => {
	return "json" in res && "send" in res;
};
/**
* Type guard that checks whether a request has a pre-parsed body (`body` property).
* Used to detect if a body-parser middleware already consumed the stream.
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request has a body property
*/
const hasPreParsedBody = (req) => {
	return "body" in req;
};
/**
* Extracts normalized request details from an Express or Node IncomingMessage.
* Parses the URL to extract pathname, search string, and search params.
* @param request - Express or Node.js request object
* @returns Normalized request details including URL, headers, and method
*/
const getRequestDetails = (request) => {
	const rawUrl = isExpressRequest(request) ? request.originalUrl : request.url;
	const url = new URL(rawUrl, "http://localhost");
	return {
		url: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers: request.headers,
		method: request.method
	};
};
/**
* Wraps an Express or Node ServerResponse with a uniform API for setting headers,
* status codes, and sending JSON responses. Handles the Express vs raw Node API differences.
* @param response - Express or Node.js server response object
* @returns A ResponseDetails object with setHeader, setStatusCode, and sendResponse helpers
*/
const getResponseDetails = (response) => {
	const isResponseSent = response.headersSent || response.writableEnded;
	const setHeader = (name, value) => {
		if (isExpressResponse(response)) response.header(name, value);
		else response.setHeader(name, value);
	};
	const setStatusCode = (code) => {
		if (isExpressResponse(response)) response.status(code);
		else response.statusCode = code;
	};
	const sendResponse = (code, output) => {
		setStatusCode(code);
		setHeader("Content-Type", "application/json");
		if (isExpressResponse(response)) response.send(JSON.stringify(output));
		else response.end(JSON.stringify(output));
	};
	return {
		isResponseSent,
		setHeader,
		statusCode: response.statusCode,
		setStatusCode,
		sendResponse
	};
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
//#region src/express/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates an Express middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated — reusing a name throws an error.
* Prefix and path regexes are compiled once at creation time (hoisted) for performance.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns An Express middleware function
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
	const middlewareHandler = async (req, res, next) => {
		const { url } = getRequestDetails(req);
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) return next?.();
		if (pathMatcher && !pathMatcher.test(url)) return next?.();
		if (prefixRegex && !prefixRegex.test(url)) return next?.();
		await handler(req, res, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Express RPC middleware that routes incoming requests to registered server functions.
* Reads the request body, dispatches to the matching function via serverFunctionsMap,
* and sends the JSON-serialized result. Handles client disconnection via abort signals.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns An Express middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${rpcPrefix}/`;
	return createMiddleware({
		...options,
		handler: async (req, res, _next) => {
			const { url } = getRequestDetails(req);
			const { sendResponse } = getResponseDetails(res);
			if (prefixRegex && !prefixRegex.test(url)) return;
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) {
				sendResponse(404, { error: FUNCTION_NOT_FOUND });
				return;
			}
			try {
				const body = await readBody(req);
				const args = Array.isArray(body.data) ? body.data : [body.data];
				const { data, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.on("close", onClose);
				const result = await data;
				req.off("close", onClose);
				if (!res.headersSent) sendResponse(200, { data: result });
			} catch (err) {
				console.error(String(err));
				sendResponse(500, { error: INTERNAL_SERVER_ERROR });
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, getRequestDetails, getResponseDetails, hasPreParsedBody, isExpressRequest, isExpressResponse, readBody };

//# sourceMappingURL=express.mjs.map