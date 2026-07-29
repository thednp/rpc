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
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
function attachVite(app, vite) {
	app.use(vite.middlewares);
}
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
const isExpressRequest = (req) => {
	return "originalUrl" in req;
};
const isExpressResponse = (res) => {
	return "json" in res && "send" in res;
};
const hasPreParsedBody = (req) => {
	return "body" in req;
};
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
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/constants.ts
const FUNCTION_NOT_FOUND = "Function not found";
const INTERNAL_SERVER_ERROR = "Internal Server Error";
const CLIENT_DISCONNECTED = "client disconnected";
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
//#endregion
//#region src/express/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
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
	const middlewareHandler = async (req, _res, next) => {
		const { url } = getRequestDetails(req);
		if (serverFunctionsMap.size === 0) await scanForServerFiles();
		if (!handler) return next?.();
		if (pathMatcher && !pathMatcher.test(url)) return next?.();
		if (prefixRegex && !prefixRegex.test(url)) return next?.();
		await handler(req, _res, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
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