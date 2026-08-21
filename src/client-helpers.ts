/** @module Client-side helper utilities. Exports `handleResponse` for processing fetch responses and `innerModule` for creating AbortController-bound RPC fetch calls. This module is bundled into the generated client modules — keep it free of server-only code. */
import type {
  ClientFunction,
  Credentials,
  InnerModReturn,
  JsonArray,
  JsonValue,
  StubOptions,
} from "./types.d.ts";
import { FETCH_ERROR_PREFIX, REQUEST_CANCELLED } from "./constants.ts";

/**
 * Processes an HTTP fetch response from the RPC server.
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On other error statuses, throws a Fetch error.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 */
export const handleResponse = async <R extends JsonValue>(
  response: Response,
): Promise<R | void> => {
  if (!response.ok) {
    if (response.status === 499 || response.status === 408) {
      return console.warn(REQUEST_CANCELLED);
    }
    throw new Error(FETCH_ERROR_PREFIX + response.statusText);
  }
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.data as R;
};

/**
 * Low-level stub factory used by both `getClientStub` and the auto-generated
 * modules (`src/getClientModules.ts:73`). Keeps body/header mapping in one
 * place so `innerModule` stays thin.
 */
const makeStub = <T extends JsonArray, R extends JsonValue>(
  prefix: string,
  name: string,
  options: Partial<StubOptions> = {},
): ClientFunction<T, R> => {
  const method = (options.method ?? "POST") as "GET" | "POST";
  const credentials = (options.credentials ?? "same-origin") as Credentials;
  const contentType = (options.contentType ?? "application/json") as string;
  if (method === "GET") {
    const headers = {} as HeadersInit;
    return (<TArgs extends T, Res extends R>(
      ...args: TArgs
    ): InnerModReturn<Res> => {
      const json = JSON.stringify(args);
      return innerModule<Res>(
        json as BodyInit,
        headers,
        credentials,
        prefix,
        name,
        method,
      );
    }) as ClientFunction<T, R>;
  }
  switch (contentType) {
    case "text/plain": {
      const headers = { "Content-Type": "text/plain" } as HeadersInit;
      return (<TArgs extends T, Res extends R>(
        ...args: TArgs
      ): InnerModReturn<Res> =>
        innerModule(
          (args[0] as string) as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<T, R>;
    }
    case "application/x-www-form-urlencoded": {
      const headers: HeadersInit = {
        "Content-Type": "application/x-www-form-urlencoded",
      };
      return (<TArgs extends T, Res extends R>(
        ...args: TArgs
      ): InnerModReturn<Res> =>
        innerModule(
          new URLSearchParams(args[0] as Record<string, string>)
            .toString() as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<T, R>;
    }
    case "multipart/form-data": {
      const headers: HeadersInit = {};
      return (<TArgs extends T, Res extends R>(
        ...args: TArgs
      ): InnerModReturn<Res> =>
        innerModule(
          args[0] as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<T, R>;
    }
    default: {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      return (<TArgs extends T, Res extends R>(
        ...args: TArgs
      ): InnerModReturn<Res> =>
        innerModule(
          JSON.stringify(args) as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<T, R>;
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
export function getClientStub<T extends JsonArray, R extends JsonValue>(
  prefix: string,
  name: string,
  options?: Partial<StubOptions>,
): ClientFunction<T, R> {
  return makeStub<T, R>(prefix, name, options);
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
export const innerModule = <R extends JsonValue>(
  body: BodyInit,
  headers: HeadersInit,
  credentials: Credentials,
  prefix: string,
  name: string,
  method?: "GET" | "POST",
): InnerModReturn<R> => {
  const controller = new AbortController();
  const cancel = (reason: string) => controller.abort(reason);

  const fetcher = async () => {
    try {
      const isGet = method === "GET";
      const url = isGet
        ? `/${prefix}/${name}?args=${encodeURIComponent(String(body))}`
        : `/${prefix}/${name}`;
      const response = await fetch(url, {
        method: isGet ? "GET" : "POST",
        headers,
        credentials,
        body: isGet ? undefined : body,
        signal: controller.signal,
      });
      return await handleResponse<R>(response);
    } catch (err) {
      throw err;
    }
  };

  return {
    data: fetcher(),
    cancel,
  };
};
