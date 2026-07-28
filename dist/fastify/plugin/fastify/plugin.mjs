import fp from "fastify-plugin";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
//#region src/options.ts
const defaultRPCOptions = {
	rpcPreffix: "__rpc",
	adapter: "express"
};
const defaultMiddlewareOptions = {
	rpcPreffix: void 0,
	path: void 0
};
//#endregion
//#region src/tools.ts
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/fastify/helpers.ts
const readBody = (req) => {
	return new Promise((resolve, reject) => {
		const contentType = req.headers["content-type"]?.toLowerCase() || "";
		const reqBody = req.body;
		if (reqBody !== void 0) {
			const isJSON = contentType.includes("json");
			resolve({
				contentType: isJSON ? "application/json" : "text/plain",
				data: isJSON ? reqBody : String(reqBody)
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
//#endregion
//#region src/fastify/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
const createMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const middlewareName = options.name;
	const rpcPreffix = options.rpcPreffix;
	const path = options.path;
	const handler = options.handler;
	let name = middlewareName;
	if (!name) {
		name = "viteRPCMiddleware-" + middlewareCount;
		middlewareCount += 1;
	}
	if (middlewareStack.has(name)) throw new Error(`The middleware name "${name}" is already used.`);
	middlewareStack.add(name);
	const prefixRegex = rpcPreffix ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`) : null;
	const pathMatcher = path ? typeof path === "string" ? new RegExp(path) : path : null;
	const middlewareHandler = async (req, _reply, done) => {
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
		await handler(req, _reply, done);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, { rpcPreffix: defaultRPCOptions.rpcPreffix }, initialOptions);
	const rpcPreffix = options.rpcPreffix;
	const prefixRegex = rpcPreffix ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`) : null;
	const prefixReplace = `/${rpcPreffix}/`;
	return createMiddleware({
		...options,
		handler: async (req, reply, _done) => {
			const url = new URL(req.url, "http://localhost").pathname;
			if (prefixRegex && !prefixRegex.test(url)) return;
			const functionName = url.replace(prefixReplace, "");
			const serverFunction = serverFunctionsMap.get(functionName);
			if (!serverFunction) {
				reply.status(404).send({ error: "Function not found" });
				return;
			}
			try {
				const body = await readBody(req);
				const args = Array.isArray(body.data) ? body.data : [body.data];
				const { data: dataResult, cancel } = serverFunction.handler(...args);
				const onClose = () => cancel("client disconnected");
				req.raw.on("close", onClose);
				const data = await dataResult;
				req.raw.off("close", onClose);
				if (!reply.raw.headersSent) reply.status(200).send({ data });
			} catch (err) {
				console.error(String(err));
				reply.status(500).send({ error: "Internal Server Error" });
			}
		}
	});
};
//#endregion
//#region src/fastify/plugin.ts
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