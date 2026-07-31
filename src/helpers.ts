/** @module Client-side helper utilities. Exports `handleResponse` for processing fetch responses and `innerModule` for creating AbortController-bound RPC fetch calls. */
import type { Credentials, JsonValue } from "./types.d.ts";
import { FETCH_ERROR_PREFIX, REQUEST_CANCELLED } from "./constants.ts";

/**
 * Processes an HTTP fetch response from the RPC server.
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On other error statuses, throws a Fetch error.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 */
export const handleResponse = async (
  response: Response,
): Promise<JsonValue | void> => {
  if (!response.ok) {
    if (response.status === 499 || response.status === 408) {
      return console.warn(REQUEST_CANCELLED);
    }
    throw new Error(FETCH_ERROR_PREFIX + response.statusText);
  }
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.data;
};

/**
 * Return shape of `innerModule`: a promise of the response data plus
 * a `cancel` function to abort the underlying fetch request.
 */
type InnerModReturn = {
  /** Promise resolving to the server response data */
  data: Promise<JsonValue | void>;
  /** Aborts the in-flight request with the given reason */
  cancel: (reason: string) => void;
};

/**
 * Creates an AbortController-bound fetch call for a single RPC function.
 * Used by the auto-generated client modules to issue POST requests with cancellation support.
 * @param body - Serialized request body
 * @param headers - HTTP headers (Content-Type, etc.)
 * @param credentials - Fetch credentials policy ("same-origin", "include", or "omit")
 * @param prefix - RPC endpoint prefix (e.g. "__rpc")
 * @param name - Registered server function name
 * @returns An object with `data` (promise resolving to the server response) and `cancel` (abort function)
 */
export const innerModule = (
  body: BodyInit,
  headers: HeadersInit,
  credentials: Credentials,
  prefix: string,
  name: string,
): InnerModReturn => {
  const controller = new AbortController();
  const cancel = (reason: string) => controller.abort(reason);

  const fetcher = async () => {
    try {
      const response = await fetch(`/${prefix}/${name}`, {
        method: "POST",
        headers,
        credentials,
        body,
        signal: controller.signal,
      });
      return await handleResponse(response);
    } catch (err) {
      throw err;
    }
  };

  return {
    data: fetcher(),
    cancel,
  };
};
