import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
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
//#region src/koa/helpers.ts
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
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
const readBody = (ctx) => {
	const contentType = ctx.request.headers["content-type"]?.toLowerCase() || "";
	return new Promise((resolve, reject) => {
		const isJSON = contentType.includes("json");
		const reqBody = ctx.request.body;
		if (reqBody !== void 0) {
			resolve({
				contentType: isJSON ? "application/json" : "text/plain",
				data: isJSON ? reqBody : String(reqBody)
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
			try {
				const data = JSON.parse(body);
				resolve({
					contentType: isJSON ? "application/json" : "text/plain",
					data
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
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPrefix: defaultRPCOptions.rpcPrefix }, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`) : null;
	const prefixReplace = `/${rpcPrefix}/`;
	return createMiddleware({
		...options,
		handler: async (ctx, _next) => {
			const url = new URL(ctx.url, "http://localhost").pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) {
				ctx.status = 404;
				ctx.body = { error: FUNCTION_NOT_FOUND };
				return;
			}
			try {
				const body = await readBody(ctx);
				const args = Array.isArray(body.data) ? body.data : [body.data];
				const { data: resultData, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				ctx.req.on("close", onClose);
				const result = await resultData;
				ctx.req.off("close", onClose);
				ctx.status = 200;
				ctx.body = { data: result };
			} catch (err) {
				console.error(String(err));
				ctx.status = 500;
				ctx.body = { error: INTERNAL_SERVER_ERROR };
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };

//# sourceMappingURL=koa.mjs.map