import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process$1 from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/constants.ts
/** Thrown-name for an operation stopped by its own `cancel()`. */
const OPERATION_ABORTED = "Operation aborted";
/** Warning logged when a scanned server module exports nothing. */
const NO_SERVER_FUNCTION_FOUND = "No server function found.";
/** Error logged when a server function file cannot be loaded by Vite's SSR loader. */
const ERROR_LOADING_FILE = "Error loading file:";
/** Body of a 403, returned when the optional origin allowlist rejects the request. */
const REQUEST_FORBIDDEN = "Forbidden";
/** Body of a 415, returned when the request's `Content-Type` does not satisfy the function's declared `contentType`. */
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
/** Body of a 413, returned when the request body exceeds rpc's own streaming size limit. */
const PAYLOAD_TOO_LARGE = "Payload Too Large";
/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
const BAD_REQUEST = "Bad Request";
/**
* Body of a 422, returned when a schema rejects the input.
*
* A distinct status from `400` on purpose. `400` means the request could not be
* understood — a malformed body, a `?args=` that is not an array — and a
* validation failure is not that: the body parsed fine and the *fields* are
* wrong. Sharing one status leaves a client unable to tell a broken request from
* a wrong one without reading prose, and `422` is the widely-understood code for
* exactly this ("syntax fine, semantics not").
*/
const UNPROCESSABLE_CONTENT = "Unprocessable Content";
/**
* Reason phrases for the statuses a typed `RPCError` subclass can carry. A
* thrown `NotFoundError` must not be reported as `Bad Request` just because
* that was the table's only 4xx entry.
*/
const NOT_FOUND = "Not Found";
const CONFLICT = "Conflict";
/** Body of a 500. Always generic — never the underlying error, so internals cannot leak. */
const INTERNAL_SERVER_ERROR = "Internal Server Error";
/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
const INVALID_IDENTIFIER = (label, name) => `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;
/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
const INVALID_PATH_SEGMENT = (label, segment) => `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/`;
/** Error template for duplicate server function names across files. @param name - The duplicate registered name */
const DUPLICATE_FUNCTION_NAME = (name) => `Duplicate server function "${name}" detected. Each server function must have a unique name. Remove or rename the duplicate.`;
/**
* A function-wide pointer appended to every validation failure.
*
* Dev-only, like the per-field hints, so production bodies stay a fixed shape.
* This was previously copy-pasted into all five adapters; one definition means
* one place to change the doc link.
*/
const VALIDATION_HINT = "input did not match the function's schema; see wiki/server-functions.md#input-validation";
/** Identifiers safe to interpolate into generated code without escaping. */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Path segments safe to interpolate, allowing the `@` and `/` a prefix uses. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/;
/** The `credentials` values the client stubs accept. */
const CREDENTIALS_VALUES = [
	"same-origin",
	"include",
	"omit"
];
/**
* Default cap on the request body a single RPC call may carry: 10 MiB.
*
* It lives in this leaf module so that neither `body.ts` nor `options.ts` has to
* import the other. The previous home was `options.ts`, chosen to dodge an
* initialisation cycle (`body.ts → server-helpers.ts → options.ts → body.ts`)
* that threw under raw ESM; a shared leaf removes the cycle instead of routing
* around it.
*/
const DEFAULT_BODY_LIMIT = 10485760;
/** The exact basenames the `exact` scan mode recognises. */
const EXACT_NAMES = [
	"server.ts",
	"server.js",
	"server.mjs",
	"server.mts"
];
/**
* The fixed base a raw request URL is resolved against.
*
* A request-target like `/\` makes the WHATWG parser throw, and the adapters
* build the URL before their dispatch `try` block, so the base has to be
* something that always parses and never matches a real prefix.
*/
const SAFE_URL_BASE = "http://localhost";
/** Matches the `*.server.{ts,js,mjs,mts}` basename the `glob` scan mode uses. */
const GLOB_REGEX = /^.+\.server\.(ts|js|mjs|mts)$/;
/** The `vendor` string a schema built by this library reports. */
const VENDOR = "thednp";
//#endregion
//#region src/options.ts
/**
* Defaults applied to a server function that declares no `method`,
* `credentials`, or `contentType` of its own.
*/
const defaultServerFnOptions = {
	contentType: "application/json",
	credentials: "same-origin",
	method: "POST"
};
/**
* The built-in RPC endpoint prefix, used when neither an explicit prefix nor a
* global one (`getGlobalPrefix`) is supplied. Kept for backward compatibility
* with pre-multi-prefix setups, where every function lived under this one map.
*/
const defaultPrefix = "__rpc";
/**
* Baseline plugin options. `defineConfig` merges a user's partial config over
* these, and `loadRPCConfig` merges a loaded config file over them, so every
* option has a defined value even when a config file omits it.
*/
const defaultRPCOptions = {
	rpcPrefix: defaultPrefix,
	serverFiles: "exact",
	scanRoot: void 0
};
/**
* Baseline middleware options. Note `rpcPrefix` is `undefined` rather than
* `defaultPrefix` on purpose: leaving it unset lets `resolveRPCPrefix` fall
* through to the global prefix, which is what makes a published global prefix
* reach the middleware.
*
* `origin` is the opposite case, and deliberately so: it defaults to the secure
* `"self"` policy rather than to "no check", so an RPC endpoint created with no
* options at all is cross-origin protected. `allowHeaderless` defaults to
* `false` for the same reason — headerless clients are opt-in.
*
* Neither default is a bypass. `Object.assign(defaults, options)` copies an
* explicit `origin: undefined` over the default, so `isOriginRequestAllowed`
* also resolves an absent policy to `"self"` itself. Two independent guards,
* because a security default that one merge call can erase is not a default.
*/
const defaultMiddlewareOptions = {
	rpcPrefix: void 0,
	path: void 0,
	origin: "self",
	allowHeaderless: false,
	bodyLimit: DEFAULT_BODY_LIMIT
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
/**
* Backward compatibility: default map for the default prefix.
* Legacy code can still use serverFunctionsMap.set(name, entry).
*/
const serverFunctionsMap = {
	get: (key) => getFunctionsForPrefix(defaultPrefix).get(key),
	set: (key, value) => getFunctionsForPrefix(defaultPrefix).set(key, value),
	has: (key) => getFunctionsForPrefix(defaultPrefix).has(key),
	delete: (key) => getFunctionsForPrefix(defaultPrefix).delete(key),
	clear: () => getFunctionsForPrefix(defaultPrefix).clear(),
	get size() {
		return getFunctionsForPrefix(defaultPrefix).size;
	},
	entries: () => getFunctionsForPrefix(defaultPrefix).entries(),
	keys: () => getFunctionsForPrefix(defaultPrefix).keys(),
	values: () => getFunctionsForPrefix(defaultPrefix).values(),
	forEach: (callback) => getFunctionsForPrefix(defaultPrefix).forEach(callback),
	[Symbol.iterator]: () => getFunctionsForPrefix(defaultPrefix)[Symbol.iterator]()
};
//#endregion
//#region src/server-helpers.ts
/**
* Recursively walks `dir` and collects absolute paths to files whose
* basename matches the `*.server.{ts,js,mjs,mts}` glob pattern.
*/
const walkGlobFiles = async (dir) => {
	const results = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop();
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (_e) {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isFile() && GLOB_REGEX.test(entry.name)) results.push(fullPath);
			else if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return results;
};
/** Registered brand carried by every {@link RPCError}, across bundle copies. */
const RPC_ERROR_BRAND = Symbol.for("thednp.rpc.error");
/**
* Recognises an {@link RPCError} without `instanceof`, so the check holds
* across tsdown's per-entry copies of the class.
*/
const isRPCError = (err) => err instanceof RPCError || typeof err === "object" && err !== null && err[RPC_ERROR_BRAND] === true;
/**
* A typed error thrown from server functions.
*
* `formatError` decides what crosses the wire. Unexpected exceptions always
* answer `{ error: "Internal Server Error" }`; typed errors keep the status
* reason plus the semantics `formatError` documents.
*/
var RPCError = class extends Error {
	/**
	* A cross-bundle brand, so `instanceof` is not the only way to recognise one.
	*
	* Each tsdown entry bundles its own copy of this class, so a `ValidationError`
	* raised by `runValidation` inside `dist/server/server.mjs` is **not** an
	* `instanceof` the `RPCError` in `dist/express/express.mjs` — the check
	* silently answers false across entries. `Symbol.for` is registry-global
	* across bundles and realms, so this brand survives the duplication. The same
	* reason `setGlobalPrefix` stores its value under a registered symbol.
	*/
	[RPC_ERROR_BRAND] = true;
	/** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
	code;
	/** Optional diagnostic payload */
	data;
	/**
	* Developer-facing advice about how to fix the failure, dev-only.
	*
	* A message says what went wrong; a hint says what to do about it.
	* `formatError` decides what crosses the wire: a `ValidationError` keeps
	* author-written paths and hints while dropping the validator library's
	* `message`; the other typed errors keep the status reason phrase in
	* production. See {@link NotFoundError} and siblings for the typed forms.
	*/
	hint;
	constructor(message, code = "INTERNAL", data, hint) {
		super(message);
		this.name = "RPCError";
		this.code = code;
		this.data = data;
		this.hint = hint;
	}
};
/**
* A `404` that teaches. The `hint` is **required**, deliberately: an error class
* whose whole purpose is to explain a failure should not be constructible
* without the explanation. It is still stripped in production.
*/
var NotFoundError = class extends RPCError {
	/** The client-error status, so adapters answer `404` and not `500`. */
	status = 404;
	constructor(message, hint, data) {
		super(message, "NOT_FOUND", data, hint);
		this.name = "NotFoundError";
	}
};
/** A `403` that teaches. See {@link NotFoundError} for why `hint` is required. */
var ForbiddenError = class extends RPCError {
	/** The client-error status, so adapters answer `403` and not `500`. */
	status = 403;
	constructor(message, hint, data) {
		super(message, "FORBIDDEN", data, hint);
		this.name = "ForbiddenError";
	}
};
/** A `409` that teaches. See {@link NotFoundError} for why `hint` is required. */
var ConflictError = class extends RPCError {
	/** The client-error status, so adapters answer `409` and not `500`. */
	status = 409;
	constructor(message, hint, data) {
		super(message, "CONFLICT", data, hint);
		this.name = "ConflictError";
	}
};
/**
* A rejected input: a `422` that carries structured issues.
*
* Lives here rather than in `schema.ts` so the error types and the builder have a
* single direction between them — `schema.ts` imports this, not the reverse.
*/
var ValidationError = class extends RPCError {
	/**
	* The client-error status, so adapters answer `422` and not `500`.
	*
	* `422` rather than `400` on purpose: the body parsed and the *fields* are
	* wrong, which is a different thing from a request that could not be parsed
	* at all. Sharing `400` left a client unable to tell a malformed body from a
	* rejected input without reading the prose.
	*/
	status = 422;
	/** The rendered issues, one per rejected field. */
	issues;
	/**
	* @param issues - The rendered issues, one per rejected field.
	* @param hint - A general hint about how to fix the failure, inherited from
	*   {@link RPCError.hint} and dev-only like it.
	*/
	constructor(issues, hint) {
		super("Validation failed", "VALIDATION", { issues }, hint);
		this.name = "ValidationError";
		this.issues = issues;
	}
};
/** Builds the JSON body for a rejected input. */
const validationErrorBody = (err, options = {}) => {
	const includeMessages = options.includeMessages ?? true;
	return {
		error: includeMessages ? err.message : clientErrorMessage(err.status),
		code: err.code,
		data: { issues: includeMessages ? err.issues : err.issues.map(({ path, hint }) => hint ? {
			path,
			hint
		} : { path }) },
		...err.hint ? { hint: err.hint } : {}
	};
};
/**
* Formats an error for the RPC middleware response. See {@link ValidationError} for the rejected-input contract.
*
* In development the full `RPCError` payload is included so developers
* can quickly identify issues. Unexpected exceptions never expose their
* message — only the generic "Internal Server Error" is sent, preventing
* information disclosure; server-side diagnostics are preserved via the
* middleware's `console.error` logging.
* @param err - The caught error
* @param isProduction - Whether the response uses the production body contract
* @returns The response body for the dispatch
*/
const formatError = (err, isProduction) => {
	if (err instanceof ValidationError) return validationErrorBody(err, isProduction ? { includeMessages: false } : {});
	if (err instanceof RPCError) {
		const thrownStatus = readClientStatus(err);
		if (thrownStatus !== void 0) {
			if (isProduction) return { error: clientErrorMessage(thrownStatus) };
			const described = {
				error: err.message || clientErrorMessage(thrownStatus),
				code: err.code
			};
			if (err.data !== void 0) described.data = err.data;
			if (err.hint !== void 0) described.hint = err.hint;
			return described;
		}
	}
	const clientStatus = readClientStatus(err);
	if (clientStatus !== void 0) return { error: clientErrorMessage(clientStatus) };
	if (isProduction) return { error: INTERNAL_SERVER_ERROR };
	if (err instanceof RPCError) {
		const payload = {
			error: err.message || "Internal Server Error",
			code: err.code
		};
		if (err.data !== void 0) payload.data = err.data;
		if (err.hint !== void 0) payload.hint = err.hint;
		return payload;
	}
	return { error: INTERNAL_SERVER_ERROR };
};
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
const isClientHttpError = (err) => readClientStatus(err) !== void 0;
/**
* Reads the status to answer for a client error. Defaults to `400` rather than
* `500` so an unrecognised 4xx is never reported as a server fault.
* @param err - The caught error
* @returns The 4xx status to answer with
*/
const clientErrorStatus = (err) => readClientStatus(err) ?? 400;
const clientErrorMessage = (status) => {
	if (status === 403) return REQUEST_FORBIDDEN;
	if (status === 404) return NOT_FOUND;
	if (status === 409) return CONFLICT;
	if (status === 413) return PAYLOAD_TOO_LARGE;
	if (status === 415) return UNSUPPORTED_MEDIA_TYPE;
	if (status === 422) return UNPROCESSABLE_CONTENT;
	return BAD_REQUEST;
};
/**
* Checks whether a content type maps to a form encoding
* (`multipart/form-data` or `application/x-www-form-urlencoded`).
* Form-declared functions accept either encoding so native browser
* submissions (urlencoded) keep working without JavaScript.
*/
const isFormContentType = (contentType) => contentType === "multipart/form-data" || contentType === "application/x-www-form-urlencoded";
/**
* Detects whether an incoming request's `Content-Type` header conflicts
* with the function's declared content type. JSON and text functions are
* enforced strictly (exact match wins), while form functions accept both
* form encodings because the nojs fallback submits urlencoded forms to
* multipart-declared endpoints. Requests without a `Content-Type` header
* (curl, GET, legacy clients) are exempt from enforcement.
* @param declared - The declared `contentType` from the server function options
* @param rawHeader - The raw `Content-Type` request header, if present
*/
const hasContentTypeMismatch = (declared, rawHeader) => {
	if (!rawHeader) return false;
	const incomingType = rawHeader.trim().toLowerCase().split(";")[0].trim();
	if (isFormContentType(declared)) return !isFormContentType(incomingType);
	return incomingType !== declared;
};
/**
* Extracts the `host[:port]` of an `Origin` header, or `null` when the value is
* not a real origin.
*
* `new URL` is doing load-bearing work here: it **drops default ports**, so
* `https://app.example.com:443` normalises to `app.example.com` — exactly the
* `Host` a browser sends for that same connection. Without it, a browser behind
* TLS termination would send a port the `Host` header lacks and `"self"` would
* reject every request.
*
* `Origin: null` (sandboxed iframes, `file://`, extensions) and any malformed
* value throw here and are rejected, which is the intended outcome — neither
* names a host.
* @param origin - The raw `Origin` header value
* @returns The lowercased `host[:port]`, or `null` if unparseable
*/
const originHost = (origin) => {
	try {
		return new URL(origin).host.toLowerCase();
	} catch {
		return null;
	}
};
/**
* Decides whether a request may proceed, given the configured origin policy and
* the headers a browser can be made to reveal.
*
* The default policy is `"self"`, so this is **on by default**: a request from
* another origin is rejected unless the operator opted in. Rejection ladder,
* first signal with meaning wins:
*
* 1. `Origin` present → the policy decides.
* 2. `Origin` absent, `Sec-Fetch-Site` present → only `same-origin` and `none`.
* 3. Neither present → only if `allowHeaderless`.
*
* **Tier 1 must short-circuit ahead of tier 2.** `Sec-Fetch-Site` is a coarse
* four-value enum that cannot name a host, so on its own it would reject a
* legitimate request from an allowlisted sibling subdomain (`same-site`). The
* allowlist exists precisely to admit that case, and it can only do so while
* `Origin` survives. `Sec-Fetch-Site` earns a vote only once the precise signal
* has been stripped away by something in the chain — at which point there is
* nothing left to trust, so it fails closed.
*
* **Comparison is host-and-port.** The scheme is never compared, so TLS termination
* needs no action and no `X-Forwarded-Proto` trust. Default ports are normalised,
* but a non-default port must match both sides. Forwarded headers are never
* consulted at all: `X-Forwarded-Host` is attacker-influenceable, and letting a
* header answer "which host am I?" would hand the decision to the request. An
* ingress that rewrites `Host` is handled by naming the public origin explicitly.
*
* An empty (or whitespace-only) header value counts as **absent**, not as an
* unrecognised signal. No browser emits an empty `Sec-Fetch-Site`, and adapters
* disagree on what their header accessor returns for a missing header (Node's
* `req.headers` yields `undefined`, Hono's `c.req.header()` may yield `""`).
* Normalising here keeps all five adapters behaving identically.
* @param check - The configured policy and the request's raw headers
* @returns `true` when the request may proceed
*/
const isOriginRequestAllowed = (check) => describeOriginRequest(check).allowed;
/**
* The same decision as {@link isOriginRequestAllowed}, plus **which tier made
* it** — so an execution-context record can answer "why was this allowed?"
* rather than only "was it?".
*
* The rule lives here once and `isOriginRequestAllowed` is a projection of it.
* A second copy of the tier order in the recorder would be exactly the
* copy-paste divergence `AGENTS.md` warns about for the adapters: the two would
* agree until someone edited one.
*/
const describeOriginRequest = ({ allowed, origin, site, host, allowHeaderless = false }) => {
	const policy = allowed ?? "self";
	if (origin?.trim()) {
		if (policy === "self") return {
			allowed: isSelfOrigin(origin, host),
			tier: "origin"
		};
		if (isOriginAllowed(Array.isArray(policy) ? policy : [policy], origin)) return {
			allowed: true,
			tier: "origin"
		};
		return {
			allowed: isSelfOrigin(origin, host),
			tier: "origin"
		};
	}
	if (site?.trim()) {
		const ok = site === "same-origin" || site === "none";
		return {
			allowed: ok,
			tier: ok ? "sec-fetch-site" : "blocked"
		};
	}
	return {
		allowed: allowHeaderless,
		tier: allowHeaderless ? "headerless" : "blocked"
	};
};
/**
* Whether an `Origin` header denotes the server's own host and port.
*
* Compares lowercased `host[:port]`, with default ports normalised by the URL
* parser (`https://app.example.com:443` matches `Host: app.example.com`), while
* a mismatched non-default port fails. The scheme is ignored so that a
* TLS-terminating proxy needs no configuration, and a mismatched scheme is not a
* forgery signal. If the `Host` header is missing the comparison cannot be made,
* so it fails closed.
* @param origin - The raw `Origin` header value
* @param host - The raw `Host` header value
* @returns `true` when the origin's lowercased `host[:port]` matches the `Host` header
*/
const isSelfOrigin = (origin, host) => {
	if (!host?.trim()) return false;
	const fromOrigin = originHost(origin);
	return fromOrigin !== null && fromOrigin === host.trim().toLowerCase();
};
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
/**
* Decides whether a request's `Origin` header is allowed by the configured
* allowlist. Shared by all five adapters so the rule lives in exactly one place.
*
* This is the **literal-match primitive**, not the whole policy. It has no
* concept of `"self"`, of host-only comparison, or of headerless requests — those
* live in {@link isOriginRequestAllowed}, which delegates here for the literal
* half of tier 1. Kept separate so the exact-match behaviour stays a small,
* independently testable piece with its original signature.
*
* - No `allowed` value (option unset) → everything passes: no validation.
* - No `requestOrigin` header → passes, preserving curl/native-client access.
* - Otherwise the header must match one of the entries exactly.
*
* A single string and a one-element array behave identically, so widening
* `origin` to `string | string[]` is backward compatible.
*
* `Origin: null` (sandboxed iframes, `file://`, extension pages) is rejected
* whenever an allowlist is set, because it never equals a real origin.
*
* This is the literal-match primitive only. It takes absent policy or header as
* "no signal", so do not use it directly for gating — call
* {@link isOriginRequestAllowed}, which applies `"self"` and the fail-closed
* headerless rule.
* @param allowed - The configured `origin` option, if any
* @param requestOrigin - The raw `Origin` request header, if present
* @returns `true` when the request may proceed
*/
const isOriginAllowed = (allowed, requestOrigin) => {
	if (!allowed || !requestOrigin) return true;
	return Array.isArray(allowed) ? allowed.includes(requestOrigin) : requestOrigin === allowed;
};
/**
* Parses a raw request URL against a fixed base without ever throwing.
* Malformed request-targets (e.g. `/\`, `//`, `/\/`) make the WHATWG URL
* parser throw `TypeError: Invalid URL`; the adapters call this while
* building the per-request URL **before** their dispatch `try` block, so an
* unhandled rejection there crashes raw `node:http` hosts (and Express 4).
* On failure we fall back to the base root: the resulting pathname never
* matches the RPC prefix, so the request is treated as non-RPC and falls
* through to `next()` / 404 instead of crashing the process.
* @param rawUrl - Raw request URL (path + optional query string)
* @param base - Optional base URL, defaults to a fixed localhost origin
* @returns A URL object; never throws
*/
const safeURL = (rawUrl, base = SAFE_URL_BASE) => {
	try {
		return new URL(rawUrl, base);
	} catch {
		return new URL("/", base);
	}
};
const globalPrefixSymbol = Symbol.for("thednp.rpc.globalPrefix");
/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
const getGlobalPrefix = () => globalThis[globalPrefixSymbol];
/**
* Publishes the global RPC prefix, consulted by `resolveRPCPrefix` whenever no
* explicit prefix is supplied. `loadRPCConfig` calls this on every return path
* so a loaded config is the fallback for later registrations and dispatches.
*
* Stored on a `Symbol.for` key on `globalThis` so it stays instance-stable
* across the bundled entry copies (`server.mjs`, `express.mjs`, ...) and dev
* server hot reloads — the same technique as the request-context storage.
* @param prefix - The prefix to publish, or `undefined` to clear it
*/
const setGlobalPrefix = (prefix) => {
	if (prefix) globalThis[globalPrefixSymbol] = prefix;
	else delete globalThis[globalPrefixSymbol];
};
/**
* Resolves the effective RPC prefix: the explicit one when given, otherwise
* the global prefix set by `setGlobalPrefix` / `loadRPCConfig`, otherwise the
* built-in default.
*
* Every adapter resolves its prefix through this single function — in both the
* outer `createMiddleware` gate and the `createRPCMiddleware` dispatch — so the
* two halves of a request can never disagree, and so a prefix registered by
* `createServerFunction` (which resolves the same way) is always the prefix the
* middleware looks up. Resolving the two sides independently is what allowed
* h3 to drift from the other four adapters, and what left the documented
* global-prefix flow returning 404 on all of them.
* @param rpcPrefix - Explicit prefix from config or middleware options
* @returns The prefix to gate on, look up in, and strip from the request path
*/
const resolveRPCPrefix = (rpcPrefix) => rpcPrefix || getGlobalPrefix() || "__rpc";
//#endregion
//#region src/scanForServerFiles.ts
/**
* Scan targets already performed, so a lazy re-scan is not repeated.
*
* Keyed by everything that determines the outcome — the resolved scan root
* (which files are read), the matching mode, and the prefix prefix-less
* functions register under. A single process-wide boolean used to be enough
* only while there was one prefix: the *first* scan suppressed every later
* one, so a second RPC instance on a different prefix asked for a lazy scan,
* got an early return, and answered 404 for every function it owned.
*/
const scannedTargets = /* @__PURE__ */ new Set();
/** Absolute ids (normalized) of the scanned server function files. */
const scannedServerFiles = /* @__PURE__ */ new Set();
/**
* Scans `src/api/` (or an explicit `scanRoot`) for server function files
* and populates the server functions map (scoped by rpcPrefix) with their exported functions.
* Uses Vite's SSR module loading to resolve and execute each file.
*
* Supports two matching modes via `config.serverFiles`:
*   `"exact"` — classic `server.ts|js|mjs|mts` names in the api directory
*   `"glob"` — recursively walking `scanRoot` to match `*.server.{ts,js,mjs,mts}`
* @param initialCfg - Optional Vite config overrides (root, base, server, serverFiles, scanRoot)
* @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
*/
const scanForServerFiles = async (initialCfg, devServer) => {
	const root = initialCfg?.root || process$1.cwd();
	const resolvedScanRoot = resolve(root, initialCfg?.scanRoot ?? join(root, "src", "api"));
	const serverFiles = initialCfg?.serverFiles ?? "exact";
	const target = `${resolvedScanRoot}|${serverFiles}|${initialCfg?.rpcPrefix ?? "__rpc"}`;
	if (scannedTargets.has(target) && !devServer) return;
	let createServer;
	let normalizePath;
	try {
		({createServer, normalizePath} = await import("vite"));
	} catch {
		return;
	}
	const config = !initialCfg ? {
		root: process$1.cwd(),
		base: process$1.env.BASE || "/",
		server: { middlewareMode: true }
	} : { ...initialCfg };
	let server = devServer;
	if (!server) server = await createServer({
		server: {
			...config.server,
			ws: false
		},
		appType: "custom",
		base: config.base || "/",
		root: config.root || process$1.cwd(),
		configFile: false,
		optimizeDeps: { noDiscovery: true },
		ssr: { optimizeDeps: { noDiscovery: true } }
	});
	const seenNames = /* @__PURE__ */ new Set();
	let files;
	try {
		if (serverFiles === "glob") files = await walkGlobFiles(resolvedScanRoot);
		else files = (await readdir(resolvedScanRoot, { withFileTypes: true })).filter((f) => EXACT_NAMES.includes(f.name)).map((f) => join(resolvedScanRoot, f.name));
	} catch (_e) {
		files = [];
	}
	try {
		for (const file of files) {
			scannedServerFiles.add(normalizePath(file));
			let moduleExports;
			try {
				moduleExports = await server.ssrLoadModule(file);
			} catch (error) {
				console.error(ERROR_LOADING_FILE, file, error);
				continue;
			}
			const moduleEntries = Object.entries(moduleExports);
			if (!moduleEntries.length) {
				console.warn(NO_SERVER_FUNCTION_FOUND);
				continue;
			}
			for (const [exportName, exportValue] of moduleEntries) {
				const registeredName = exportValue.name;
				const prefix = exportValue.options?.rpcPrefix || config.rpcPrefix || "__rpc";
				const seenKey = `${prefix}:${registeredName}`;
				if (seenNames.has(seenKey)) {
					if (process$1.env.NODE_ENV !== "production") throw new Error(DUPLICATE_FUNCTION_NAME(registeredName));
					console.warn(DUPLICATE_FUNCTION_NAME(registeredName));
					continue;
				}
				seenNames.add(seenKey);
				const prefixMap = getFunctionsForPrefix(prefix);
				const existing = prefixMap.get(registeredName);
				if (existing) existing.exportName = exportName;
				else prefixMap.set(registeredName, {
					name: registeredName,
					handler: exportValue,
					options: exportValue.options,
					exportName
				});
			}
		}
	} finally {
		if (!devServer && server) await server.close();
		scannedTargets.add(target);
	}
};
//#endregion
//#region src/schema.ts
/** Renders a Standard Schema path as a readable dotted/indexed string. */
const renderPath = (path) => {
	if (!path || path.length === 0) return "";
	let out = "";
	for (const segment of path) {
		const key = typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;
		if (typeof key === "number") {
			out += `[${key}]`;
			continue;
		}
		const str = String(key);
		if (out === "") out += str;
		else if (/^[A-Za-z_$][\w$]*$/.test(str)) out += `.${str}`;
		else out += `[${JSON.stringify(str)}]`;
	}
	return out;
};
/** Joins a base path with a relative one, respecting array-index syntax. */
const joinPath = (base, child) => {
	if (child === "") return base;
	if (base === "") return child;
	return child.startsWith("[") ? `${base}${child}` : `${base}.${child}`;
};
/** Prefixes every issue path of `inner` with `prefix`, and rebases its hints. */
const withPrefix = (inner, prefix, kind, hintSource) => {
	const child = hintSource;
	const hints = {};
	for (const [key, hint] of Object.entries(child.hints ?? {})) hints[joinPath(prefix, key)] = hint;
	const valueHints = { ...child.valueHints ?? {} };
	return {
		kind,
		hints,
		...Object.keys(valueHints).length > 0 ? { valueHints } : {},
		"~standard": {
			version: 1,
			vendor: VENDOR,
			validate: (value) => mapResults([inner["~standard"].validate(value)], ([result]) => {
				if (!result.issues) return { value: result.value };
				return { issues: result.issues.map((issue) => ({
					...issue,
					path: [prefix, ...issue.path ?? []].filter((p) => p !== "")
				})) };
			})
		}
	};
};
const isThenable = (value) => typeof value?.then === "function";
/** Maps settled results, staying synchronous when none of them is a Promise. */
const mapResults = (results, fn) => results.some(isThenable) ? Promise.all(results).then(fn) : fn(results);
const fail = (message, path = []) => ({ issues: [{
	message,
	path
}] });
/** A leaf validator: one of the primitive checks, or a validator you supply. */
const field = {
	string(opts = {}) {
		return {
			kind: "string",
			hints: opts.hint ? { "": opts.hint } : void 0,
			"~standard": {
				version: 1,
				vendor: VENDOR,
				validate: (value) => typeof value === "string" ? { value } : fail("expected a string")
			}
		};
	},
	number(opts = {}) {
		return {
			kind: "number",
			hints: opts.hint ? { "": opts.hint } : void 0,
			"~standard": {
				version: 1,
				vendor: VENDOR,
				validate: (value) => typeof value === "number" && Number.isFinite(value) ? { value } : fail("expected a number")
			}
		};
	},
	boolean(opts = {}) {
		return {
			kind: "boolean",
			hints: opts.hint ? { "": opts.hint } : void 0,
			"~standard": {
				version: 1,
				vendor: VENDOR,
				validate: (value) => typeof value === "boolean" ? { value } : fail("expected a boolean")
			}
		};
	},
	custom(inner, opts = {}) {
		const source = inner;
		const hints = { ...source.hints ?? {} };
		if (opts.hint) hints[""] = opts.hint;
		return {
			kind: "custom",
			hints,
			"~standard": source["~standard"]
		};
	}
};
/** Allows `undefined`; `null` is still rejected. */
const optional = (inner) => withPrefix({ "~standard": {
	version: 1,
	vendor: VENDOR,
	validate: (value) => value === void 0 ? { value: void 0 } : inner["~standard"].validate(value)
} }, "", "optional", inner);
/** Allows `null`; `undefined` is still rejected. */
const nullable = (inner) => withPrefix({ "~standard": {
	version: 1,
	vendor: VENDOR,
	validate: (value) => value === null ? { value: null } : inner["~standard"].validate(value)
} }, "", "nullable", inner);
/**
* An array whose every element matches `inner`.
*
* Element hints are kept index-agnostic: a hint written for the inner field
* applies to every element, and the lookup strips `[n]` before matching, so
* `array(field.string({ hint }))` teaches the right thing for `tags[7]`.
*/
const array = (inner) => ({
	kind: "array",
	hints: void 0,
	valueHints: {
		...inner.valueHints,
		...inner.hints
	},
	"~standard": {
		version: 1,
		vendor: VENDOR,
		validate: (value) => {
			if (!Array.isArray(value)) return fail("expected an array");
			return mapResults(value.map((item) => inner["~standard"].validate(item)), (results) => {
				const out = [];
				for (let i = 0; i < results.length; i++) {
					const result = results[i];
					if (result.issues) return { issues: result.issues.map((issue) => ({
						...issue,
						path: [i, ...issue.path ?? []]
					})) };
					out.push(result.value);
				}
				return { value: out };
			});
		}
	}
});
/** An object with arbitrary keys whose values all match `inner`. */
const record = (inner) => {
	const child = inner;
	return {
		kind: "record",
		hints: void 0,
		valueHints: {
			...child.valueHints,
			...child.hints
		},
		"~standard": {
			version: 1,
			vendor: VENDOR,
			validate: (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("expected an object");
				const entries = Object.entries(value);
				return mapResults(entries.map(([, raw]) => inner["~standard"].validate(raw)), (results) => {
					const out = {};
					for (let i = 0; i < entries.length; i++) {
						const [key] = entries[i];
						const result = results[i];
						if (result.issues) return { issues: result.issues.map((issue) => ({
							...issue,
							path: [key, ...issue.path ?? []]
						})) };
						out[key] = result.value;
					}
					return { value: out };
				});
			}
		}
	};
};
/**
* An object built from named fields. This is the primary entry point.
*
* Unknown keys are **rejected** rather than passed through. A server function
* that silently drops an unexpected field is a server function whose input
* contract nobody can reason about — the same reason a typed object literal
* complains about an excess property.
* @param shape - The field map
* @param opts - Schema-wide options
* @returns A Standard Schema whose output type is the inferred shape
*/
const buildSchema = (shape, opts = {}) => {
	const keys = Object.keys(shape);
	const hints = {};
	const valueHints = {};
	for (const key of keys) {
		const child = shape[key];
		for (const [path, hint] of Object.entries(child.hints ?? {})) hints[joinPath(key, path)] = hint;
		const childValues = {
			...child.valueHints ?? {},
			...child.hints ?? {}
		};
		if (Object.keys(childValues).length > 0) valueHints[key] = childValues;
	}
	if (opts.hint) hints[""] = opts.hint;
	return {
		hints,
		...Object.keys(valueHints).length > 0 ? { valueHintsByField: valueHints } : {},
		"~standard": {
			version: 1,
			vendor: VENDOR,
			validate: (value) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("expected an object");
				const input = value;
				const unexpected = Object.keys(input).filter((k) => !keys.includes(k));
				if (unexpected.length > 0) return { issues: unexpected.map((key) => ({
					message: "unexpected property",
					path: [key]
				})) };
				return mapResults(keys.map((key) => shape[key]["~standard"].validate(input[key])), (results) => {
					const out = {};
					const issues = [];
					for (let i = 0; i < keys.length; i++) {
						const key = keys[i];
						const result = results[i];
						if (result.issues) {
							for (const issue of result.issues) issues.push({
								...issue,
								path: [key, ...issue.path ?? []]
							});
							continue;
						}
						out[key] = result.value;
					}
					if (issues.length > 0) return { issues };
					return { value: out };
				});
			}
		}
	};
};
/**
* Normalises a vendor schema into an inference boundary, for use with
* `createServerFunction`.
*
* **It validates nothing and converts nothing** — the same object comes back,
* and every decision about what counts as valid still belongs to the library.
* What it changes is where TypeScript does the work.
*
* `createServerFunction` infers a handler's parameter and a client stub's
* argument with `InferOutput<TSchema>` / `InferInput<TSchema>`, which are
* *structural* matches against the schema's own type. For a heavy vendor type
* that graph can exceed the instantiation budget an older compiler allows, and
* the call fails with TS2589 — "Type instantiation is excessively deep and
* possibly infinite" — on code that is perfectly correct and that a newer
* compiler accepts. Measured with arktype's `.narrow()`, whose morph-bearing
* `Type` is the worst case found:
*
* ```ts
* const s = schema.from(type("string <= 64").narrow(nonEmpty));
* createServerFunction("f", handler, { schema: s }); // TS 5.9: clean
* createServerFunction("f", handler, { schema: narrow }); // TS 5.9: TS2589
* ```
*
* The budget is per inference site, so this splits one expensive inference into
* two cheap ones: the deep match happens here, and `createServerFunction` only
* ever sees the small `StandardSchemaV1<I, O>`. It is also why doing the same
* narrowing *inside* `createServerFunction` cannot help — that inference happens
* at the call site, before the body runs.
*
* It is a boundary, not a guarantee: a pathological type could still exhaust
* the budget *here*. For that case annotate explicitly instead —
* `const s: StandardSchemaV1<string, string> = narrow` — which costs nothing at
* runtime and pins the types.
*
* Use it for any vendor schema; you do not need it for rpc's own builder, whose
* types are already small.
* @param vendor - Any Standard Schema — zod, valibot, arktype, effect, or ours
* @returns The same object, typed as the plain spec interface
*/
const from = (vendor) => vendor;
/**
* Build a schema from rpc's own primitives, or normalise a vendor one with
* `schema.from(...)`.
*
* ```ts
* // no dependency
* schema({ email: field.string(), name: optional(field.string()) })
*
* // any Standard Schema, across an inference boundary
* schema.from(z.object({ email: z.string() }))
* ```
* @param shape - The field map
* @param opts - Schema-wide options
* @returns A Standard Schema whose output type is the inferred shape
*/
const schema = Object.assign(buildSchema, { from });
/**
* Runs a Standard Schema and converts the result into either a validated value
* or a {@link ValidationError} to throw.
*
* Hints resolve per issue path: an exact match first, then the path's leaf name.
* That ordering lets a single `hints: { email: "..." }` cover both a top-level
* `email` and a nested `profile.email`, and lets a hint written for a field inside
* an array apply to every index.
* @param schema - The schema to validate against
* @param value - The untrusted input
* @param options - Per-path hints and a function-wide hint
* @returns The validated value, or a `ValidationError` to throw
*/
const runValidation = async (schema, value, options = {}) => {
	if (Array.isArray(value)) throw httpError(400, "rpc: `schema` validates a single object argument, so an array payload is not supported. Send one object — `fn({ a: 1, b: 2 })` — and describe any nested array with `field.custom(z.array(...))`.");
	const impl = schema?.["~standard"];
	if (!impl || typeof impl.validate !== "function") throw new TypeError("schema must implement the Standard Schema interface (~standard.validate)");
	if (impl.version !== 1) throw new TypeError(`Unsupported Standard Schema version ${String(impl.version)}; expected 1`);
	const result = await impl.validate(value, options.libraryOptions !== void 0 ? { libraryOptions: options.libraryOptions } : void 0);
	if (!result.issues) return {
		ok: true,
		value: result.value
	};
	const schemaHints = schema.hints;
	const lookup = (path) => {
		const direct = options.hints?.[path] ?? schemaHints?.[path];
		if (direct) return direct;
		if (!path.includes(".") && !path.includes("[")) return void 0;
		const parts = path.split(".").map((part) => part.replace(/\[\d+\]/g, "")).filter((part) => part !== "");
		const candidates = [];
		for (let i = 0; i < parts.length; i++) candidates.push(parts.slice(i).join("."));
		for (const candidate of candidates) {
			const hit = options.hints?.[candidate] ?? schemaHints?.[candidate];
			if (hit) return hit;
		}
		const schemaValues = schema.valueHintsByField;
		if (!schemaValues) return void 0;
		const field = parts[0];
		const group = options.valueHints?.[field] ?? schemaValues[field];
		if (!group) return void 0;
		const tail = parts.slice(1);
		const tailCandidates = [""];
		for (let i = 0; i < tail.length; i++) tailCandidates.push(tail.slice(i).join("."));
		for (const candidate of tailCandidates) {
			const hit = group[candidate];
			if (hit) return hit;
		}
	};
	return {
		ok: false,
		error: new ValidationError(result.issues.map((issue) => {
			const path = renderPath(issue.path);
			const hint = lookup(path);
			return hint ? {
				path,
				message: issue.message,
				hint
			} : {
				path,
				message: issue.message
			};
		}), options.hint)
	};
};
//#endregion
//#region src/createFunction.ts
function createServerFunction(name, handler, fnOptions = {}) {
	const options = Object.assign({}, defaultServerFnOptions, fnOptions);
	const rpcPrefix = resolveRPCPrefix(fnOptions.rpcPrefix);
	const wrappedFunction = (input) => {
		const controller = new AbortController();
		const cancel = (reason) => controller.abort(reason);
		const fetcher = async () => {
			if (controller.signal.aborted) throw new Error(OPERATION_ABORTED);
			const schema = options.schema;
			if (schema) {
				const checked = await runValidation(schema, input, {
					hints: options.hints,
					hint: options.hint ? `${options.hint} — ${VALIDATION_HINT}` : VALIDATION_HINT
				});
				if (!checked.ok) throw checked.error;
				return await handler(controller.signal, checked.value);
			}
			return await handler(controller.signal, input);
		};
		return {
			data: fetcher(),
			cancel
		};
	};
	Object.defineProperties(wrappedFunction, {
		name: {
			value: name,
			enumerable: true,
			configurable: false
		},
		options: {
			value: options,
			enumerable: true,
			configurable: false
		}
	});
	getFunctionsForPrefix(rpcPrefix).set(name, {
		name,
		handler: wrappedFunction,
		options
	});
	return wrappedFunction;
}
//#endregion
//#region src/validate.ts
/**
* Validates that a string is a safe JavaScript identifier.
* Used to prevent code injection when interpolating export names into generated client code.
* @param name - The string to validate
* @param label - Human-readable label for error messages (e.g. "export name")
* @returns The validated name if it passes
* @throws Error if the name contains characters outside /^[A-Za-z_$][A-Za-z0-9_$]*$/
*/
function validateIdentifier(name, label) {
	if (!SAFE_IDENTIFIER.test(name)) throw new Error(INVALID_IDENTIFIER(label, name));
	return name;
}
/**
* Validates that a string is a safe path segment for RPC routing.
* Allows alphanumeric characters, underscores, dollar signs, at signs,
* colons, hyphens, and forward slashes.
* @param segment - The string to validate
* @param label - Human-readable label for error messages (e.g. "rpcPrefix")
* @returns The validated segment if it passes
* @throws Error if the segment contains disallowed characters
*/
function validatePathSegment(segment, label) {
	if (!SAFE_PATH_SEGMENT.test(segment)) throw new Error(INVALID_PATH_SEGMENT(label, segment));
	return segment;
}
/**
* Validates and normalizes the credentials option.
* Accepts "same-origin", "include", or "omit"; defaults to "same-origin" when undefined.
* @param value - Credentials value to validate
* @returns The validated credentials string
* @throws Error if the value is not one of the accepted credentials
*/
function validateCredentials(value) {
	const creds = value || "same-origin";
	if (!CREDENTIALS_VALUES.includes(creds)) throw new Error(`Invalid credentials: "${value}" must be one of ${CREDENTIALS_VALUES.join(", ")}`);
	return creds;
}
/**
* Validates and normalizes the HTTP method option for a server function.
* Accepts "GET" or "POST" (case-insensitive); defaults to "POST" when undefined.
* @param value - Method value to validate
* @returns The validated uppercase method string
* @throws Error if the value is not "GET" or "POST"
*/
function validateMethod(value) {
	const method = (value || "POST").toUpperCase();
	if (method !== "GET" && method !== "POST") throw new Error(`Invalid method: "${value}" must be one of GET, POST`);
	return method;
}
//#endregion
//#region src/getClientModules.ts
/**
* Generates a JavaScript client module string for a single server function.
* All interpolated values are validated to prevent code injection.
* @param fnName - Registered RPC function name (validated as path segment)
* @param fnEntry - Export name used in the generated module (validated as identifier)
* @param options - Content type, credentials, and RPC prefix settings. Both `contentType` and `rpcPrefix` are required for the generated module
* @returns A string of JavaScript code exporting the client stub
*/
const getModule = (fnName, fnEntry, options) => {
	const safeFnName = validatePathSegment(fnName, "function name");
	const safeFnEntry = validateIdentifier(fnEntry, "export name");
	const safePrefix = validatePathSegment(options.rpcPrefix, "rpcPrefix");
	const credentials = validateCredentials(options.credentials);
	const method = validateMethod(options.method);
	const contentType = options.contentType ?? "application/json";
	const opts = [];
	if (method !== "POST") opts.push(`method: "${method}"`);
	if (credentials !== "same-origin") opts.push(`credentials: "${credentials}"`);
	if (contentType !== "application/json") opts.push(`contentType: "${contentType}"`);
	return `
 export const ${safeFnEntry} = getClientStub("${safePrefix}", "${safeFnName}"${opts.length ? `, { ${opts.join(", ")} }` : ""});`.trim();
};
/**
* Generates the complete client-side module bundle by iterating all registered server functions
* for a specific prefix and producing fetch-based stubs for each. The result is transformed by Vite
* (or Oxc) during the dev server or production build.
*
* The generated stubs are plain `fetch` calls, so they are adapter-agnostic —
* only the prefix is needed.
* @param initialOptions - Plugin options containing the rpcPrefix
* @returns A string of JavaScript code with all client RPC modules and their import dependencies
*/
const getClientModules = (initialOptions) => {
	validatePathSegment(initialOptions.rpcPrefix, "rpcPrefix");
	const prefixMap = getFunctionsForPrefix(initialOptions.rpcPrefix);
	return `

import { getClientStub } from "@thednp/rpc/helpers";
${Array.from(prefixMap.entries()).filter(([, entry]) => entry.exportName).map(([registeredName, entry]) => getModule(registeredName, entry.exportName, {
		...initialOptions,
		...entry.options || {}
	})).join("\n")}`.trim();
};
//#endregion
//#region src/context.ts
/**
* Global symbol under which the shared `AsyncLocalStorage` instance is stored
* on `globalThis`. Keeping it on a `Symbol.for` key makes it instance-stable
* across module copies and dev-server hot reloads, mirroring
* `solid-js/web`'s own request-context storage.
*/
const requestContextSymbol = Symbol.for("thednp.rpc.requestContext");
const requestContextStorage = globalThis[requestContextSymbol] ??= new AsyncLocalStorage();
/**
* Runs `cb` with `init` as the current request context. Use inside the
* adapters around server-function dispatch (the async tree under `cb` can then
* read the context via {@link getRequestContext}).
* @param init - The request context for the duration of `cb`
* @param cb - The work that needs access to the request context
*/
const provideRequestContext = (init, cb) => requestContextStorage.run(init, cb);
/**
* Returns the current request context, or throws when called outside of a
* request (e.g. module scope or a background task).
* @throws When no request context is established
*/
const getRequestContext = () => {
	const ctx = requestContextStorage.getStore();
	if (!ctx) throw new Error("RequestEvent is not available outside of a request");
	return ctx;
};
/**
* Redirects the current request to `location`. Reads the adapter-bound
* `redirect` from the current request context — callable from anywhere inside
* a server-function tree (no `res` threading needed).
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to `303 See Other`
* @throws When called outside of a request
*/
const redirect = (location, status = 303) => {
	getRequestContext().redirect(location, status);
};
/**
* Sends a raw JSON response for the current request, bypassing the standard
* `{ data }` shape. Reads the adapter-bound `send` from the current request
* context — callable from anywhere inside a server-function tree. Any code in
* the async tree of a dispatch can call this (e.g. custom middleware) to
* short-circuit with a specific status code (401, 413, 429, ...).
* @param status - HTTP status code
* @param body - JSON-serializable response body
* @param headers - Optional response headers
* @throws When called outside of a request
*/
const sendResponse = (status, body, headers) => {
	getRequestContext().send(status, body, headers);
};
const pickHeader = (headers, name) => {
	const value = headers[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0];
};
/** Normalizes any headers shape into a plain lower-cased record. */
const toHeaderRecord = (headers) => {
	if (!headers) return {};
	if (typeof headers.forEach === "function") {
		const record = {};
		headers.forEach((value, key) => {
			record[key] = value;
		});
		return record;
	}
	return headers;
};
/**
* Reads normalized, adapter-agnostic request metadata from the current request
* context. Works with Express `req`, Fastify `req`, Koa `ctx.req`,
* Hono `c.req` and h3 `event.req` by feature-detecting the request shape
* (`originalUrl`/`url`/`path`, raw `headers` map vs `Headers`-like API).
* @param event - The request context to read, typically the result of
*   {@link getRequestContext}
*/
const getRequestMeta = (event) => {
	const req = event.request;
	const method = (req?.method ?? "GET").toUpperCase();
	const rawUrl = req?.originalUrl ?? req?.url ?? req?.path ?? "";
	const url = safeURL(rawUrl);
	const headers = toHeaderRecord(req?.headers ?? req?.raw?.headers);
	const hostHeader = pickHeader(headers, "host");
	return {
		method,
		pathname: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers,
		host: hostHeader,
		ip: req?.ip ?? req?.socket?.remoteAddress,
		protocol: req?.protocol ?? url.protocol.replace(":", "")
	};
};
//#endregion
//#region src/execution-log.ts
/** Bounds the shape renderer, so a pathological input cannot produce a huge string. */
const MAX_DEPTH = 3;
/** Keys described per object before the rest are summarised. */
const MAX_KEYS = 8;
/**
* Describes a value's **shape** without revealing it.
*
* Args cross this boundary on every dispatch and routinely contain passwords,
* API keys and personal data, so the default is to record only what kind of
* thing arrived — enough to answer "was this an object or a bare string?" and
* "which fields were present?", which is what a mismatch actually looks like.
*
* Bounded in depth and key count, and cycle-safe: a caller cannot make this
* allocate without bound.
*/
const argShape = (value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) => {
	if (value === null) return "null";
	if (value === void 0) return "undefined";
	if (typeof value === "string") return "string";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "bigint") return "bigint";
	if (typeof value === "function") return "function";
	if (typeof value === "symbol") return "symbol";
	if (Array.isArray(value)) {
		if (seen.has(value)) return "circular";
		seen.add(value);
		const shapes = [...new Set(value.map((item) => argShape(item, depth + 1, seen)))];
		seen.delete(value);
		return `array[${shapes.join("|")}]`;
	}
	if (seen.has(value)) return "circular";
	seen.add(value);
	if (depth >= MAX_DEPTH) return "object(…)";
	const entries = Object.entries(value);
	const described = entries.slice(0, MAX_KEYS).map(([key, item]) => `${key}:${argShape(item, depth + 1, seen)}`);
	const extra = entries.length - described.length;
	if (extra > 0) described.push(`+${extra} more`);
	seen.delete(value);
	return `{${described.join(",")}}`;
};
/** Describes the argument list of a dispatch. */
const argsShape = (args) => `[${args.map((arg) => argShape(arg)).join(",")}]`;
/**
* Describes a caught error for a record, under the caller's redaction policy.
*
* `includeMessages` and `includeStacks` are the two switches that decide
* whether the record can quote the failure or only classify it.
*/
const describeError = (err, opts = {}) => {
	const rpcError = isRPCError(err);
	const anyErr = err;
	const record = {
		name: typeof anyErr?.name === "string" ? anyErr.name : "Error",
		isRPCError: rpcError
	};
	if (rpcError) record.code = String(anyErr.code ?? "INTERNAL");
	if (opts.includeMessages && typeof anyErr?.message === "string") record.message = anyErr.message;
	if (opts.includeStacks && typeof anyErr?.stack === "string") record.stack = anyErr.stack;
	return record;
};
/**
* Mints a correlation id. `crypto.randomUUID` is global from Node 19 and in
* every edge runtime; it is truncated to 16 hex characters because the id goes
* in a header and a log line, not in something a human has to read.
*/
const newDispatchId = () => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
/** Derives the outcome from a status, so the two cannot disagree. */
const outcomeForStatus = (status) => status >= 500 ? "server-error" : status >= 400 ? "client-error" : "ok";
/**
* Builds the emitter an adapter calls at the end of a dispatch.
*
* With no `onDispatch` this returns `undefined` and the adapter skips the whole
* thing — which is also why the correlation id appears on failure responses
* *only* when a hook is registered: with nobody collecting, a new field in the
* error body would be a change to the wire contract for no benefit.
*
* A throwing hook is swallowed. A logging facility that takes down the request
* it is describing would be a strictly worse system than one that loses a
* record.
*/
const createDispatcher = (onDispatch) => {
	if (!onDispatch) return void 0;
	const includeMessages = process.env.NODE_ENV !== "production";
	const includeStacks = process.env.NODE_ENV !== "production";
	return (facts) => {
		const ctx = {
			id: facts.id ?? newDispatchId(),
			prefix: facts.prefix,
			functionName: facts.functionName ?? "",
			registeredNames: facts.registeredNames ?? [],
			originTier: facts.originTier,
			method: facts.method,
			declaredMethod: facts.declaredMethod,
			declaredContentType: facts.declaredContentType,
			actualContentType: facts.actualContentType,
			contentTypeMatched: facts.contentTypeMatched,
			argShape: argsShape(facts.args ?? []),
			status: facts.status,
			outcome: outcomeForStatus(facts.status),
			durationMs: Date.now() - facts.startedAt,
			...facts.error === void 0 ? {} : { error: describeError(facts.error, {
				includeMessages,
				includeStacks
			}) }
		};
		try {
			const result = onDispatch(ctx);
			if (result && typeof result.catch === "function") result.catch(() => {});
		} catch {}
	};
};
/**
* Wraps an adapter's dispatch body so every exit path is observed.
*
* The reason this is a helper rather than a pattern copied four times: the four
* adapters report through three different mechanisms, and a rule duplicated
* across them is a rule that agrees with itself until someone edits one. The
* facts are supplied, the record is assembled in one place, and an adapter only
* has to say how to read its own status.
*
* With no `emit` this is close to a pass-through, which is what keeps the
* correlation id — and the whole feature — off the default path.
*/
const dispatchRequest = async ({ emit, prefix, method, readStatus, withId, onStart, run }) => {
	if (!emit) return await run({
		status: 200,
		originTier: "headerless"
	});
	const tag = withId ?? ((result, id) => typeof result === "object" && result !== null ? {
		...result,
		id
	} : result);
	const startedAt = Date.now();
	const id = newDispatchId();
	onStart?.(id);
	const seen = {
		status: 200,
		originTier: "headerless"
	};
	try {
		const result = await run(seen);
		const status = readStatus(result);
		seen.status = status;
		if (status >= 400) return await tag(result, id);
		return result;
	} catch (err) {
		seen.error = err;
		seen.status = readStatus(void 0);
		throw err;
	} finally {
		emit({
			id,
			prefix,
			originTier: seen.originTier,
			method: method(),
			functionName: seen.functionName,
			registeredNames: seen.registered,
			declaredMethod: seen.declaredMethod,
			declaredContentType: seen.declaredContentType,
			actualContentType: seen.actualContentType,
			contentTypeMatched: seen.contentTypeMatched,
			args: seen.args,
			status: seen.status,
			error: seen.error,
			startedAt
		});
	}
};
/**
* Merges the correlation id into a `Response` body.
*
* Only hono needs this: it returns a `Response` rather than writing the body
* anywhere the adapter owns, so by the time the id is known the body is already
* serialised. Extracted here so the rules — never read a body twice, never
* re-serialise a non-JSON or non-object one — are asserted once instead of
* living inside an adapter closure.
*/
const tagResponseId = async (result, id) => {
	if (!(result instanceof Response)) return result;
	let parsed;
	try {
		parsed = JSON.parse(await result.clone().text());
	} catch {
		return result;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
	return new Response(JSON.stringify({
		...parsed,
		id
	}), {
		status: result.status,
		headers: result.headers
	});
};
/**
* The status a `Response`-returning dispatch settled on.
*
* hono is the only adapter that needs this — it returns a `Response` rather than
* writing the body anywhere the adapter owns — and the fallback covers the one
* path that returns nothing at all: the prefix gate, which the outer
* `createMiddleware` has already rejected by the time it is reached.
*/
const responseStatus = (result) => result instanceof Response ? result.status : 200;
/**
* Merges the correlation id into a failure **body** an adapter owns — koa's
* `ctx.body` and fastify's `reply.send()` argument, neither of which comes back
* as the handler's return value.
*
* Arrays and scalars are returned untouched: `{ ...[1, 2] }` is
* `{ 0: 1, 1: 2 }`, so spreading one would replace a JSON array failure body
* with an object wearing its indices. Every adapter's failure body is a plain
* object today, so the guard is there for the day one is not.
*/
const tagBodyId = (body, id) => body && typeof body === "object" && !Array.isArray(body) ? {
	...body,
	id
} : body;
//#endregion
//#region src/body.ts
/**
* Classifies a raw `Content-Type` header into one of the four parsing branches.
*
* The three structural branches are mutually exclusive for any real media type,
* so the precedence here is arbitrary among them; what matters is that
* `multipart/form-data` is tested before `json`, since a multipart boundary
* parameter is attacker-influenced text that can contain the substring "json".
*
* This uses substring tests, not exact base-type equality, and that is
* deliberate: it preserves the long-standing behaviour where a vendor media type
* like `application/vnd.api+json` is treated as JSON. It does mean this is *not*
* the same rule as {@link hasContentTypeMismatch}, which compares exact
* base types. The two disagree only for vendor `+json` types, and reconciling
* them is a behaviour change rather than a refactor.
* @param declared - The raw `Content-Type` request header, if present
* @returns The parsing branch this body belongs to
*/
const bodyKind = (declared) => {
	const type = declared?.toLowerCase() ?? "";
	if (type.includes("multipart/form-data")) return "multipart";
	if (type.includes("urlencoded")) return "urlencoded";
	if (type.includes("json")) return "json";
	return "text";
};
//#endregion
//#region src/form-flash.ts
/**
* The query parameter the flash rides in.
*
* Double-underscored so it cannot collide with a field the author submitted.
*/
const FLASH_PARAM = "__flash";
/**
* The largest serialized flash rpc will put in a URL: 4 KiB.
*
* A bound on size, not on confidentiality — the confidentiality rule is
* structural, in `pickReplayable`. Past this the flash is dropped rather than
* truncated, so the redirect still happens and the form re-renders empty instead
* of the user receiving a URL nothing will tolerate.
*
* 4 KiB rather than 8 because the flash URL is then **requested by the browser**,
* so it lands in a request line. nginx's default `large_client_header_buffers 4 8k`
* requires the request line to fit in a single 8 KiB buffer, so a flash at 8 KiB
* plus a base path and query exceeds it and the user gets a `414` instead of
* their form. Half that leaves headroom under the common proxy ceiling.
*
* The realistic case is far smaller — a message and a few field paths is a few
* hundred bytes, and twenty fields with generous hints is around 2 KiB — so this
* costs nothing in practice.
*/
const FLASH_LIMIT = 4096;
/**
* Serialises a flash for the query string.
*
* @param flash - The flash to serialise
* @returns The JSON payload, or `null` when it exceeds {@link FLASH_LIMIT}
*/
const encodeFormFlash = (flash) => {
	const json = JSON.stringify(flash);
	return new TextEncoder().encode(json).length > 4096 ? null : json;
};
/**
* Parses a flash back out of a query string, for SSR to replay it and for the
* client to rehydrate from.
*
* Total by design: anything unparseable is `null` rather than a throw, because
* this runs during a page render and a malformed query parameter is not a good
* reason a page fails to render. A parsed object is also checked for the flash's
* container shapes before it is trusted as a `FormFlash`.
*
* That check is structural, not a substitute for treating URL input as untrusted:
* callers must still whitelist the fields they render and escape the strings
* they emit.
*
* @param raw - The raw parameter value, or `undefined` when absent
* @returns The flash, or `null` when absent, malformed, or structurally invalid
*/
const decodeFormFlash = (raw) => {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const candidate = parsed;
		if (candidate.errors !== void 0) {
			if (typeof candidate.errors !== "object" || candidate.errors === null || Array.isArray(candidate.errors)) return null;
			for (const messages of Object.values(candidate.errors)) if (!Array.isArray(messages) || !messages.every((message) => typeof message === "string")) return null;
		}
		if (candidate.values !== void 0 && (typeof candidate.values !== "object" || candidate.values === null || Array.isArray(candidate.values))) return null;
		if (candidate.message !== void 0 && typeof candidate.message !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
};
//#endregion
//#region src/form-fallback.ts
/**
* @module The pieces of the no-JS form fallback that are mechanism rather than
* application knowledge: detecting a native form navigation, and making a
* redirect target safe.
*
* Both are exported so that a framework built on rpc — or anyone composing the
* fallback by hand — uses the same rules instead of re-deriving them. That is
* not hypothetical: the cross-origin gap this module exists alongside came from
* every project writing its own fallback and none of them reading the request's
* `Origin`.
*
* Server-only. Never import from client code.
*/
/**
* Whether a request is a native form submission rather than an RPC call.
*
* **The discriminator is the navigation, not the content type.** A form-declared
* function is called by two different clients that both send a form content
* type: a native `<form>` posts `application/x-www-form-urlencoded`, and the
* generated client stub posts `multipart/form-data` via `fetch`. Keying on
* content type alone cannot tell them apart, and a fallback that did would hand
* every browser-side caller a `303` where it expected a rejection — breaking
* `data` promise rejection, `fieldErrors`, and the stub's error handling for any
* form-declared function.
*
* So the rule is: `POST`, plus a form content type — which keeps an
* `Accept: text/html` fetch out of the form path — and then, where fetch
* metadata is present, `Sec-Fetch-Dest`/`Sec-Fetch-Mode` decide: a navigation is
* a document request and a `fetch` is not, whatever `Accept` claims. Only when
* both metadata headers are absent does `Accept` decide, by requiring
* `text/html`. A browser navigation sends `text/html`; `fetch` does not by
* default, and its wildcard `Accept` is not enough.
*
* Unlike the reference implementation in `bart-js`, `multipart/form-data` *is*
* accepted here, because a native `<form enctype="multipart/form-data">` is a
* real navigation and the file-upload case is the reason that content type
* exists. The navigation gate is what keeps `fetch` out, and it does not depend
* on which form encoding arrived.
*
* @param request - Method, raw content-type/accept headers, and optional fetch-metadata headers
* @returns `true` when this is a native form submission
*/
const isNativeFormNavigation = (request) => {
	if (request.method?.toUpperCase() !== "POST") return false;
	if (request.secFetchDest !== void 0 || request.secFetchMode !== void 0) {
		const dest = request.secFetchDest?.toLowerCase();
		const mode = request.secFetchMode?.toLowerCase();
		if (!((dest === void 0 || dest === "document") && (mode === void 0 || mode === "navigate"))) return false;
	} else if (!request.accept?.toLowerCase().includes("text/html")) return false;
	const kind = bodyKind(request.contentType);
	return kind === "multipart" || kind === "urlencoded";
};
/**
* The fallback used whenever a redirect target cannot be trusted.
*
* A root-relative path rather than a bare `/`, so it is always unambiguous.
*/
const REDIRECT_FALLBACK = "/";
/**
/**
* Whether a string contains a C0 control character or DEL.
*
* Written as an explicit codepoint scan rather than a regex with a control-
* character class, so the intent is visible without a lint suppression, and so
* the rule is the same one a reader would write.
*
* @param value - The string to scan
* @returns `true` when any character is a control character
*/
const hasControlCharacter = (value) => {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 31 || code === 127) return true;
	}
	return false;
};
/**
* Makes a redirect target safe to send a browser to.
*
* Post/Redirect/Get needs somewhere to go, and the two obvious sources are both
* attacker-influenceable: a hidden `__redirect` field, which whoever renders the
* form chooses, and the `Referer` header, which is stripped from native form
* POSTs often enough that projects reach for it anyway. Redirecting to either
* unchecked is an open redirect — `//evil.test` and `javascript:` being the
* payloads that matter.
*
* The policy is an **allowlist of shape**, not a denylist of schemes: a target
* must be an absolute, root-relative path, which rejects `javascript:`,
* `data:`, `vbscript:`, protocol-relative `//host` and absolute `http://host` in
* one step. Denylists lose to obfuscation (`java&#9;script:`) more often than an
* allowlist loses to a missing case, so the scheme is never parsed as a scheme.
* The origin check afterwards is then belt-and-braces rather than the defence.
*
* The fragment is preserved — it never reaches the server, and dropping it loses
* the scroll position the author was aiming at. The query is preserved because it
* is where a flash payload rides.
*
* @param target - The raw redirect target, from wherever the caller obtained it
* @param base - The absolute URL of the current request, used to resolve and to
*   compare origins
* @returns A same-origin path, or `/` when the target cannot be trusted
*/
const sanitizeRedirect = (target, base) => {
	if (typeof target !== "string") return REDIRECT_FALLBACK;
	const trimmed = target.trim();
	if (!trimmed) return REDIRECT_FALLBACK;
	if (hasControlCharacter(trimmed)) return REDIRECT_FALLBACK;
	if (!trimmed.startsWith("/")) return REDIRECT_FALLBACK;
	if (trimmed.includes("\\")) return REDIRECT_FALLBACK;
	try {
		const baseUrl = new URL(base);
		const resolved = new URL(trimmed, baseUrl);
		if (resolved.origin !== baseUrl.origin) return REDIRECT_FALLBACK;
		return `${resolved.pathname}${resolved.search}${resolved.hash}`;
	} catch {
		return REDIRECT_FALLBACK;
	}
};
/**
* Normalises the authored `fallback` option: `undefined` stays `undefined`, a
* bare string is shorthand for "this path, replay nothing", and an object is
* taken apart.
*
* The `replay` array is **copied and frozen**. It is consulted at dispatch time,
* on every request, from the author's object — so without the copy a caller that
* pushed to the array after registration would silently change the replay policy
* of a function that is already serving traffic. Freezing the copy also makes an
* accidental later write fail loudly instead of being ignored.
*/
function resolveFallback(fallback) {
	if (fallback === void 0) return void 0;
	if (typeof fallback === "string") return {
		to: fallback,
		replay: Object.freeze([])
	};
	const { to, replay } = fallback;
	if (typeof to !== "string" && typeof to !== "function") throw new TypeError("rpc: `fallback.to` must be a string path or a function returning one.");
	return {
		to,
		replay: replay === void 0 ? Object.freeze([]) : Object.freeze([...replay])
	};
}
/**
* Reduces a thrown value to a flash, or `null` when it must not become one.
*
* `null` for anything that is not an `RPCError`, and that is the important case:
* an unexpected exception is a server fault and stays a `500`. Flashifying one
* would both hide it and write its message into a URL, which is the opposite of
* what an author wants when something genuinely broke.
*
* Cross-bundle safe: the test is {@link isRPCError}'s registered-symbol brand,
* not `instanceof`, because each tsdown entry carries its own copy of the class.
*
* @param err - The value the handler threw
* @returns A flash, or `null` when the value must not be redirected past
*/
const flashFromError = (err) => {
	if (!isRPCError(err)) return null;
	const flash = {};
	const issues = err.issues;
	if (issues && issues.length > 0) {
		const grouped = {};
		for (const issue of issues) {
			const text = issue.message ?? issue.hint;
			if (text === void 0) continue;
			(grouped[issue.path ?? ""] ??= []).push(text);
		}
		flash.errors = grouped;
	}
	flash.message = err.hint ?? err.message;
	return flash;
};
/**
* Selects the submitted fields that may be replayed into the redirect URL.
*
* An explicit allowlist, defaulting to nothing. "Replay everything except the
* obvious secrets" is not implementable — rpc cannot know which of your fields
* are tokens, and a field named `note` is as likely to be one as a field named
* `password`. Naming the fields is a sentence the author has to write, which is
* the point.
*
* @param fields - The submitted fields
* @param allowed - Field names permitted in the redirect URL; empty means none
* @returns Only the permitted fields, and only ones that are primitive
*/
const pickReplayable = (fields, allowed = []) => {
	const out = {};
	if (fields === null || typeof fields !== "object") return out;
	const record = fields;
	for (const key of allowed) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
	}
	return out;
};
/**
* Builds the Post/Redirect/Get target for a failed native form submission.
*
* The target is sanitized, so a caller that passes a field-controlled value
* cannot turn this into an open redirect. A flash that will not fit is dropped
* rather than truncated — see {@link FLASH_LIMIT}.
*
* @param target - Where to send the browser; treated as untrusted
* @param flash - The outcome to carry, or `null` to redirect without one
* @param base - Absolute resolution base, defaulting to the inert localhost origin. A request URL is not needed because the emitted target is same-origin `pathname + search`.
* @returns A same-origin URL, safe to put in a `Location` header
*/
const flashRedirectUrl = (target, flash, base) => {
	const safe = sanitizeRedirect(target, base);
	if (!flash) return safe;
	const encoded = encodeFormFlash(flash);
	if (encoded === null) return safe;
	const url = new URL(safe, base);
	url.searchParams.set(FLASH_PARAM, encoded);
	return `${url.pathname}${url.search}`;
};
/**
* An inert origin used to resolve a root-relative redirect target.
*
* `sanitizeRedirect` needs an absolute base to resolve against, and compares
* origins to reject protocol-relative targets like `//evil.test`. The host in
* that base is therefore *only* ever used as a comparison key: results are
* emitted as `pathname + search + hash`, so it can never appear in a
* `Location`.
*
* A constant is better than the request's own host here. `Host` is
* attacker-influenceable, and feeding it into a redirect decision would make the
* safety of the result depend on a header the caller controls — while buying
* nothing, since every target is required to be root-relative.
*/
const REDIRECT_BASE = "http://localhost/";
/**
* The `Location` for a native form submission that **failed**, or `undefined`
* when this request is not one.
*
* `undefined` is the important return, and it covers four distinct reasons, each
* of which must fall through to the adapter's normal handling rather than being
* redirected:
*
* - the function has no `fallback` configured — the feature is opt-in;
* - the request is not a native form navigation — including every `fetch` from
*   the generated stub, which must keep getting its JSON;
* - the error is not client-facing, so it is a genuine fault and stays a `500`.
*   A stack trace must never be laundered into a friendly redirect;
* - the author's `to` threw or returned a non-string.
*
* A target that is merely *unsafe* is not in this list: it still redirects, to
* the sanitiser's same-origin fallback. See {@link redirectFor}.
*
* Adapters call this **ahead of** their client-error branch. That is the whole
* point of it living here rather than at the validation call site: a
* `ValidationError` is a *client-facing* error, so the branch that renders it as
* a `422` JSON body would otherwise claim it first, and a rejected submission —
* the case the entire feature exists for — would reach the browser as raw JSON.
*/
const formFallbackLocation = (err, fallback, submitted, request, base = REDIRECT_BASE) => {
	const resolved = resolveFallback(fallback);
	if (!resolved) return void 0;
	if (!isNativeFormNavigation(request)) return void 0;
	const flash = flashFromError(err);
	if (!flash) return void 0;
	return redirectFor(resolved, {
		status: "error",
		...flash
	}, submitted, base);
};
/**
* The `Location` for a native form submission that **succeeded**, or
* `undefined` when this request is not one.
*
* Success carries no flash — there is no failure to report — so the redirect is
* just the author's target. `replay` still applies, because an author who wants
* to show what was submitted ("we emailed bob@example.com") can name it, and
* naming is the whole consent mechanism.
*/
const formSuccessLocation = (fallback, submitted, request, base = REDIRECT_BASE) => {
	const resolved = resolveFallback(fallback);
	if (!resolved) return void 0;
	if (!isNativeFormNavigation(request)) return void 0;
	return redirectFor(resolved, { status: "ok" }, submitted, base);
};
/** Shared tail: pick the target, attach the replayed values, make it safe. */
const redirectFor = (resolved, outcome, submitted, base) => {
	let target;
	try {
		target = typeof resolved.to === "function" ? resolved.to(outcome) : resolved.to;
	} catch {
		return;
	}
	if (typeof target !== "string") return void 0;
	const replayed = pickReplayable(submitted, resolved.replay);
	const hasValues = Object.keys(replayed).length > 0;
	const flash = hasValues ? {
		...outcome,
		values: replayed
	} : { ...outcome };
	const payload = flash.errors !== void 0 || flash.message !== void 0 || hasValues ? flash : null;
	return flashRedirectUrl(target, payload, base);
};
//#endregion
export { ConflictError, FLASH_LIMIT, FLASH_PARAM, ForbiddenError, NotFoundError, RPCError, RPC_ERROR_BRAND, ValidationError, argShape, argsShape, array, clientErrorMessage, clientErrorStatus, createDispatcher, createServerFunction, decodeFormFlash, defaultMiddlewareOptions, defaultPrefix, defaultRPCOptions, defaultServerFnOptions, describeError, describeOriginRequest, dispatchRequest, encodeFormFlash, escapeRegExp, field, flashFromError, flashRedirectUrl, formFallbackLocation, formSuccessLocation, formatError, getClientModules, getFunctionsForPrefix, getGlobalPrefix, getRequestContext, getRequestMeta, hasContentTypeMismatch, httpError, isClientHttpError, isFormContentType, isNativeFormNavigation, isOriginAllowed, isOriginRequestAllowed, isRPCError, isSelfOrigin, newDispatchId, nullable, optional, outcomeForStatus, pickReplayable, provideRequestContext, record, redirect, resolveFallback, resolveRPCPrefix, responseStatus, runValidation, safeURL, sanitizeRedirect, scanForServerFiles, scannedServerFiles, schema, sendResponse, serverFunctionsByPrefix, serverFunctionsMap, setGlobalPrefix, tagBodyId, tagResponseId, validationErrorBody, walkGlobFiles };

//# sourceMappingURL=server.mjs.map