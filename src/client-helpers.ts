/** @module Client-side helper utilities. Exports `handleResponse` for processing fetch responses and `innerModule` for creating AbortController-bound RPC fetch calls. This module is bundled into the generated client modules — keep it free of server-only code. */
import type {
  ClientFunction,
  Credentials,
  InnerModReturn,
  JsonValue,
  NoArgClientFunction,
  StubOptions,
  ValidationIssue,
} from "./types.d.ts";
import { FETCH_ERROR_PREFIX, REQUEST_CANCELLED } from "./constants.ts";

/**
 * A non-2xx RPC response, with the server's body attached.
 *
 * Carrying the body matters because the server sends its most useful errors
 * *in* it. A `400` from a schema violation carries the rendered issue paths and
 * the per-field `hint`; discarding that and throwing only `statusText` would
 * leave the browser unable to tell the caller *which field* was wrong, which is
 * the whole point of the teaching-error work. The previous behaviour — throw
 * `FETCH_ERROR_PREFIX + statusText` without reading the body — is preserved in
 * `message` for anyone matching on it.
 */
export class RPCResponseError extends Error {
  /** The HTTP status. */
  readonly status: number;

  /** The parsed response body, when it was JSON. */
  readonly body?: unknown;

  constructor(status: number, statusText: string, body?: unknown) {
    super(FETCH_ERROR_PREFIX + statusText);
    this.name = "RPCResponseError";
    this.status = status;
    this.body = body;
  }

  /**
   * The validation issues from a `422` body, when the server sent them.
   *
   * Returns `undefined` for any other status or an unrecognised body, so a
   * caller can branch without inspecting the shape itself.
   */
  get issues(): ValidationIssue[] | undefined {
    const body = this.body as
      | { code?: unknown; data?: { issues?: unknown } }
      | undefined;
    if (body?.code !== "VALIDATION") return undefined;
    const issues = body.data?.issues;
    return Array.isArray(issues) ? (issues as ValidationIssue[]) : undefined;
  }

  /** The general `hint` from a `422` body, when the server sent one. */
  get hint(): string | undefined {
    const hint = (this.body as { hint?: unknown } | undefined)?.hint;
    return typeof hint === "string" ? hint : undefined;
  }
}

/**
 * Processes an HTTP fetch response from the RPC server.
 *
 * On HTTP 499 or 408 (client cancellation), logs a warning and returns undefined.
 * On any other error status, throws an {@link RPCResponseError} carrying the
 * status and the parsed body when there is one.
 * On success, parses JSON and returns `result.data` — or throws if `result.error` is set.
 * @param response - Fetch Response object from the RPC endpoint
 * @returns The response data, or void on cancellation
 *
 * `R` is deliberately unconstrained: the client only *asserts* the response
 * shape (interfaces included — they have no implicit index signature and can
 * never satisfy `JsonValue`), while the serializability requirement is
 * enforced where values are produced, on the factory's `TResult`. The cast
 * below is the single point where the assertion meets the wire.
 */
export const handleResponse = async <R>(
  response: Response,
): Promise<R | void> => {
  if (!response.ok) {
    if (response.status === 499 || response.status === 408) {
      return console.warn(REQUEST_CANCELLED);
    }
    // Read the body so the caller can act on it. A body that is absent or not
    // JSON is not an error here — the status is the signal that matters.
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    throw new RPCResponseError(response.status, response.statusText, body);
  }
  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result.data as R;
};

/**
 * Field errors from a rejected call, keyed by the path that failed.
 *
 * The server normalises **every** validator's issues into the same
 * `{ path, message, hint? }` shape, so this is validator-agnostic: a zod
 * rejection and an arktype rejection arrive identically, and neither needs the
 * app to know which library produced it. That is what removes the usual
 * per-app helper — a hand-rolled `isValiError` guard plus a
 * `getError(error, field)` formatter, both tied to one library's flattened
 * output and silently wrong for the other three.
 *
 * Paths are the rendered strings rpc already produces, so a nested failure keys
 * on `"profile.email"`. An empty path — a top-level scalar — keys on `""`.
 *
 * ```ts
 * import { fieldErrors } from "@thednp/rpc/helpers";
 *
 * for (const [path, messages] of Object.entries(fieldErrors(err))) {
 *   showError(path, messages.join(" "));
 * }
 * ```
 *
 * Works in production as well as development. A production rejection carries
 * each issue's `path` and `hint` but not the validator library's `message`, so
 * the message falls back to the hint; an issue carrying neither is skipped
 * rather than rendered as an empty string, which would put a stray `""` into
 * every "show errors" loop.
 *
 * Returns an empty object for anything that is not a validation failure.
 */
export const fieldErrors = (err: unknown): Record<string, string[]> => {
  const issues = err instanceof RPCResponseError ? err.issues : undefined;
  if (!issues) return {};
  const grouped: Record<string, string[]> = {};
  for (const issue of issues) {
    // Production omits the vendor `message`, and the `hint` is what replaces it.
    // An issue can carry neither — an author who wrote no `hints` gets exactly
    // that — and the key must still appear, because "this field failed" is the
    // one thing a production body always conveys, and dropping the issue would
    // discard it. The empty string is then the honest rendering: there is text
    // to show for this field, and `fieldErrorText` returns `""` accordingly.
    const text = issue.message ?? issue.hint ?? "";
    const key = issue.path ?? "";
    (grouped[key] ??= []).push(text);
  }
  return grouped;
};

/**
 * One field's messages, ready to render — the exact replacement for a
 * hand-written `getError(error, field)`.
 *
 * Returns `""` when the field did not fail, so it drops straight into an
 * element's `textContent` with no guard:
 *
 * ```ts
 * emailError.textContent = fieldErrorText(err, "email");
 * ```
 */
export const fieldErrorText = (err: unknown, field: string): string => {
  const messages = fieldErrors(err)[field];
  return messages?.length ? messages.join("; ") : "";
};

/**
 * The `hint` for a field's failure, or `""`.
 *
 * Prefers the field's own hint — from `hints: { email: "…" }` or from a builder
 * schema's `field.string({ hint })` — and falls back to the function-wide
 * `hint`, which is the more common form and would otherwise be unreachable from
 * a per-field lookup. Several issues can share a path; the first hint wins,
 * because a field with two hints is better served by one than by none.
 *
 * Sent in production as well as development. A hint is authored in
 * `ServerFunctionOptions`, so disclosing it was deliberate — which is exactly
 * why it is the one part of an issue that survives into a production body.
 * That makes it the right thing to put in a `title` or tooltip beside the
 * field, whether or not there is a visible message to pair it with.
 */
export const fieldErrorHint = (err: unknown, field: string): string => {
  if (!(err instanceof RPCResponseError)) return "";
  const own = err.issues?.find((i) => (i.path ?? "") === field)?.hint;
  return own ?? err.hint ?? "";
};

/**
 * Unwraps the `{ data }` envelope from a parsed RPC response body.
 *
 * Error handling matches `handleResponse` so both helpers in this module agree
 * on the contract: a **top-level** `error` key (including `400`/`403`/`404`/`405`/`409`/`413`/`415`/`422`/`500`) throws, while a `{ data: { error } }` body resolves
 * normally — that shape is the documented "validation-as-data" contract where a
 * 200 carries the validation outcome as its result.
 *
 * Discriminating on `error` present **and** `data` absent is what keeps those
 * two cases apart. Checking `res.ok` first is still recommended, since this
 * helper is status-code agnostic by design, so still check `res.ok` before
 * passing it a body.
 * @param json - Parsed JSON response body
 * @returns The unwrapped response data
 * @throws When the body carries a top-level `error` and no `data`
 * @example
 * ```ts
 * const response = await fetch("/__rpc/greet", { method: "POST", ... });
 * const body = await response.json();
 * const greeting = unwrapEnvelope<string>(body); // "Hello, world!"
 * ```
 */
export const unwrapEnvelope = <T>(json: unknown): T => {
  if (json !== null && typeof json === "object") {
    const envelope = json as { data?: T; error?: unknown };
    if (!("data" in envelope) && "error" in envelope) {
      throw new Error(String(envelope.error));
    }
    if ("data" in envelope) return envelope.data as T;
  }
  return json as T;
};

/**
 * Low-level stub factory used by both `getClientStub` and the auto-generated
 * modules (`src/getClientModules.ts:73`). Keeps body/header mapping in one
 * place so `innerModule` stays thin.
 */
const makeStub = <TInput extends FormData | JsonValue, R>(
  prefix: string,
  name: string,
  options: Partial<StubOptions> = {},
): ClientFunction<TInput, R> & NoArgClientFunction<R> => {
  const method = (options.method ?? "POST") as "GET" | "POST";
  const credentials = (options.credentials ?? "same-origin") as Credentials;
  const contentType = (options.contentType ?? "application/json") as string;
  if (method === "GET") {
    const headers = {} as HeadersInit;
    return (<TIn extends TInput, Res extends R>(
      input: TIn,
    ): InnerModReturn<Res> => {
      const json = JSON.stringify([input]);
      return innerModule<Res>(
        json as BodyInit,
        headers,
        credentials,
        prefix,
        name,
        method,
      );
    }) as ClientFunction<TInput, R> & NoArgClientFunction<R>;
  }
  switch (contentType) {
    case "text/plain": {
      const headers = { "Content-Type": "text/plain" } as HeadersInit;
      return (<TIn extends TInput, Res extends R>(
        input: TIn,
      ): InnerModReturn<Res> =>
        innerModule(
          (input as unknown as string) as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<TInput, R> & NoArgClientFunction<R>;
    }
    case "application/x-www-form-urlencoded": {
      const headers: HeadersInit = {
        "Content-Type": "application/x-www-form-urlencoded",
      };
      return (<TIn extends TInput, Res extends R>(
        input: TIn,
      ): InnerModReturn<Res> =>
        innerModule(
          new URLSearchParams(input as unknown as Record<string, string>)
            .toString() as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<TInput, R> & NoArgClientFunction<R>;
    }
    case "multipart/form-data": {
      const headers: HeadersInit = {};
      return (<TIn extends TInput, Res extends R>(
        input: TIn,
      ): InnerModReturn<Res> =>
        innerModule(
          input as unknown as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<TInput, R> & NoArgClientFunction<R>;
    }
    default: {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      return (<TIn extends TInput, Res extends R>(
        input: TIn,
      ): InnerModReturn<Res> =>
        innerModule(
          JSON.stringify([input]) as BodyInit,
          headers,
          credentials,
          prefix,
          name,
          method,
        )) as ClientFunction<TInput, R> & NoArgClientFunction<R>;
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
 * @returns Client stub `(input) => {data,cancel}`
 * @example
 * import { getClientStub } from "@thednp/rpc/helpers";
 * const adminGetUser = getClientStub("admin:rpc","get-user");
 * const {data,cancel} = adminGetUser("123");
 * @example
 * const adminStats = getClientStub("admin:rpc","stats", { method: "GET" });
 */
export function getClientStub<
  TInput extends FormData | JsonValue = JsonValue,
  R = JsonValue,
>(
  prefix: string,
  name: string,
  options?: Partial<StubOptions>,
): ClientFunction<TInput, R> & NoArgClientFunction<R> {
  return makeStub<TInput, R>(prefix, name, options);
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
export const innerModule = <R>(
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
