//#region src/constants.ts
const REQUEST_CANCELLED = "Request was cancelled";
const FETCH_ERROR_PREFIX = "Fetch error: ";
//#endregion
//#region src/client-helpers.ts
/**
* Processes an HTTP fetch response from the RPC server.
* On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
* On other error statuses, throws a Fetch error.
* On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
* @param response - Fetch Response object from the RPC endpoint
* @returns The response data, or void on cancellation
*/
const handleResponse = async (response) => {
	if (!response.ok) {
		if (response.status === 499 || response.status === 408) return console.warn(REQUEST_CANCELLED);
		throw new Error(FETCH_ERROR_PREFIX + response.statusText);
	}
	const result = await response.json();
	if (result.error) throw new Error(result.error);
	return result.data;
};
/**
* Low-level stub factory used by both `getClientStub` and the auto-generated
* modules (`src/getClientModules.ts:73`). Keeps body/header mapping in one
* place so `innerModule` stays thin.
*/
const makeStub = (prefix, name, options = {}) => {
	const method = options.method ?? "POST";
	const credentials = options.credentials ?? "same-origin";
	const contentType = options.contentType ?? "application/json";
	if (method === "GET") {
		const headers = {};
		return ((...args) => {
			const json = JSON.stringify(args);
			return innerModule(json, headers, credentials, prefix, name, method);
		});
	}
	switch (contentType) {
		case "text/plain": {
			const headers = { "Content-Type": "text/plain" };
			return ((...args) => innerModule(args[0], headers, credentials, prefix, name, method));
		}
		case "application/x-www-form-urlencoded": {
			const headers = { "Content-Type": "application/x-www-form-urlencoded" };
			return ((...args) => innerModule(new URLSearchParams(args[0]).toString(), headers, credentials, prefix, name, method));
		}
		case "multipart/form-data": {
			const headers = {};
			return ((...args) => innerModule(args[0], headers, credentials, prefix, name, method));
		}
		default: {
			const headers = { "Content-Type": "application/json" };
			return ((...args) => innerModule(JSON.stringify(args), headers, credentials, prefix, name, method));
		}
	}
};
/**
* Creates a typed client stub for any prefix — the manual counterpart to the
* auto-generated `public:rpc` stubs. Useful for privileged prefixes like
* `admin:rpc` that are not emitted in the public bundle.
* The stub has the same `{data,cancel}` shape and cancellation/error handling
* as generated stubs, and is code-splittable: `const adminGetUser = getClientStub("admin:rpc","get-user")`
* should be `await import`-ed only inside `/admin` routes so the `admin:rpc`
* literal never appears in the public chunk.
* @param prefix - RPC prefix (e.g. "admin:rpc")
* @param name - Registered function name
* @param options - Optional `method`, `credentials`, `contentType`
* @returns Client stub `(...args) => {data,cancel}`
* @example
* import { getClientStub } from "@thednp/rpc/helpers";
* const adminGetUser = getClientStub("admin:rpc","get-user");
* const {data,cancel} = adminGetUser("123");
* @example
* const adminStats = getClientStub("admin:rpc","stats", { method: "GET" });
*/
function getClientStub(prefix, name, options) {
	return makeStub(prefix, name, options);
}
/**
* Creates an AbortController-bound fetch call for a single RPC function.
* Used by the auto-generated client modules to issue HTTP requests with cancellation support.
* GET requests carry arguments as an `?args=` JSON query parameter, since a fetch
* request body is not allowed on GET.
* @param body - Serialized request body (JSON string or raw text)
* @param headers - HTTP headers (Content-Type, etc.)
* @param credentials - Fetch credentials policy ("same-origin", "include", or "omit")
* @param prefix - RPC endpoint prefix (e.g. "__rpc")
* @param name - Registered server function name
* @param method - HTTP method to use, "POST" by default
* @returns An object with `data` (promise resolving to the server response) and `cancel` (abort function)
*/
const innerModule = (body, headers, credentials, prefix, name, method) => {
	const controller = new AbortController();
	const cancel = (reason) => controller.abort(reason);
	const fetcher = async () => {
		try {
			const isGet = method === "GET";
			const url = isGet ? `/${prefix}/${name}?args=${encodeURIComponent(String(body))}` : `/${prefix}/${name}`;
			const response = await fetch(url, {
				method: isGet ? "GET" : "POST",
				headers,
				credentials,
				body: isGet ? void 0 : body,
				signal: controller.signal
			});
			return await handleResponse(response);
		} catch (err) {
			throw err;
		}
	};
	return {
		data: fetcher(),
		cancel
	};
};
//#endregion
export { getClientStub, handleResponse, innerModule };

//# sourceMappingURL=helpers.mjs.map