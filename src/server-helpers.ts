/** @module Server-side utilities. Exports the `RPCError` class for typed server-side errors, `formatError` for middleware error responses, `isFormContentType` and `hasContentTypeMismatch` for content-type validation, and `walkGlobFiles` for recursively discovering `*.server.*` files. Never import this module in client code — it is server-only. */
import type {
  ContentType,
  JsonObject,
  JsonValue,
  OriginOption,
  ValidationErrorBody,
  ValidationIssue,
} from "./types.d.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  BAD_REQUEST,
  CONFLICT,
  GLOB_REGEX,
  INTERNAL_SERVER_ERROR,
  NOT_FOUND,
  PAYLOAD_TOO_LARGE,
  REQUEST_FORBIDDEN,
  SAFE_URL_BASE,
  UNPROCESSABLE_CONTENT,
  UNSUPPORTED_MEDIA_TYPE,
} from "./constants.ts";
import { defaultPrefix } from "./options.ts";

/**
 * Recursively walks `dir` and collects absolute paths to files whose
 * basename matches the `*.server.{ts,js,mjs,mts}` glob pattern.
 */
export const walkGlobFiles = async (dir: string): Promise<string[]> => {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && GLOB_REGEX.test(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return results;
};

/** Registered brand carried by every {@link RPCError}, across bundle copies. */
export const RPC_ERROR_BRAND = Symbol.for("thednp.rpc.error");

/**
 * Recognises an {@link RPCError} without `instanceof`, so the check holds
 * across tsdown's per-entry copies of the class.
 */
export const isRPCError = (err: unknown): err is RPCError =>
  err instanceof RPCError ||
  (typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[RPC_ERROR_BRAND] === true);

/**
 * A typed error thrown from server functions.
 *
 * `formatError` decides what crosses the wire. Unexpected exceptions always
 * answer `{ error: "Internal Server Error" }`; typed errors keep the status
 * reason plus the semantics `formatError` documents.
 */
export class RPCError extends Error {
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
  readonly [RPC_ERROR_BRAND] = true;

  /** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
  code: string;
  /** Optional diagnostic payload */
  data?: JsonValue;
  /**
   * Developer-facing advice about how to fix the failure, dev-only.
   *
   * A message says what went wrong; a hint says what to do about it.
   * `formatError` decides what crosses the wire: a `ValidationError` keeps
   * author-written paths and hints while dropping the validator library's
   * `message`; the other typed errors keep the status reason phrase in
   * production. See {@link NotFoundError} and siblings for the typed forms.
   */
  hint?: string;
  constructor(
    message: string,
    code = "INTERNAL",
    data?: JsonValue,
    hint?: string,
  ) {
    super(message);
    this.name = "RPCError";
    this.code = code;
    this.data = data;
    this.hint = hint;
  }
}

/**
 * A `404` that teaches. The `hint` is **required**, deliberately: an error class
 * whose whole purpose is to explain a failure should not be constructible
 * without the explanation. It is still stripped in production.
 */
export class NotFoundError extends RPCError {
  /** The client-error status, so adapters answer `404` and not `500`. */
  readonly status = 404;

  constructor(message: string, hint: string, data?: JsonValue) {
    super(message, "NOT_FOUND", data, hint);
    this.name = "NotFoundError";
  }
}

/** A `403` that teaches. See {@link NotFoundError} for why `hint` is required. */
export class ForbiddenError extends RPCError {
  /** The client-error status, so adapters answer `403` and not `500`. */
  readonly status = 403;

  constructor(message: string, hint: string, data?: JsonValue) {
    super(message, "FORBIDDEN", data, hint);
    this.name = "ForbiddenError";
  }
}

/** A `409` that teaches. See {@link NotFoundError} for why `hint` is required. */
export class ConflictError extends RPCError {
  /** The client-error status, so adapters answer `409` and not `500`. */
  readonly status = 409;

  constructor(message: string, hint: string, data?: JsonValue) {
    super(message, "CONFLICT", data, hint);
    this.name = "ConflictError";
  }
}

/**
 * A rejected input: a `422` that carries structured issues.
 *
 * Lives here rather than in `schema.ts` so the error types and the builder have a
 * single direction between them — `schema.ts` imports this, not the reverse.
 */
export class ValidationError extends RPCError {
  /**
   * The client-error status, so adapters answer `422` and not `500`.
   *
   * `422` rather than `400` on purpose: the body parsed and the *fields* are
   * wrong, which is a different thing from a request that could not be parsed
   * at all. Sharing `400` left a client unable to tell a malformed body from a
   * rejected input without reading the prose.
   */
  readonly status = 422;

  /** The rendered issues, one per rejected field. */
  readonly issues: readonly ValidationIssue[];

  /**
   * @param issues - The rendered issues, one per rejected field.
   * @param hint - A general hint about how to fix the failure, inherited from
   *   {@link RPCError.hint} and dev-only like it.
   */
  constructor(issues: readonly ValidationIssue[], hint?: string) {
    super(
      "Validation failed",
      "VALIDATION",
      { issues } as unknown as JsonValue,
      hint,
    );
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Options for {@link validationErrorBody}. */
export interface ValidationBodyOptions {
  /**
   * Include each issue's vendor `message`.
   *
   * Defaults to `true`; `formatError` passes `false` for production responses.
   * The reason is measured rather than assumed: the default messages of some
   * libraries interpolate the value that failed. Going
   * through `~standard.validate` with `name: 12345`, valibot returns
   * `"Invalid type: Expected string but received 12345"`, while zod returns
   * `"Invalid input: expected string, received number"` and arktype
   * `"name must be a string (was a number)"`. So whether a message is safe
   * depends on which library the author picked, which is the worst shape for a
   * rule — it cannot be reasoned about portably, so it has to be structural.
   *
   * `path` and `hint` are not withheld by this flag because they are not
   * library-written: a `path` names a field the caller itself supplied and can
   * already see, and a `hint` is author-written in `ServerFunctionOptions`, so
   * sending it was a deliberate act. A vendor `message` is neither, and depending
   * on one also couples a project's error text to that library's release cycle.
   */
  includeMessages?: boolean;
}

/** Builds the JSON body for a rejected input. */
export const validationErrorBody = (
  err: ValidationError,
  options: ValidationBodyOptions = {},
): ValidationErrorBody => {
  // Default to including messages, so the development body is unchanged and a
  // caller that does not pass the option gets the fuller, more useful shape.
  const includeMessages = options.includeMessages ?? true;
  return {
    // In production every string in this body is either a constant from the
    // status table or author-written in `ServerFunctionOptions`. The author's
    // own `message` is the one that is not, so it is the one that goes.
    error: includeMessages ? err.message : clientErrorMessage(err.status),
    code: err.code as "VALIDATION",
    data: {
      issues: includeMessages ? err.issues : err.issues.map(({ path, hint }) =>
        // The `hint` is what replaces a message in production: it is the one
        // part of an issue the author authored, so it is the only part safe to
        // send. Without one the issue is just the path, which still tells the
        // submitter which field to look at.
        hint ? { path, hint } : { path }
      ),
    },
    ...(err.hint ? { hint: err.hint } : {}),
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
export const formatError = (
  err: unknown,
  isProduction: boolean,
): JsonObject => {
  // A rejected input is a client error, not a server fault, so it keeps its
  // `422` in production. Answering `500` would both misreport the fault and turn
  // a trivial client mistake into a log entry.
  //
  // The two environments differ in what the body *says*, and the difference is
  // drawn on a single rule: production keeps what rpc or the author wrote — the
  // status reason phrase, the `code`, each issue's `path`, each `hint` — and
  // drops what the validator library wrote, because some libraries interpolate
  // the value that failed (measured: valibot returns `"Expected string but
  // received 12345"` where zod returns `"expected string, received number"`).
  // A `path` names a field the caller itself supplied, and a `hint` is authored
  // in `ServerFunctionOptions`, so sending either was deliberate; a vendor
  // `message` is neither, and depending on one also couples a project's error
  // text to that library's release cycle.
  if (err instanceof ValidationError) {
    return validationErrorBody(
      err,
      isProduction ? { includeMessages: false } : {},
    ) as unknown as JsonObject;
  }
  // An author-thrown `RPCError` that carries a 4xx status — `NotFoundError`,
  // `ForbiddenError`, `ConflictError` — is a *described* client error, not one of
  // the protocol faults below. It has to be recognised before the status table,
  // or a thrown `NotFoundError` is answered `404` with the body
  // `{ error: "Bad Request" }`: right status, wrong meaning, and the `code` and
  // `hint` the author wrote are discarded. The discriminator is the class, so a
  // framework-thrown `http-errors` 404 still takes the table below.
  if (err instanceof RPCError) {
    const thrownStatus = readClientStatus(err);
    if (thrownStatus !== undefined) {
      // Production keeps the status reason phrase and nothing else, so the shape
      // does not change between environments and nothing is echoed back.
      if (isProduction) return { error: clientErrorMessage(thrownStatus) };
      const described: JsonObject = {
        error: err.message || clientErrorMessage(thrownStatus),
        code: err.code,
      };
      if (err.data !== undefined) described.data = err.data;
      if (err.hint !== undefined) described.hint = err.hint;
      return described;
    }
  }
  // The other client errors — a malformed body, a bad `?args=`, an oversized
  // upload — carry a status but no detail worth sending. The body comes from the
  // fixed table in both modes, so nothing from the underlying error is echoed
  // back and the shape does not change between development and production.
  const clientStatus = readClientStatus(err);
  if (clientStatus !== undefined) {
    return { error: clientErrorMessage(clientStatus) };
  }
  if (isProduction) {
    return { error: INTERNAL_SERVER_ERROR };
  }
  if (err instanceof RPCError) {
    const payload: JsonObject = {
      error: err.message || INTERNAL_SERVER_ERROR,
      code: err.code,
    };
    if (err.data !== undefined) payload.data = err.data;
    if (err.hint !== undefined) payload.hint = err.hint;
    return payload;
  }
  return { error: INTERNAL_SERVER_ERROR };
};

/**
 * An error carrying an HTTP status, so the dispatch can answer that status
 * instead of flattening every failure to a `500`.
 */
export interface ClientHttpError extends Error {
  status?: number;
  statusCode?: number;
}

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
export const httpError = (status: number, message: string): ClientHttpError => {
  const err = new Error(message) as ClientHttpError;
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
const readClientStatus = (err: unknown): number | undefined => {
  const candidate = err as ClientHttpError | null | undefined;
  // Reads both conventions: h3's `HTTPError` and rpc's `httpError` use
  // `status`, while the `http-errors` objects Express's `body-parser` throws
  // and Koa's `ctx.throw` use `statusCode`.
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : undefined;
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
export const isClientHttpError = (err: unknown): boolean =>
  readClientStatus(err) !== undefined;

/**
 * Reads the status to answer for a client error. Defaults to `400` rather than
 * `500` so an unrecognised 4xx is never reported as a server fault.
 * @param err - The caught error
 * @returns The 4xx status to answer with
 */
export const clientErrorStatus = (err: unknown): number =>
  readClientStatus(err) ?? 400;

export const clientErrorMessage = (status: number): string => {
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
export const isFormContentType = (contentType: string): boolean =>
  contentType === "multipart/form-data" ||
  contentType === "application/x-www-form-urlencoded";

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
export const hasContentTypeMismatch = (
  declared: ContentType,
  rawHeader: string | undefined,
): boolean => {
  // No Content-Type header → exempt (url bar, GET, curl compatibility)
  if (!rawHeader) return false;
  // Strip parameters (charset, boundary) before comparison
  const incomingType = rawHeader.trim().toLowerCase().split(";")[0].trim();
  if (isFormContentType(declared)) {
    // Forms: reject only non-form encodings (lenient between the two)
    return !isFormContentType(incomingType);
  }
  return incomingType !== declared;
};

/**
 * Inputs for {@link isOriginRequestAllowed}. Passed as an object rather than
 * positionally so that a call site cannot silently swap `site` for `host` — in a
 * function whose job is to decide whether a request is a forgery, argument
 * confusion is the wrong failure mode.
 */
export interface OriginCheck {
  /** The configured `origin` policy. `undefined` resolves to the secure default. */
  allowed?: OriginOption;
  /** The raw `Origin` request header, if present. */
  origin?: string;
  /** The raw `Sec-Fetch-Site` request header, if present. */
  site?: string;
  /** The `Host` request header, used only for the host-only `"self"` comparison. */
  host?: string;
  /** Whether requests carrying neither header are permitted. */
  allowHeaderless?: boolean;
}

/**
 * Which tier of the cross-origin rule decided a request, and whether it passed.
 *
 * `"blocked"` means the rule refused — either `Sec-Fetch-Site` was present and
 * untrusted, or neither header was sent and `allowHeaderless` was off. The three
 * passing tiers are `"origin"`, `"sec-fetch-site"` and `"headerless"`, and the
 * distinction is the point: "allowed because the Origin matched" and "allowed
 * because nothing was sent" are very different facts about a request.
 */
export type OriginTier =
  | "origin"
  | "sec-fetch-site"
  | "headerless"
  | "blocked";

/** The outcome of {@link describeOriginRequest}. */
export interface OriginDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The tier that decided it. */
  tier: OriginTier;
}

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
const originHost = (origin: string): string | null => {
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
export const isOriginRequestAllowed = (check: OriginCheck): boolean =>
  describeOriginRequest(check).allowed;

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
export const describeOriginRequest = ({
  allowed,
  origin,
  site,
  host,
  allowHeaderless = false,
}: OriginCheck): OriginDecision => {
  // An absent policy is the secure default, not an unchecked endpoint. This is
  // why `origin: undefined` cannot be used to switch the check off.
  const policy: OriginOption = allowed ?? "self";

  if (origin?.trim()) {
    // tier 1 — the precise signal is present, so it decides
    if (policy === "self") {
      return {
        allowed: isSelfOrigin(origin, host),
        tier: "origin",
      };
    }
    const allowlist = Array.isArray(policy) ? policy : [policy];
    // Literal entries match exactly...
    if (isOriginAllowed(allowlist, origin)) {
      return { allowed: true, tier: "origin" };
    }
    // ...and an allowlist widens "self" rather than replacing it, so naming an
    // extra origin can never lock the operator out of their own site.
    return { allowed: isSelfOrigin(origin, host), tier: "origin" };
  }

  // tier 2 — precision lost, so fail closed
  if (site?.trim()) {
    const ok = site === "same-origin" || site === "none";
    return { allowed: ok, tier: ok ? "sec-fetch-site" : "blocked" };
  }

  // tier 3 — no browser provenance at all. Opt-in, because a stripped CSRF
  // request and a native client are indistinguishable on the wire.
  return {
    allowed: allowHeaderless,
    tier: allowHeaderless ? "headerless" : "blocked",
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
export const isSelfOrigin = (origin: string, host?: string): boolean => {
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
export function escapeRegExp(s: string): string {
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
export const isOriginAllowed = (
  allowed: string | string[] | undefined,
  requestOrigin: string | undefined,
): boolean => {
  if (!allowed || !requestOrigin) return true;
  return Array.isArray(allowed)
    ? allowed.includes(requestOrigin)
    : requestOrigin === allowed;
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
export const safeURL = (rawUrl: string, base = SAFE_URL_BASE): URL => {
  try {
    return new URL(rawUrl, base);
  } catch {
    return new URL("/", base);
  }
};

const globalPrefixSymbol = Symbol.for("thednp.rpc.globalPrefix");

/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
export const getGlobalPrefix = (): string | undefined =>
  (globalThis as unknown as Record<symbol, string | undefined>)[
    globalPrefixSymbol
  ];

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
export const setGlobalPrefix = (prefix: string | undefined): void => {
  if (prefix) {
    (globalThis as unknown as Record<symbol, string | undefined>)[
      globalPrefixSymbol
    ] = prefix;
  } else {
    delete (globalThis as unknown as Record<symbol, string | undefined>)[
      globalPrefixSymbol
    ];
  }
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
export const resolveRPCPrefix = (rpcPrefix?: string): string =>
  rpcPrefix || getGlobalPrefix() || defaultPrefix;
