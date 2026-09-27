/** @module Server-side utilities. Exports the `RPCError` class for typed server-side errors, `formatError` for middleware error responses, `isFormContentType` and `hasContentTypeMismatch` for content-type validation, and `walkGlobFiles` for recursively discovering `*.server.*` files. Never import this module in client code — it is server-only. */
import type { ContentType, JsonObject, JsonValue } from "./types.d.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { INTERNAL_SERVER_ERROR } from "./constants.ts";

const GLOB_REGEX = /^.+\.server\.(ts|js|mjs|mts)$/;

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

/**
 * A typed error thrown from server functions.
 * The middleware serializes the `message` and `code` in the response,
 * allowing clients to recognise and handle specific error conditions.
 */
export class RPCError extends Error {
  /** Machine-readable error code (e.g. "VALIDATION_FAILED", "UNAUTHORIZED") */
  code: string;
  /** Optional diagnostic payload */
  data?: JsonValue;
  constructor(message: string, code = "INTERNAL", data?: JsonValue) {
    super(message);
    this.name = "RPCError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Formats an error for the RPC middleware response.
 * In development the full `RPCError` payload is included so developers
 * can quickly identify issues. Unexpected exceptions never expose their
 * message — only the generic "Internal Server Error" is sent, preventing
 * information disclosure; server-side diagnostics are preserved via the
 * middleware's `console.error` logging.
 */
export const formatError = (
  err: unknown,
  isProduction: boolean,
): JsonObject => {
  if (isProduction) {
    return { error: INTERNAL_SERVER_ERROR };
  }
  if (err instanceof RPCError) {
    const payload: JsonObject = {
      error: err.message || INTERNAL_SERVER_ERROR,
      code: err.code,
    };
    if (err.data !== undefined) payload.data = err.data;
    return payload;
  }
  return { error: INTERNAL_SERVER_ERROR };
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
 * Decides whether a request may proceed, given the configured origin allowlist
 * and the two headers a browser can be made to reveal.
 *
 * Three tiers, evaluated in order — the first tier with a signal decides:
 *
 * 1. `origin` option unset → everything passes. No validation is performed.
 * 2. `Origin` present → the allowlist decides, exactly as {@link isOriginAllowed}.
 * 3. `Origin` absent but `Sec-Fetch-Site` present → allow only `same-origin`
 *    and `none`; anything else (including an unrecognised value) is rejected.
 * 4. Both absent → passes. This is the deliberate, documented curl/native hole.
 *
 * Tier 2 must short-circuit ahead of tier 3. `Sec-Fetch-Site` is a coarse
 * four-value enum that cannot name a host, so on its own it would reject a
 * legitimate request from an allowlisted sibling subdomain (`same-site`). The
 * allowlist exists precisely to admit that case, and it can only do so while
 * `Origin` survives. `Sec-Fetch-Site` earns a vote only once the precise signal
 * has been stripped away by something in the chain — at which point there is
 * nothing left to trust, so it fails closed.
 *
 * Browsers never strip `Origin` themselves, so tier 3 can only fire when a
 * proxy, sanitising middleware, or misconfigured CDN removed it. No legitimate
 * browser request can regress.
 *
 * An empty (or whitespace-only) header value counts as **absent**, not as an
 * unrecognised signal. No browser emits an empty `Sec-Fetch-Site`, and adapters
 * disagree on what their header accessor returns for a missing header (Node's
 * `req.headers` yields `undefined`, Hono's `c.req.header()` may yield `""`).
 * Normalising here keeps all five adapters behaving identically instead of
 * inheriting whichever convention their framework happens to use.
 * @param allowed - The configured `origin` option, if any
 * @param origin - The raw `Origin` request header, if present
 * @param site - The raw `Sec-Fetch-Site` request header, if present
 * @returns `true` when the request may proceed
 */
export const isOriginRequestAllowed = (
  allowed: string | string[] | undefined,
  origin: string | undefined,
  site: string | undefined,
): boolean => {
  if (!allowed) return true; // tier 1 — the check is opt-in
  if (origin?.trim()) return isOriginAllowed(allowed, origin); // tier 2 — precise
  if (!site?.trim()) return true; // tier 4 — curl / native client
  // tier 3 — precision lost, so fail closed
  return site === "same-origin" || site === "none";
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
 * - No `allowed` value (option unset) → everything passes: no validation.
 * - No `requestOrigin` header → passes, preserving curl/native-client access.
 * - Otherwise the header must match one of the entries exactly.
 *
 * A single string and a one-element array behave identically, so widening
 * `origin` to `string | string[]` is backward compatible.
 *
 * `Origin: null` (sandboxed iframes, `file://`, extension pages) is rejected
 * whenever an allowlist is set, because it never equals a real origin.
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

const SAFE_URL_BASE = "http://localhost";

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
