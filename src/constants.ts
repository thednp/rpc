/**
 * @module User-facing message strings.
 *
 * Two shapes live here: plain message constants (the exact text an RPC
 * response body carries) and message *factories* for the cases that need a
 * value interpolated. Both are part of the wire contract for the bodies below,
 * so the casing is deliberate — e.g. a client matching on
 * `METHOD_NOT_ALLOWED` must see `"Method Not Allowed"`, not `"Method not
 * allowed"`. These strings are also what keeps error responses generic: they
 * never include the requested function name, so a response cannot be used to
 * enumerate what exists.
 */
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

/** Body of a 413, returned when the request body exceeds the host's configured size limit. */
export const PAYLOAD_TOO_LARGE = "Payload Too Large";

/** Body of a 400, returned when a GET `?args=` value parses but is not an array. */
export const BAD_REQUEST = "Bad Request";

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
