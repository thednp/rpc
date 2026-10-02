/**
 * @module Shared constants: user-facing message strings, validation patterns,
 * limits, and other values referenced from more than one module.
 *
 * The message strings come in two shapes: plain constants (the exact text an RPC
 * response body carries) and message *factories* for the cases that need a value
 * interpolated. Both are part of the wire contract, so the casing is deliberate —
 * e.g. a client matching on `METHOD_NOT_ALLOWED` must see `"Method Not
 * Allowed"`, not `"Method not allowed"`. These strings are also what keeps error
 * responses generic: they never include the requested function name, so a
 * response cannot be used to enumerate what exists.
 *
 * Everything below the messages is a value that two or more modules must agree
 * on. They live here rather than beside their first use because a duplicated
 * constant is a silent-drift bug waiting to happen — `VALIDATION_HINT` was
 * previously copy-pasted into all five adapters, and the history of this codebase
 * is a series of hand-synced copies that fell out of step. A value that is only
 * ever read in one module should stay in that module; it is here because it is
 * shared.
 *
 * This module imports nothing at runtime, so anything may import it without
 * risking an initialisation cycle.
 */
import type { Credentials } from "./types.d.ts";

/** Thrown-name for an operation stopped by its own `cancel()`. */
export const OPERATION_ABORTED = "Operation aborted";

/** Warning text used when a request is cancelled by an HTTP 408/499 response. */
export const REQUEST_CANCELLED = "Request was cancelled";

/** Prefix of the `Error` message the client helpers throw for a non-OK HTTP response. The status text is appended; the response body is deliberately not read, so server-side detail never reaches the client through this path. */
export const FETCH_ERROR_PREFIX = "Fetch error: ";

/** Warning logged when a scanned server module exports nothing. */
export const NO_SERVER_FUNCTION_FOUND = "No server function found.";

/** Error logged when a server function file cannot be loaded by Vite's SSR loader. */
export const ERROR_LOADING_FILE = "Error loading file:";

/** Body of a 404. Deliberately does not name the requested function. */
export const FUNCTION_NOT_FOUND = "Function not found";

/** Body of a 405, returned when the HTTP method does not match the function's declared method. */
export const METHOD_NOT_ALLOWED = "Method Not Allowed";

/** Body of a 403, returned when the optional origin allowlist rejects the request. */
export const REQUEST_FORBIDDEN = "Forbidden";

/** Body of a 415, returned when the request's `Content-Type` does not satisfy the function's declared `contentType`. */
export const UNSUPPORTED_MEDIA_TYPE = "Unsupported Media Type";

/** Body of a 413, returned when the request body exceeds rpc's own streaming size limit. */
export const PAYLOAD_TOO_LARGE = "Payload Too Large";

/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
export const BAD_REQUEST = "Bad Request";

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
export const UNPROCESSABLE_CONTENT = "Unprocessable Content";

/**
 * Reason phrases for the statuses a typed `RPCError` subclass can carry. A
 * thrown `NotFoundError` must not be reported as `Bad Request` just because
 * that was the table's only 4xx entry.
 */
export const NOT_FOUND = "Not Found";

export const CONFLICT = "Conflict";

/** Body of a 500. Always generic — never the underlying error, so internals cannot leak. */
export const INTERNAL_SERVER_ERROR = "Internal Server Error";

/** Abort reason used when the client disconnects mid-dispatch. */
export const CLIENT_DISCONNECTED = "client disconnected";

/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
export const MIDDLEWARE_NAME_USED = (name: string) =>
  `The middleware name "${name}" is already used.`;

/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
export const INVALID_IDENTIFIER = (label: string, name: string) =>
  `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;

/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
export const INVALID_PATH_SEGMENT = (label: string, segment: string) =>
  `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/`;

/** Warning message when a specified RPC config file cannot be resolved on disk. @param configFile - The requested config filename. @param configFilePath - The resolved absolute path */
export const CONFIG_FILE_NOT_FOUND = (
  configFile: string,
  configFilePath: string,
) =>
  `  ⚠︎ The specified RPC config file ${configFile} cannot be found at ${configFilePath}, loading the defaults..`;

/** Warning logged when no config file is discovered and the defaults are used. */
export const NO_CONFIG_FOUND =
  `  ⚡︎ No RPC config found, loading the defaults..`;

/** Warning logged when a config file exists but could not be loaded; the defaults are used. */
export const FAILED_LOAD_CONFIG = `  ⚠︎ Failed to load RPC config:`;

/** Error template for duplicate server function names across files. @param name - The duplicate registered name */
export const DUPLICATE_FUNCTION_NAME = (name: string) =>
  `Duplicate server function "${name}" detected. Each server function must have a unique name. Remove or rename the duplicate.`;

// ── Input validation ─────────────────────────────────────────────────

/**
 * A function-wide pointer appended to every validation failure.
 *
 * Dev-only, like the per-field hints, so production bodies stay a fixed shape.
 * This was previously copy-pasted into all five adapters; one definition means
 * one place to change the doc link.
 */
export const VALIDATION_HINT =
  "input did not match the function's schema; see wiki/server-functions.md#input-validation";

/** Identifiers safe to interpolate into generated code without escaping. */
export const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Path segments safe to interpolate, allowing the `@` and `/` a prefix uses. */
export const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_$@:][A-Za-z0-9_$@:/-]*$/;

/** The `credentials` values the client stubs accept. */
export const CREDENTIALS_VALUES: readonly Credentials[] = [
  "same-origin",
  "include",
  "omit",
];

// ── Request body limits ──────────────────────────────────────────────

/**
 * Default cap on the request body a single RPC call may carry: 10 MiB.
 *
 * It lives in this leaf module so that neither `body.ts` nor `options.ts` has to
 * import the other. The previous home was `options.ts`, chosen to dodge an
 * initialisation cycle (`body.ts → server-helpers.ts → options.ts → body.ts`)
 * that threw under raw ESM; a shared leaf removes the cycle instead of routing
 * around it.
 */
export const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;

/**
 * How many bytes past the cap to keep draining before giving up on the
 * connection. Sized to cover an ordinary "oops, too big" submission without
 * letting the discard itself become an unbounded slowloris.
 */
export const DRAIN_FACTOR = 32;

// ── Server file scanning ─────────────────────────────────────────────

/** The exact basenames the `exact` scan mode recognises. */
export const EXACT_NAMES = [
  "server.ts",
  "server.js",
  "server.mjs",
  "server.mts",
];

// ── URL parsing ──────────────────────────────────────────────────────

/**
 * The fixed base a raw request URL is resolved against.
 *
 * A request-target like `/\` makes the WHATWG parser throw, and the adapters
 * build the URL before their dispatch `try` block, so the base has to be
 * something that always parses and never matches a real prefix.
 */
export const SAFE_URL_BASE = "http://localhost";

// ── Glob matching ────────────────────────────────────────────────────

/** Matches the `*.server.{ts,js,mjs,mts}` basename the `glob` scan mode uses. */
export const GLOB_REGEX = /^.+\.server\.(ts|js|mjs|mts)$/;

// ── Schema vendor identity ───────────────────────────────────────────

/** The `vendor` string a schema built by this library reports. */
export const VENDOR = "thednp";
