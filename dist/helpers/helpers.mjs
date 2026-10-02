//#region src/constants.ts
/** Warning text used when a request is cancelled by an HTTP 408/499 response. */
const REQUEST_CANCELLED = "Request was cancelled";
/** Prefix of the `Error` message the client helpers throw for a non-OK HTTP response. The status text is appended; the response body is deliberately not read, so server-side detail never reaches the client through this path. */
const FETCH_ERROR_PREFIX = "Fetch error: ";
//#endregion
//#region src/client-helpers.ts
/**
* A non-2xx RPC response, with the server's body attached.
*
* Carrying the body matters because the server sends its most useful errors
* *in* it. A `400` from a schema violation carries the rendered issue paths and
* the per-field `hint`; discarding that and throwing only `statusText` would
* leave the browser unable to tell the caller *which field* was wrong, which is
* the whole point of the teaching-error work. The previous behaviour — throw
* `FETCH_ERROR_PREFIX + statusText` without reading the body — is preserved in
* `message` for anyone matching on it.
*/
var RPCResponseError = class extends Error {
	/** The HTTP status. */
	status;
	/** The parsed response body, when it was JSON. */
	body;
	constructor(status, statusText, body) {
		super(FETCH_ERROR_PREFIX + statusText);
		this.name = "RPCResponseError";
		this.status = status;
		this.body = body;
	}
	/**
	* The validation issues from a `422` body, when the server sent them.
	*
	* Returns `undefined` for any other status or an unrecognised body, so a
	* caller can branch without inspecting the shape itself.
	*/
	get issues() {
		const body = this.body;
		if (body?.code !== "VALIDATION") return void 0;
		const issues = body.data?.issues;
		return Array.isArray(issues) ? issues : void 0;
	}
	/** The general `hint` from a `422` body, when the server sent one. */
	get hint() {
		const hint = this.body?.hint;
		return typeof hint === "string" ? hint : void 0;
	}
};
/**
* Processes an HTTP fetch response from the RPC server.
*
* On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
* On any other error status, throws an {@link RPCResponseError} carrying the
* status and the parsed body when there is one.
* On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
* @param response - Fetch Response object from the RPC endpoint
* @returns The response data, or void on cancellation
*/
const handleResponse = async (response) => {
	if (!response.ok) {
		if (response.status === 499 || response.status === 408) return console.warn(REQUEST_CANCELLED);
		let body;
		try {
			body = await response.clone().json();
		} catch {
			body = void 0;
		}
		throw new RPCResponseError(response.status, response.statusText, body);
	}
	const result = await response.json();
	if (result.error) throw new Error(result.error);
	return result.data;
};
/**
* Field errors from a rejected call, keyed by the path that failed.
*
* The server normalises **every** validator's issues into the same
* `{ path, message, hint? }` shape, so this is validator-agnostic: a zod
* rejection and an arktype rejection arrive identically, and neither needs the
* app to know which library produced it. That is what removes the usual
* per-app helper — a hand-rolled `isValiError` guard plus a
* `getError(error, field)` formatter, both tied to one library's flattened
* output and silently wrong for the other three.
*
* Paths are the rendered strings rpc already produces, so a nested failure keys
* on `"profile.email"`. An empty path — a top-level scalar — keys on `""`.
*
* ```ts
* import { fieldErrors } from "@thednp/rpc/helpers";
*
* for (const [path, messages] of Object.entries(fieldErrors(err))) {
*   showError(path, messages.join(" "));
* }
* ```
*
* Works in production as well as development. A production rejection carries
* each issue's `path` and `hint` but not the validator library's `message`, so
* the message falls back to the hint; an issue carrying neither is skipped
* rather than rendered as an empty string, which would put a stray `""` into
* every "show errors" loop.
*
* Returns an empty object for anything that is not a validation failure.
*/
const fieldErrors = (err) => {
	const issues = err instanceof RPCResponseError ? err.issues : void 0;
	if (!issues) return {};
	const grouped = {};
	for (const issue of issues) {
		const text = issue.message ?? issue.hint ?? "";
		const key = issue.path ?? "";
		(grouped[key] ??= []).push(text);
	}
	return grouped;
};
/**
* One field's messages, ready to render — the exact replacement for a
* hand-written `getError(error, field)`.
*
* Returns `""` when the field did not fail, so it drops straight into an
* element's `textContent` with no guard:
*
* ```ts
* emailError.textContent = fieldErrorText(err, "email");
* ```
*/
const fieldErrorText = (err, field) => {
	const messages = fieldErrors(err)[field];
	return messages?.length ? messages.join("; ") : "";
};
/**
* The `hint` for a field's failure, or `""`.
*
* Prefers the field's own hint — from `hints: { email: "…" }` or from a builder
* schema's `field.string({ hint })` — and falls back to the function-wide
* `hint`, which is the more common form and would otherwise be unreachable from
* a per-field lookup. Several issues can share a path; the first hint wins,
* because a field with two hints is better served by one than by none.
*
* Sent in production as well as development. A hint is authored in
* `ServerFunctionOptions`, so disclosing it was deliberate — which is exactly
* why it is the one part of an issue that survives into a production body.
* That makes it the right thing to put in a `title` or tooltip beside the
* field, whether or not there is a visible message to pair it with.
*/
const fieldErrorHint = (err, field) => {
	if (!(err instanceof RPCResponseError)) return "";
	return err.issues?.find((i) => (i.path ?? "") === field)?.hint ?? err.hint ?? "";
};
/**
* Unwraps the `{ data }` envelope from a parsed RPC response body.
*
* Error handling matches `handleResponse` so both helpers in this module agree
* on the contract: a **top-level** `error` key (including `400`/`403`/`404`/`405`/`409`/`413`/`415`/`422`/`500`) throws, while a `{ data: { error } }` body resolves
* normally — that shape is the documented "validation-as-data" contract where a
* 200 carries the validation outcome as its result.
*
* Discriminating on `error` present **and** `data` absent is what keeps those
* two cases apart. Checking `res.ok` first is still recommended, since this
* helper is status-code agnostic by design, so still check `res.ok` before
* passing it a body.
* @param json - Parsed JSON response body
* @returns The unwrapped response data
* @throws When the body carries a top-level `error` and no `data`
* @example
* ```ts
* const response = await fetch("/__rpc/greet", { method: "POST", ... });
* const body = await response.json();
* const greeting = unwrapEnvelope<string>(body); // "Hello, world!"
* ```
*/
const unwrapEnvelope = (json) => {
	if (json !== null && typeof json === "object") {
		const envelope = json;
		if (!("data" in envelope) && "error" in envelope) throw new Error(String(envelope.error));
		if ("data" in envelope) return envelope.data;
	}
	return json;
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
export { RPCResponseError, fieldErrorHint, fieldErrorText, fieldErrors, getClientStub, handleResponse, innerModule, unwrapEnvelope };

//# sourceMappingURL=helpers.mjs.map