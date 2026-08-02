export const OPERATION_ABORTED = "Operation aborted";

export const REQUEST_CANCELLED = "Request was cancelled";

export const FETCH_ERROR_PREFIX = "Fetch error: ";

export const NO_SERVER_FUNCTION_FOUND = "No server function found.";

export const ERROR_LOADING_FILE = "Error loading file:";

export const FUNCTION_NOT_FOUND = "Function not found";

export const METHOD_NOT_ALLOWED = "Method Not Allowed";

export const REQUEST_FORBIDDEN = "Forbidden";

export const INTERNAL_SERVER_ERROR = "Internal Server Error";

export const CLIENT_DISCONNECTED = "client disconnected";

/** Returns a warning when a middleware name is reused, preventing registration conflicts. @param name - The duplicate middleware name */
export const MIDDLEWARE_NAME_USED = (name: string) =>
  `The middleware name "${name}" is already used.`;

/** Error message when a value fails the safe-identifier validation. @param label - What kind of value was being validated. @param name - The rejected value */
export const INVALID_IDENTIFIER = (label: string, name: string) =>
  `Invalid ${label}: "${name}" must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`;

/** Error message when a value fails the safe-path-segment validation. @param label - What kind of value was being validated. @param segment - The rejected value */
export const INVALID_PATH_SEGMENT = (label: string, segment: string) =>
  `Invalid ${label}: "${segment}" must match /^[A-Za-z0-9_$][A-Za-z0-9_$/-]*$/`;

/** Warning message when a specified RPC config file cannot be resolved on disk. @param configFile - The requested config filename. @param configFilePath - The resolved absolute path */
export const CONFIG_FILE_NOT_FOUND = (
  configFile: string,
  configFilePath: string,
) =>
  `  ⚠︎ The specified RPC config file ${configFile} cannot be found at ${configFilePath}, loading the defaults..`;

export const NO_CONFIG_FOUND = ` ⚡︎ No RPC config found, loading the defaults..`;

export const FAILED_LOAD_CONFIG = ` ⚠︎ Failed to load RPC config:`;
