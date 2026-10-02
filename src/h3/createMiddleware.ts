// src/h3/createMiddleware.ts
import type { H3Event, Middleware } from "h3";
import type { H3MiddlewareFn, H3MiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import type { ContentType } from "../types.d.ts";
import { createDispatcher, dispatchRequest } from "../execution-log.ts";
import {
  clientErrorStatus,
  describeOriginRequest,
  escapeRegExp,
  formatError,
  hasContentTypeMismatch,
  isClientHttpError,
  provideRequestContext,
  resolveRPCPrefix,
  runValidation,
  scanForServerFiles,
} from "@thednp/rpc/server";
import { getFunctionsForPrefix } from "../functionsMap.ts";
import {
  BAD_REQUEST,
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
  UNSUPPORTED_MEDIA_TYPE,
  VALIDATION_HINT,
} from "../constants.ts";
import { defaultMiddlewareOptions } from "../options.ts";
import { formFallbackLocation, formSuccessLocation } from "../form-fallback.ts";
import { readBody, redirect as h3Redirect } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates an h3 middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * h3 URL is normalized via `event.url` (query strings are not part of the pathname).
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns An h3 middleware function
 */
export const createMiddleware: H3MiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as H3MiddlewareOptions;

  const middlewareName = options.name;
  const rpcPrefix = options.rpcPrefix;
  const path = options.path;
  const handler = options.handler;

  let name = middlewareName;
  if (!name) {
    name = "viteRPCMiddleware-" + middlewareCount;
    middlewareCount += 1;
  }
  if (middlewareStack.has(name)) {
    throw new Error(MIDDLEWARE_NAME_USED(name));
  }
  middlewareStack.add(name);

  // Hoist regex compilation out of per-request path. Escape the prefix to
  // prevent regex injection via metacharacters in the config string.
  // Resolved once at creation time so the hoisted regex and the
  // function-map lookup can never disagree. `createRPCMiddleware` hands
  // over its already-resolved prefix, making this a no-op in that path.
  const resolvedPrefix = resolveRPCPrefix(rpcPrefix);
  // Gated only when an explicit prefix was supplied: a bare
  // `createMiddleware({ path, handler })` has never prefix-gated.
  // `createRPCMiddleware` always supplies one, so RPC dispatch does.
  const prefixRegex: RegExp | null = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(resolvedPrefix)}/`)
    : null;
  const pathMatcher: RegExp | null = path
    ? (typeof path === "string" ? new RegExp(path) : path)
    : null;

  const middlewareHandler: Middleware = async (event: H3Event, next) => {
    const url = event.url.pathname;

    // No need to continue when no handler provided
    if (!handler) {
      return next();
    }

    if (pathMatcher && !pathMatcher.test(url)) {
      return next();
    }

    if (prefixRegex && !prefixRegex.test(url)) {
      return next();
    }

    // When serving from production server, scan for server files
    if (getFunctionsForPrefix(resolvedPrefix).size === 0) {
      await scanForServerFiles({
        rpcPrefix: resolvedPrefix,
        serverFiles: (options as unknown as { serverFiles?: "exact" | "glob" })
          .serverFiles,
        scanRoot: (options as unknown as { scanRoot?: string }).scanRoot,
      } as never);
    }

    return handler(event, next);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the h3 RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns An h3 middleware function
 */
export const createRPCMiddleware: H3MiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as H3MiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = resolveRPCPrefix(rpcPrefix);
  const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
  const prefixReplace = `/${prefix}/`;

  // One emitter per middleware, holding no request state. `undefined` with no
  // hook, and the wrapper then short-circuits to a bare call.
  const emit = createDispatcher(options.onDispatch);

  return createMiddleware({
    ...options,
    // Hand the resolved prefix down so the gate and the dispatch agree.
    rpcPrefix: prefix,
    handler: async (event: H3Event, _next?: () => unknown) =>
      await dispatchRequest({
        emit,
        prefix,
        method: () => event.req.method,
        readStatus: () => event.res.status ?? 200,
        run: async (seen) => {
          const url = event.url.pathname;

          // Defense-in-depth: validate prefix match via escaped regex even though
          // the outer createMiddleware gates on the same prefix already.
          // istanbul ignore if
          if (prefixRegex && !prefixRegex.test(url)) {
            /* istanbul ignore next */
            return undefined;
          }

          // Cross-origin check, on by default (`origin: "self"`). `Origin` decides
          // when present; `Sec-Fetch-Site` is the fail-closed fallback once it is
          // gone; headerless clients are opt-in via `allowHeaderless`. The Host
          // header is used only for the host-only "self" comparison — no forwarded
          // header is trusted. See `isOriginRequestAllowed` for the three tiers.
          const origin = describeOriginRequest({
            allowed: options.origin,
            origin: event.req.headers.get("origin") ?? undefined,
            site: event.req.headers.get("sec-fetch-site") ?? undefined,
            host: event.req.headers.get("host") ?? undefined,
            allowHeaderless: options.allowHeaderless,
          });
          seen.originTier = origin.tier;
          if (!origin.allowed) {
            event.res.status = 403;
            return { error: REQUEST_FORBIDDEN };
          }

          const functionName = url.replace(prefixReplace, "");
          const forPrefix = getFunctionsForPrefix(prefix);
          const serverFunction = forPrefix.get(functionName);
          if (emit) {
            seen.functionName = functionName;
            // The sibling names turn "Function not found" into a question an agent
            // can actually answer.
            seen.registered = [...forPrefix.keys()];
            seen.actualContentType = event.req.headers.get("content-type") ??
              undefined;
          }

          if (!serverFunction) {
            event.res.status = 404;
            return { error: FUNCTION_NOT_FOUND };
          }
          // Out here rather than inside the `try` so the `catch` can read
          // the submitted first argument: a no-JS failure redirects, and
          // the flash can only replay what was actually sent.
          let args: JsonValue[] = [];

          try {
            const method = serverFunction.options?.method || "POST";
            if (emit) {
              seen.declaredMethod = method;
              seen.declaredContentType = serverFunction.options?.contentType ??
                "application/json";
              seen.contentTypeMatched = !hasContentTypeMismatch(
                seen.declaredContentType as ContentType,
                event.req.headers.get("content-type") ?? undefined,
              );
            }
            if (event.req.method.toUpperCase() !== method) {
              event.res.status = 405;
              return { error: METHOD_NOT_ALLOWED };
            }

            if (method === "GET") {
              const raw = event.url.searchParams.get("args");
              if (raw) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // A malformed `?args=` is a malformed request, not a server
                  // fault, so it answers 400 like the non-array case above.
                  event.res.status = 400;
                  return { error: BAD_REQUEST };
                }
                if (!Array.isArray(parsed)) {
                  event.res.status = 400;
                  return { error: BAD_REQUEST };
                }
                args = parsed as JsonValue[];
              }
            } else {
              // Content-type enforcement: strict for json/text, lenient between forms.
              // Requests without a Content-Type header are exempt (curl/GET compat).
              // Checked BEFORE readBody so mismatched bodies are never buffered.
              if (
                hasContentTypeMismatch(
                  serverFunction.options?.contentType ?? "application/json",
                  event.req.headers.get("content-type") ?? undefined,
                )
              ) {
                event.res.status = 415;
                return { error: UNSUPPORTED_MEDIA_TYPE };
              }
              const body = await readBody(event, options.bodyLimit);
              args = Array.isArray(body.data)
                ? body.data as JsonValue[]
                : [body.data as JsonValue];
            }
            const requestEvent: RequestEvent = {
              request: event.req,
              response: event.res,
              nativeEvent: event,
              locals: event.context,
              functionName,
              // h3's `redirect()` returns an `HTTPResponse` (never writes directly),
              // so the bound redirect/send only record the intent; the middleware
              // uses them after the dispatch to return the response body.
              redirect: (location, status = 303) => {
                requestEvent.redirected = { location, status };
              },
              send: (status, body, headers) => {
                requestEvent.sent = { status, body, headers };
              },
            };
            // Input validation, before the handler is entered. The schema describes
            // this function's input — its first argument after the AbortSignal — and
            // a rejected input is a `422`, not a server fault. The validated output
            // replaces the raw argument, so the type flows from the schema into the
            // handler without a cast.
            const schema = serverFunction.options?.schema;
            if (schema) {
              const checked = await runValidation(schema, args[0], {
                hints: serverFunction.options?.hints,
                // A per-function hint leads, then rpc's own pointer to the docs,
                // so one function-wide `hint` does not cost the documentation link.
                hint: serverFunction.options?.hint
                  ? `${serverFunction.options.hint} — ${VALIDATION_HINT}`
                  : VALIDATION_HINT,
              });
              if (!checked.ok) throw checked.error;
              args = [checked.value as JsonValue, ...args.slice(1)];
            }

            // Raw arguments, recorded before validation and before the handler:
            // a rejected input is the case where the shape matters most, and it
            // is the pre-transform shape that answers "what did the client send".
            if (emit) seen.args = args;
            const fnResult = provideRequestContext(
              requestEvent,
              () => serverFunction.handler(...args),
            );
            const onClose = () => fnResult.cancel(CLIENT_DISCONNECTED);
            // The node runtime gives us the raw incoming stream for close events;
            // other runtimes have no node req, so the abort hook is skipped.
            const nodeReq = event.runtime?.node?.req;
            if (nodeReq) nodeReq.on("close", onClose);
            const result = await fnResult.data;
            // The no-JS success path, before the JSON send for the same ordering
            // reason as the `catch` — and only for a navigation, so a `fetch` from
            // the generated stub still gets its JSON.
            const successFlash = formSuccessLocation(
              serverFunction.options?.fallback,
              args[0],
              {
                method: event.req.method,
                contentType: event.req.headers.get("content-type") ?? undefined,
                accept: event.req.headers.get("accept") ?? undefined,
                secFetchDest: event.req.headers.get("sec-fetch-dest") ??
                  undefined,
                secFetchMode: event.req.headers.get("sec-fetch-mode") ??
                  undefined,
              },
            );
            // No `return` here: these two adapters funnel the response through
            // the `requestEvent.redirected` check below, and returning early
            // would skip the very branch that issues the redirect.
            // A handler may have issued its own redirect through the request
            // context. That is a more specific answer than the fallback's, so it
            // wins — otherwise a handler redirect would be silently replaced by
            // the author's fallback target.
            if (successFlash !== undefined && !requestEvent.redirected) {
              requestEvent.redirected = { location: successFlash, status: 303 };
            }
            if (nodeReq) nodeReq.off("close", onClose);

            if (requestEvent.redirected) {
              return h3Redirect(
                requestEvent.redirected.location,
                requestEvent.redirected.status,
              );
            }

            if (requestEvent.sent) {
              const { status, body, headers } = requestEvent.sent;
              event.res.status = status;
              if (headers) {
                for (const [name, value] of Object.entries(headers)) {
                  event.res.headers.set(name, value);
                }
              }
              return body;
            }

            return { data: result };
          } catch (err) {
            // h3 enforces its body limit while the stream is *read*, so an
            // oversized chunked request (one with no `Content-Length` to check up
            // front) throws here — inside this try — as an h3 error carrying status
            // 413. The other four adapters get their 413 from the host body parser
            // before rpc is reached, so flattening this to 500 would make h3 the
            // only adapter that reports an oversize body as a server fault. The
            // same rule covers rpc's own 400s for a malformed body or `?args`.
            // The no-JS flow goes **first**, ahead of the client-error branch:
            // a `ValidationError` is itself client-facing, so that branch would
            // claim it and render a `422` JSON body, leaving the only user this
            // feature exists for staring at raw JSON.
            const flash = formFallbackLocation(
              err,
              serverFunction.options?.fallback,
              args[0],
              {
                method: event.req.method,
                contentType: event.req.headers.get("content-type") ?? undefined,
                accept: event.req.headers.get("accept") ?? undefined,
                secFetchDest: event.req.headers.get("sec-fetch-dest") ??
                  undefined,
                secFetchMode: event.req.headers.get("sec-fetch-mode") ??
                  undefined,
              },
            );
            if (flash !== undefined) {
              seen.status = 303;
              return h3Redirect(flash);
            }
            // Reported here rather than by the wrapper: this adapter catches the
            // throw itself and returns a body, so nothing escapes `run` for a
            // wrapper to observe.
            seen.error = err;
            const isProduction = process.env.NODE_ENV === "production";
            if (isClientHttpError(err)) {
              const status = clientErrorStatus(err);
              event.res.status = status;
              return formatError(err, isProduction);
            }
            console.error(String(err));
            event.res.status = 500;
            return formatError(err, isProduction);
          }
        },
      }),
  });
};
