//#region src/constants.ts
const REQUEST_CANCELLED = "Request was cancelled";
const FETCH_ERROR_PREFIX = "Fetch error: ";
//#endregion
//#region src/helpers.ts
const handleResponse = async (response) => {
	if (!response.ok) {
		if (response.status === 499 || response.status === 408) return console.warn(REQUEST_CANCELLED);
		throw new Error(FETCH_ERROR_PREFIX + response.statusText);
	}
	const result = await response.json();
	if (result.error) throw new Error(result.error);
	return result.data;
};
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