import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { clientErrorStatus, describeOriginRequest, escapeRegExp, formatError, hasContentTypeMismatch, isClientHttpError, provideRequestContext, resolveRPCPrefix, runValidation, safeURL, scanForServerFiles } from "@thednp/rpc/server";
import { Buffer } from "node:buffer";
//#region src/constants.ts
/** Body of a 404. Deliberately does not name the requested function. */
const FUNCTION_NOT_FOUND = "Function not found";
/** Body of a 405, returned when the HTTP method does not match the function's declared method. */
const METHOD_NOT_ALLOWED = "Method Not Allowed";
/** Body of a 403, returned when the optional origin allowlist rejects the request. */
const REQUEST_FORBIDDEN = "Forbidden";
/** Body of a 415, returned when the request's `Content-Type` does not satisfy the function's declared `contentType`. */
const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";
/** Body of a 413, returned when the request body exceeds rpc's own streaming size limit. */
const PAYLOAD_TOO_LARGE = "Payload Too Large";
/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
const BAD_REQUEST = "Bad Request";
/** Abort reason used when the client disconnects mid-dispatch. */
const CLIENT_DISCONNECTED = "client disconnected";
/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
const MIDDLEWARE_NAME_USED = (name) => `The middleware name "${name}" is already used.`;
/**
* A function-wide pointer appended to every validation failure.
*
* Dev-only, like the per-field hints, so production bodies stay a fixed shape.
* This was previously copy-pasted into all five adapters; one definition means
* one place to change the doc link.
*/
const VALIDATION_HINT = "input did not match the function's schema; see wiki/server-functions.md#input-validation";
//#endregion
//#region src/options.ts
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
	bodyLimit: 10485760
};
//#endregion
//#region src/server-helpers.ts
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
const isClientHttpError$1 = (err) => readClientStatus(err) !== void 0;
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
/**
* The lenient sniff for a body with no usable `Content-Type`.
*
* Deliberate, and the reason a `curl` command or the no-JS `<form>` fallback
* that sends JSON without declaring it still arrives parsed rather than as a
* string. Contrast with a *declared* JSON body, which is parsed strictly and
* answers `400` when it does not parse.
* @param raw - The raw body text
* @returns The parsed JSON value, or the original string
*/
const parseSniffedText = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};
/**
* Applies the full parsing policy to a raw body string.
*
* This is the single implementation of the branching that used to exist five
* times over. Only a **declared** JSON body is parsed strictly — a malformed one
* throws {@link httpError} `400` rather than being "recovered" into a
* `text/plain` string, which used to hand a JSON-declared function a string and
* answer `200` on malformed input.
* @param raw - The raw body text
* @param declared - The raw `Content-Type` request header, if present
* @returns The normalized body result
* @throws An `httpError` with status `400` when a declared JSON body does not parse
*/
const parseRawBody = (raw, declared) => {
	switch (bodyKind(declared)) {
		case "multipart": return {
			contentType: "multipart/form-data",
			data: { raw }
		};
		case "urlencoded": return {
			contentType: "application/x-www-form-urlencoded",
			data: Object.fromEntries(new URLSearchParams(raw))
		};
		case "json": {
			let data;
			try {
				data = JSON.parse(raw);
			} catch {
				throw httpError(400, "Invalid JSON body");
			}
			return {
				contentType: "application/json",
				data
			};
		}
		default: return {
			contentType: "text/plain",
			data: parseSniffedText(raw)
		};
	}
};
/**
* Applies the same policy to a body the host framework's own parser already
* decoded, which is the fast path available to Express, Fastify, Koa, and Hono
* under `@hono/node-server`.
*
* Note the two differences from {@link parseRawBody}, both inherent to
* pre-decoding: multipart data is passed through as-is rather than wrapped in
* `{ raw }`, and the `text` branch stringifies rather than sniffing, because
* there is no raw text left to sniff once a parser has claimed the body.
* @param body - The already-decoded body
* @param declared - The raw `Content-Type` request header, if present
* @returns The normalized body result
*/
const preParsedBody = (body, declared) => {
	switch (bodyKind(declared)) {
		case "multipart": return {
			contentType: "multipart/form-data",
			data: body
		};
		case "urlencoded": return {
			contentType: "application/x-www-form-urlencoded",
			data: body
		};
		case "json": return {
			contentType: "application/json",
			data: body
		};
		default: return {
			contentType: "text/plain",
			data: String(body)
		};
	}
};
const capIsActive = (limit) => limit > 0 && Number.isFinite(limit);
/**
* Reads a Web-standard `Request` body under a byte cap, then applies the shared
* parsing policy.
*
* This exists because a `Content-Length` pre-check is close to worthless on these
* runtimes, and that was measured rather than assumed. A `Request` constructed in
* JavaScript — which is how a request arrives under `app.fetch()`, and on
* Workers, Bun, Deno, and most serverless adapters — does **not** carry a
* `Content-Length` header; that is added by the HTTP layer when serialising, and
* it is absent entirely for a chunked request. A 12 MB body against a 1 MiB
* `bodyLimit` returned `200` through the pre-check alone.
*
* So the cap is enforced against the bytes as they arrive, from the same
* `ReadableStream` the framework would have read. Nothing past the limit is
* retained, and the reader is cancelled at the verdict so the upload stops
* rather than being drained forever.
*
* If the body has already been consumed by a framework body-limit middleware,
* `bodyUsed` is true and there is nothing left to measure, so this defers to
* `text()` and that middleware's limit is the operative one.
* @param request - The request whose body should be read
* @param declared - The raw `Content-Type` request header, if present
* @param options - The byte cap
* @returns The normalized body result
* @throws An `httpError` with status `413` when the body exceeds the cap, or `400` when a declared JSON body does not parse
*/
const readWebBody = async (request, declared, options = {}) => {
	const limit = options.limit ?? 10485760;
	if (!request.body || request.bodyUsed) return parseRawBody(await request.text(), declared);
	const reader = request.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (capIsActive(limit) && size > limit) {
				chunks.length = 0;
				await reader.cancel();
				throw httpError(413, PAYLOAD_TOO_LARGE);
			}
			chunks.push(value);
		}
	} catch (err) {
		if (isClientHttpError$1(err)) throw err;
		await reader.cancel().catch(() => {});
		throw err;
	} finally {
		reader.releaseLock();
	}
	return parseRawBody(Buffer.concat(chunks).toString(), declared);
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
* Serialises a flash for the query string.
*
* @param flash - The flash to serialise
* @returns The JSON payload, or `null` when it exceeds {@link FLASH_LIMIT}
*/
const encodeFormFlash = (flash) => {
	const json = JSON.stringify(flash);
	return new TextEncoder().encode(json).length > 4096 ? null : json;
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
//#region src/hono/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to a Hono app.
* Dynamically imports loadRPCConfig and registers the middleware.
* @param app - Hono application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const options = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to a Hono app for development mode.
* Uses the viteMiddleware wrapper to bridge Vite's Connect-compatible stack into Hono.
* @param app - Hono application instance
* @param vite - Running Vite dev server
*/
const attachVite = (app, vite) => {
	app.use(viteMiddleware(vite));
};
/**
* Creates a Hono-compatible middleware from a Vite dev server middleware stack.
* Bridges the Connect/Express middleware interface to Hono's context-based request/response model.
* Supports both Node.js and Bun runtimes with separate polyfill paths.
* @param vite - Running Vite dev server
* @returns A Hono middleware function
* @see https:github.com/honojs/hono/issues/3162#issuecomment-2331118049
*/
const viteMiddleware = (vite) => {
	return createMiddleware$1((c, next) => {
		return new Promise((resolve) => {
			if (typeof Bun === "undefined") {
				if (!c.env) {
					resolve(next());
					return;
				}
				vite.middlewares(c.env.incoming, c.env.outgoing, () => resolve(next()));
				return;
			}
			{
				let sent = false;
				const headers = new Headers();
				vite.middlewares({
					url: new URL(c.req.path, "http:localhost").pathname,
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
/**
* Reads and parses the HTTP request body from a Hono context.
*
* Two paths, in order. A body some earlier layer has already buffered takes the
* pre-parsed path; anything still on the wire takes {@link readWebBody}, which is
* the same capped read h3 uses. JSON is not special-cased — see below.
*
* @param c - Hono request context
* @param limit - byte cap enforced while the body streams
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = async (c, limit) => {
	const declared = c.req.header("content-type");
	const incoming = c.env?.incoming;
	if (incoming?.body !== void 0) return preParsedBody(incoming.body, declared);
	const cache = c.req.bodyCache;
	for (const key of Object.keys(cache ?? {})) {
		const cached = await cache[key];
		if (typeof cached === "string") return parseRawBody(cached, declared);
		return preParsedBody(cached, declared);
	}
	return readWebBody(c.req.raw, declared, { limit });
};
/**
* Issues an HTTP redirect on a Hono context. Hono's `c.redirect(location,
* status)` returns a `Response` object that the handler must return (it never
* writes directly). Defaults to `303 See Other` for convention
* (Post/Redirect/Get).
* @param c - Hono context
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
* @returns A Hono `Response` to return from the handler
*/
const redirect = (c, location, status = 303) => {
	return c.redirect(location, status);
};
//#endregion
//#region src/hono/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates a Hono middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
* Uses Hono's factory `createMiddleware` to wrap the handler.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns A Hono middleware function
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
	const resolvedPrefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = rpcPrefix ? new RegExp(`^/${escapeRegExp(resolvedPrefix)}/`) : null;
	const pathMatcher = path ? typeof path === "string" ? new RegExp(path) : path : null;
	const middlewareHandler = createMiddleware$1(async (c, next) => {
		const url = safeURL(c.req.path).pathname;
		if (!handler) return next();
		if (pathMatcher && !pathMatcher.test(url)) return next();
		if (prefixRegex && !prefixRegex.test(url)) return next();
		if (getFunctionsForPrefix(resolvedPrefix).size === 0) await scanForServerFiles({
			rpcPrefix: resolvedPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
		return await handler(c, next);
	});
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Hono RPC middleware that routes incoming requests to registered server functions.
* Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
* to the matching function, and returns the JSON-serialized result.
* @param initialOptions - Options including rpcPrefix for URL routing
* @returns A Hono middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
	const prefixReplace = `/${prefix}/`;
	const emit = createDispatcher(options.onDispatch);
	return createMiddleware({
		...options,
		rpcPrefix: prefix,
		handler: async (c, _next) => await dispatchRequest({
			emit,
			prefix,
			method: () => c.req.method,
			readStatus: responseStatus,
			withId: tagResponseId,
			run: async (seen) => {
				const { path: reqPath } = c.req;
				if (prefixRegex && !prefixRegex.test(reqPath)) return;
				const origin = describeOriginRequest({
					allowed: options.origin,
					origin: c.req.header("origin"),
					site: c.req.header("sec-fetch-site"),
					host: c.req.header("host"),
					allowHeaderless: options.allowHeaderless
				});
				seen.originTier = origin.tier;
				if (!origin.allowed) return c.json({ error: REQUEST_FORBIDDEN }, 403);
				const functionName = reqPath.replace(prefixReplace, "");
				const forPrefix = getFunctionsForPrefix(prefix);
				const serverFunction = forPrefix.get(functionName);
				if (emit) {
					seen.functionName = functionName;
					seen.registered = [...forPrefix.keys()];
					seen.actualContentType = c.req.header("content-type");
				}
				if (!serverFunction) return c.json({ error: FUNCTION_NOT_FOUND }, 404);
				let args = [];
				try {
					const method = serverFunction.options?.method || "POST";
					if (emit) {
						seen.declaredMethod = method;
						seen.declaredContentType = serverFunction.options?.contentType ?? "application/json";
						seen.contentTypeMatched = !hasContentTypeMismatch(seen.declaredContentType, c.req.header("content-type"));
					}
					if (c.req.method.toUpperCase() !== method) return c.json({ error: METHOD_NOT_ALLOWED }, 405);
					if (method === "GET") {
						const raw = c.req.query("args");
						if (raw) {
							let parsed;
							try {
								parsed = JSON.parse(raw);
							} catch {
								return c.json({ error: BAD_REQUEST }, 400);
							}
							if (!Array.isArray(parsed)) return c.json({ error: BAD_REQUEST }, 400);
							args = parsed;
						}
					} else {
						if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", c.req.header("content-type"))) return c.json({ error: UNSUPPORTED_MEDIA_TYPE }, 415);
						const body = await readBody(c, options.bodyLimit);
						args = Array.isArray(body.data) ? body.data : [body.data];
					}
					const requestEvent = {
						request: c.req,
						response: c.res,
						nativeEvent: c,
						locals: {},
						functionName,
						redirect: (location, status = 303) => {
							requestEvent.redirected = {
								location,
								status
							};
						},
						send: (status, body, headers) => {
							requestEvent.sent = {
								status,
								body,
								headers
							};
						},
						header: (name, value) => {
							if (typeof value === "string") {
								c.header(name, value);
								return;
							}
							if (value.length === 0) return;
							c.header(name, value[0]);
							for (const v of value.slice(1)) c.header(name, v, { append: true });
						}
					};
					const schema = serverFunction.options?.schema;
					if (schema) {
						const checked = await runValidation(schema, args[0], {
							hints: serverFunction.options?.hints,
							hint: serverFunction.options?.hint ? `${serverFunction.options.hint} — ${VALIDATION_HINT}` : VALIDATION_HINT
						});
						if (!checked.ok) throw checked.error;
						args = [checked.value];
					}
					const fnResult = provideRequestContext(requestEvent, () => {
						if (emit) seen.args = args;
						return serverFunction.handler(args[0]);
					});
					const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
					c.env?.incoming?.on("close", onAbort);
					const result = await fnResult.data;
					const successFlash = formSuccessLocation(serverFunction.options?.fallback, args[0], {
						method: c.req.method,
						contentType: c.req.header("content-type"),
						accept: c.req.header("accept"),
						secFetchDest: c.req.header("sec-fetch-dest"),
						secFetchMode: c.req.header("sec-fetch-mode")
					});
					if (successFlash !== void 0 && !requestEvent.redirected) requestEvent.redirected = {
						location: successFlash,
						status: 303
					};
					c.env?.incoming?.off("close", onAbort);
					if (requestEvent.redirected) return c.redirect(requestEvent.redirected.location, requestEvent.redirected.status);
					if (requestEvent.sent) {
						const { status, body, headers } = requestEvent.sent;
						return c.body(JSON.stringify(body), status, {
							"content-type": "application/json",
							...headers
						});
					}
					return c.json({ data: result }, 200);
				} catch (err) {
					const flash = formFallbackLocation(err, serverFunction.options?.fallback, args[0], {
						method: c.req.method,
						contentType: c.req.header("content-type"),
						accept: c.req.header("accept"),
						secFetchDest: c.req.header("sec-fetch-dest"),
						secFetchMode: c.req.header("sec-fetch-mode")
					});
					if (flash !== void 0) {
						seen.status = 303;
						return c.redirect(flash, 303);
					}
					seen.error = err;
					const isProduction = process.env.NODE_ENV === "production";
					if (isClientHttpError(err)) {
						const status = clientErrorStatus(err);
						return c.json(formatError(err, isProduction), status);
					}
					console.error(String(err));
					return c.json(formatError(err, isProduction), 500);
				}
			}
		})
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, redirect, viteMiddleware };

//# sourceMappingURL=hono.mjs.map