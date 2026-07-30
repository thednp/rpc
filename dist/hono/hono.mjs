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
//#region src/hono/helpers.ts
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const { adapter: _adapter, ...options } = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
const attachVite = (app, vite) => {
	app.use(viteMiddleware(vite));
};
/**
* Creates a hono compatible middleware for a given vite development server.
* @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
* @param vite the vite development server
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