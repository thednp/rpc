//#region src/constants.ts
const REQUEST_CANCELLED = "Request was cancelled";
const FETCH_ERROR_PREFIX = "Fetch error: ";
//#endregion
//#region src/helpers.ts
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
* Creates an AbortController-bound fetch call for a single RPC function.
* Used by the auto-generated client modules to issue POST requests with cancellation support.
* @param body - Serialized request body
* @param headers - HTTP headers (Content-Type, etc.)
* @param credentials - Fetch credentials policy ("same-origin", "include", or "omit")
* @param prefix - RPC endpoint prefix (e.g. "__rpc")
* @param name - Registered server function name
* @returns An object with `data` (promise resolving to the server response) and `cancel` (abort function)
*/
const innerModule = (body, headers, credentials, prefix, name) => {
	const controller = new AbortController();
	const cancel = (reason) => controller.abort(reason);
	const fetcher = async () => {
		try {
			const response = await fetch(`/${prefix}/${name}`, {
				method: "POST",
				headers,
				credentials,
				body,
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
export { handleResponse, innerModule };

//# sourceMappingURL=helpers.mjs.map