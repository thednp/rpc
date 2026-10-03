import { Buffer } from "node:buffer";
import { clientErrorStatus, describeOriginRequest, escapeRegExp, formatError, hasContentTypeMismatch, isClientHttpError, provideRequestContext, resolveRPCPrefix, runValidation, scanForServerFiles } from "@thednp/rpc/server";
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
/**
* The fixed base a raw request URL is resolved against.
*
* A request-target like `/\` makes the WHATWG parser throw, and the adapters
* build the URL before their dispatch `try` block, so the base has to be
* something that always parses and never matches a real prefix.
*/
const SAFE_URL_BASE = "http://localhost";
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
	bodyLimit: DEFAULT_BODY_LIMIT
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
* Reads a Node request stream under a byte cap, then applies the shared parsing
* policy to what was read.
*
* **The cap is enforced while streaming, never after buffering.** Chunks are
* measured as they arrive and nothing past the limit is retained, so an
* oversized body is never resident in memory — which is the entire point.
* Buffering first and measuring afterwards, the obvious `readBody`-then-check
* shape, provides no memory-exhaustion protection at all.
*
* Past the cap the remainder is **drained and discarded** rather than the socket
* being closed on the spot. Closing a socket that still has unread request data
* makes Node emit `RST`, and the client never learns the real reason it failed.
* The drain ceiling bounds that discard; past it the connection is cut, so a
* pathologically large upload sees a reset rather than a `413`, which is normal
* HTTP behaviour.
*
* This is the only place rpc can offer a *real* cap. Where a host framework
* parses the body itself the host's own limit applies, and where the body is
* read through a `Request`-style `.text()` (h3, Hono) no chunk callback exists —
* those paths get {@link assertBodyWithinLimit} instead, which is a
* `Content-Length` pre-check and therefore advisory.
* @param source - The Node readable carrying the request body
* @param declared - The raw `Content-Type` request header, if present
* @param options - The byte cap and drain ceiling
* @returns The normalized body result
* @throws An `httpError` with status `413` when the body exceeds the cap, or `400` when a declared JSON body does not parse
*/
const readStream = (source, declared, options = {}) => {
	const limit = options.limit ?? 10485760;
	const drainLimit = options.drainLimit ?? (capIsActive(limit) ? limit * 32 : Infinity);
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let drained = 0;
		let tooLarge = false;
		let settled = false;
		const tooLargeError = () => httpError(413, PAYLOAD_TOO_LARGE);
		const finish = (settle) => {
			if (settled) return;
			settled = true;
			source.off("data", onData);
			source.off("end", onEnd);
			source.off("error", onError);
			settle();
		};
		const onData = (chunk) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			drained += buf.length;
			if (tooLarge) {
				if (drained > drainLimit) finish(() => {
					source.destroy();
					reject(tooLargeError());
				});
				return;
			}
			size += buf.length;
			if (capIsActive(limit) && size > limit) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			chunks.push(buf);
		};
		const onEnd = () => {
			finish(() => {
				if (tooLarge) {
					reject(tooLargeError());
					return;
				}
				try {
					resolve(parseRawBody(Buffer.concat(chunks).toString(), declared));
				} catch (err) {
					reject(err);
				}
			});
		};
		const onError = (err) => finish(() => reject(err));
		source.on("data", onData);
		source.on("end", onEnd);
		source.on("error", onError);
	});
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
//#region src/express/helpers.ts
/**
* Convenience function to load RPC config and attach the RPC middleware to an Express app.
* Dynamically imports loadRPCConfig and creates the middleware with loaded options.
* @param app - Express application instance
*/
async function attachRPC(app) {
	const { loadRPCConfig } = await import("@thednp/rpc");
	const options = await loadRPCConfig();
	app.use(createRPCMiddleware(options));
}
/**
* Attaches Vite's dev server middlewares to an Express app for development mode.
* @param app - Express application instance
* @param vite - Running Vite dev server
*/
function attachVite(app, vite) {
	app.use(vite.middlewares);
}
/**
* Reads and parses the HTTP request body from an Express or Node IncomingMessage.
* If a body parser middleware (e.g. express.json()) already consumed the stream,
* uses the pre-parsed body from `req.body`.
* @param req - Express or Node.js IncomingMessage
* @param limit - Streamed byte cap; `0` disables it
* @returns A promise resolving to the parsed body with its content type
*/
const readBody = (req, limit) => {
	const declared = req.headers["content-type"];
	if (hasPreParsedBody(req) && req.body !== void 0) return Promise.resolve(preParsedBody(req.body, declared));
	return readStream(req, req.headers["content-type"], { limit });
};
/**
* Type guard that checks whether a request is an Express Request (has `originalUrl`).
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request is an Express Request
*/
const isExpressRequest = (req) => {
	return "originalUrl" in req;
};
/**
* Type guard that checks whether a response is an Express Response (has `json` and `send` methods).
* @param res - A Node ServerResponse or Express Response
* @returns True if the response is an Express Response
*/
const isExpressResponse = (res) => {
	return "json" in res && "send" in res;
};
/**
* Issues an HTTP redirect on an Express or raw Node ServerResponse.
* Uses Express's native `res.redirect(status, location)` when an Express
* Response is provided, otherwise writes the status code and `Location`
* header directly on the raw `ServerResponse` (safe for Connect-compatible
* middlewares and serverless adapters whose mock responses lack `.redirect`).
* Defaults to `303 See Other` for convention (Post/Redirect/Get).
* @param res - Express Response or raw Node ServerResponse
* @param location - The URL to redirect to
* @param status - HTTP status code, defaults to 303
*/
const redirect = (res, location, status = 303) => {
	if (isExpressResponse(res)) {
		res.redirect(status, location);
		return;
	}
	res.statusCode = status;
	res.setHeader("Location", location);
	res.end();
};
/**
* Type guard that checks whether a request has a pre-parsed body (`body` property).
* Used to detect if a body-parser middleware already consumed the stream.
* @param req - A Node IncomingMessage or Express Request
* @returns True if the request has a body property
*/
const hasPreParsedBody = (req) => {
	return "body" in req;
};
/**
* Extracts normalized request details from an Express or Node IncomingMessage.
* Parses the URL to extract pathname, search string, and search params.
* @param request - Express or Node.js request object
* @returns Normalized request details including URL, headers, and method
*/
const getRequestDetails = (request) => {
	const rawUrl = isExpressRequest(request) ? request.originalUrl : request.url;
	const url = safeURL(rawUrl);
	return {
		url: url.pathname,
		search: url.search,
		searchParams: url.searchParams,
		headers: request.headers,
		method: request.method
	};
};
/**
* Wraps an Express or Node ServerResponse with a uniform API for setting headers,
* status codes, and sending JSON responses. Handles the Express vs raw Node API differences.
* @param response - Express or Node.js server response object
* @returns A ResponseDetails object with setHeader, setStatusCode, and sendResponse helpers
*/
const getResponseDetails = (response) => {
	const isResponseSent = response.headersSent || response.writableEnded;
	const setHeader = (name, value) => {
		const outgoing = typeof value === "string" ? value : [...value];
		if (isExpressResponse(response)) response.header(name, outgoing);
		else response.setHeader(name, outgoing);
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
//#region src/express/createMiddleware.ts
let middlewareCount = 0;
const middlewareStack = /* @__PURE__ */ new Set();
/**
* Creates an Express middleware with optional path and rpcPrefix filtering.
* Middleware names are deduplicated — reusing a name throws an error.
* Prefix and path regexes are compiled once at creation time (hoisted) for performance.
* @param initialOptions - Options for rpcPrefix, path matching, and the handler function
* @returns An Express middleware function
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
	const middlewareHandler = async (req, res, next) => {
		const { url } = getRequestDetails(req);
		if (!handler) return next?.();
		if (pathMatcher && !pathMatcher.test(url)) return next?.();
		if (prefixRegex && !prefixRegex.test(url)) return next?.();
		if (getFunctionsForPrefix(resolvedPrefix).size === 0) await scanForServerFiles({
			rpcPrefix: resolvedPrefix,
			serverFiles: options.serverFiles,
			scanRoot: options.scanRoot
		});
		await handler(req, res, next);
	};
	Object.defineProperty(middlewareHandler, "name", { value: name });
	return middlewareHandler;
};
/**
* Creates the Express RPC middleware that routes incoming requests to registered server functions.
* Reads the request body, dispatches to the matching function via getFunctionsForPrefix,
* and sends the JSON-serialized result. Handles client disconnection via abort signals.
* Supports multi-prefix setups where different middleware instances can route to functions
* registered under different prefixes.
* @param initialOptions - Options including rpcPrefix for URL routing and prefix-scoped function lookup
* @returns An Express middleware function
*/
const createRPCMiddleware = (initialOptions = {}) => {
	const options = Object.assign({}, defaultMiddlewareOptions, initialOptions);
	const rpcPrefix = options.rpcPrefix;
	const prefix = resolveRPCPrefix(rpcPrefix);
	const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
	const prefixReplace = `/${prefix}/`;
	const dispatch = createDispatcher(options.onDispatch);
	return createMiddleware({
		...options,
		rpcPrefix: prefix,
		handler: async (req, res, _next) => {
			const { url: path, searchParams } = getRequestDetails(req);
			const { sendResponse: rawSend, setHeader } = getResponseDetails(res);
			const startedAt = Date.now();
			const callId = dispatch ? newDispatchId() : void 0;
			const seen = {
				status: 200,
				originTier: "headerless"
			};
			const record = () => {
				dispatch?.({
					id: callId,
					prefix,
					originTier: seen.originTier,
					method: req.method ?? "",
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
			};
			const sendResponse = (status, body) => {
				seen.status = status;
				rawSend(status, callId !== void 0 && status >= 400 ? {
					...body,
					id: callId
				} : body);
			};
			if (prefixRegex && !prefixRegex.test(path)) return;
			const origin = describeOriginRequest({
				allowed: options.origin,
				origin: req.headers.origin,
				site: req.headers["sec-fetch-site"],
				host: req.headers.host,
				allowHeaderless: options.allowHeaderless
			});
			seen.originTier = origin.tier;
			if (!origin.allowed) {
				sendResponse(403, { error: REQUEST_FORBIDDEN });
				record();
				return;
			}
			const functionName = path.replace(prefixReplace, "");
			const serverFunctionsForPrefix = getFunctionsForPrefix(prefix);
			const serverFunction = serverFunctionsForPrefix.get(functionName);
			if (dispatch) {
				seen.functionName = functionName;
				seen.registered = [...serverFunctionsForPrefix.keys()];
			}
			if (!serverFunction) {
				sendResponse(404, { error: FUNCTION_NOT_FOUND });
				record();
				return;
			}
			let args = [];
			try {
				const method = serverFunction.options?.method || "POST";
				if (dispatch) {
					seen.declaredMethod = method;
					seen.declaredContentType = serverFunction.options?.contentType ?? "application/json";
					seen.actualContentType = req.headers["content-type"];
					seen.contentTypeMatched = !hasContentTypeMismatch(seen.declaredContentType, req.headers["content-type"]);
				}
				if (req.method?.toUpperCase() !== method) {
					sendResponse(405, { error: METHOD_NOT_ALLOWED });
					return;
				}
				if (method === "GET") {
					const raw = searchParams.get("args");
					if (raw) {
						let parsed;
						try {
							parsed = JSON.parse(raw);
						} catch {
							sendResponse(400, { error: BAD_REQUEST });
							return;
						}
						if (!Array.isArray(parsed)) {
							sendResponse(400, { error: BAD_REQUEST });
							return;
						}
						args = parsed;
					}
				} else {
					if (hasContentTypeMismatch(serverFunction.options?.contentType ?? "application/json", req.headers["content-type"])) {
						sendResponse(415, { error: UNSUPPORTED_MEDIA_TYPE });
						return;
					}
					const body = await readBody(req, options.bodyLimit);
					args = Array.isArray(body.data) ? body.data : [body.data];
				}
				if (dispatch) seen.args = args;
				const schema = serverFunction.options?.schema;
				if (schema) {
					const checked = await runValidation(schema, args[0], {
						hints: serverFunction.options?.hints,
						hint: serverFunction.options?.hint ? `${serverFunction.options.hint} — ${VALIDATION_HINT}` : VALIDATION_HINT
					});
					if (!checked.ok) throw checked.error;
					args = [checked.value];
				}
				const requestEvent = {
					request: req,
					response: res,
					nativeEvent: {
						req,
						res
					},
					locals: res.locals ?? {},
					functionName,
					redirect: (location, status = 303) => {
						requestEvent.redirected = {
							location,
							status
						};
						redirect(res, location, status);
					},
					send: (status, body, headers) => {
						requestEvent.sent = {
							status,
							body,
							headers
						};
						const details = getResponseDetails(res);
						if (headers) for (const [name, value] of Object.entries(headers)) details.setHeader(name, value);
						details.sendResponse(status, body);
					},
					header: (name, value) => {
						if (res.headersSent) return;
						if (typeof value !== "string" && value.length === 0) return;
						setHeader(name, value);
					}
				};
				const { data, cancel } = provideRequestContext(requestEvent, () => serverFunction.handler(args[0]));
				const onClose = () => cancel(CLIENT_DISCONNECTED);
				req.on("close", onClose);
				const result = await data;
				req.off("close", onClose);
				const successDetails = getRequestDetails(req);
				const successFlash = formSuccessLocation(serverFunction.options?.fallback, args[0], {
					method: successDetails.method,
					contentType: successDetails.headers["content-type"],
					accept: successDetails.headers["accept"],
					secFetchDest: successDetails.headers["sec-fetch-dest"],
					secFetchMode: successDetails.headers["sec-fetch-mode"]
				});
				if (successFlash !== void 0 && !requestEvent.redirected) {
					requestEvent.redirected = {
						location: successFlash,
						status: 303
					};
					redirect(res, successFlash);
					return;
				}
				if (!requestEvent.redirected && !requestEvent.sent && !res.headersSent) sendResponse(200, { data: result });
			} catch (err) {
				const details = getRequestDetails(req);
				const flash = formFallbackLocation(err, serverFunction.options?.fallback, args[0], {
					method: details.method,
					contentType: details.headers["content-type"],
					accept: details.headers["accept"],
					secFetchDest: details.headers["sec-fetch-dest"],
					secFetchMode: details.headers["sec-fetch-mode"]
				});
				if (flash !== void 0) {
					seen.status = 303;
					redirect(res, flash);
					return;
				}
				const isProduction = process.env.NODE_ENV === "production";
				seen.error = err;
				if (isClientHttpError(err)) {
					sendResponse(clientErrorStatus(err), formatError(err, isProduction));
					return;
				}
				console.error(String(err));
				sendResponse(500, formatError(err, isProduction));
			} finally {
				record();
			}
		}
	});
};
//#endregion
export { attachRPC, attachVite, createMiddleware, createRPCMiddleware, getRequestDetails, getResponseDetails, hasPreParsedBody, isExpressRequest, isExpressResponse, readBody, redirect };

//# sourceMappingURL=express.mjs.map