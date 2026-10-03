// src/koa/createMiddleware.ts
import type { Context, Next } from "koa";
import type { KoaMiddlewareFn, KoaMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import type { ContentType } from "../types.d.ts";
import {
  createDispatcher,
  dispatchRequest,
  tagBodyId,
} from "../execution-log.ts";
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
  safeURL,
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
import { readBody, redirect as koaRedirect } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates a Koa middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * Koa URL is normalized via `new URL()` to strip query strings before matching.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Koa middleware function
 */
export const createMiddleware: KoaMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as KoaMiddlewareOptions;

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

  const middlewareHandler = async (ctx: Context, next: Next) => {
    const url = safeURL(ctx.url).pathname;

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

    await handler(ctx, next);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Koa RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sets the JSON-serialized result on ctx.body.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Koa middleware function
 */
export const createRPCMiddleware: KoaMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as KoaMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = resolveRPCPrefix(rpcPrefix);
  const prefixRegex = new RegExp(`^/${escapeRegExp(prefix)}/`);
  const prefixReplace = `/${prefix}/`;

  // One emitter per middleware, holding no request state.
  const emit = createDispatcher(options.onDispatch);

  return createMiddleware({
    ...options,
    // Hand the resolved prefix down so the gate and the dispatch agree.
    rpcPrefix: prefix,
    handler: async (ctx: Context, _next: Next) =>
      await dispatchRequest<void>({
        emit,
        prefix,
        method: () => ctx.method,
        readStatus: () => ctx.status,
        // koa writes the body onto the context rather than returning it, so the
        // id is merged into `ctx.body` and the handler's own return value (which
        // is nothing) is passed through untouched.
        withId: (_result, id) => {
          ctx.body = tagBodyId(ctx.body, id);
          return undefined;
        },
        run: async (seen) => {
          const reqUrl = safeURL(ctx.url);
          const url = reqUrl.pathname;
          // const { rpcPrefix } = options;

          // Defense-in-depth: validate prefix match via escaped regex even though
          // the outer createMiddleware gates on the same prefix already.
          // istanbul ignore next
          if (prefixRegex && !prefixRegex.test(url)) {
            return;
          }

          // Cross-origin check, on by default (`origin: "self"`). `Origin` decides
          // when present; `Sec-Fetch-Site` is the fail-closed fallback once it is
          // gone; headerless clients are opt-in via `allowHeaderless`. The Host
          // header is used only for the host-only "self" comparison — no forwarded
          // header is trusted. See `isOriginRequestAllowed` for the three tiers.
          const origin = describeOriginRequest({
            allowed: options.origin,
            origin: ctx.headers.origin,
            site: ctx.headers["sec-fetch-site"],
            host: ctx.headers.host,
            allowHeaderless: options.allowHeaderless,
          });
          seen.originTier = origin.tier;
          if (!origin.allowed) {
            ctx.status = 403;
            ctx.body = { error: REQUEST_FORBIDDEN };
            return;
          }

          const functionName = url.replace(prefixReplace, "");
          const forPrefix = getFunctionsForPrefix(prefix);
          const serverFunction = forPrefix.get(functionName);
          if (emit) {
            seen.functionName = functionName;
            // The sibling names turn "Function not found" into a question an agent
            // can actually answer.
            seen.registered = [...forPrefix.keys()];
            seen.actualContentType = ctx.headers["content-type"];
          }

          if (!serverFunction) {
            ctx.status = 404;
            ctx.body = { error: FUNCTION_NOT_FOUND };
            return;
          }
          // Out here rather than inside the `try` so the `catch` can read the submitted
          // first argument: a no-JS failure redirects, and the flash can only replay
          // what was actually sent.
          let args: JsonValue[] = [];

          try {
            const method = serverFunction.options?.method || "POST";
            if (emit) {
              seen.declaredMethod = method;
              seen.declaredContentType = serverFunction.options?.contentType ??
                "application/json";
              seen.contentTypeMatched = !hasContentTypeMismatch(
                seen.declaredContentType as ContentType,
                ctx.headers["content-type"],
              );
            }
            if (ctx.method.toUpperCase() !== method) {
              ctx.status = 405;
              ctx.body = { error: METHOD_NOT_ALLOWED };
              return;
            }

            if (method === "GET") {
              const raw = reqUrl.searchParams.get("args");
              if (raw) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // A malformed `?args=` is a malformed request, not a server
                  // fault, so it answers 400 like the non-array case above.
                  ctx.status = 400;
                  ctx.body = { error: BAD_REQUEST };
                  return;
                }
                if (!Array.isArray(parsed)) {
                  ctx.status = 400;
                  ctx.body = { error: BAD_REQUEST };
                  return;
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
                  ctx.headers["content-type"],
                )
              ) {
                ctx.status = 415;
                ctx.body = { error: UNSUPPORTED_MEDIA_TYPE };
                return;
              }
              const body = await readBody(ctx, options.bodyLimit);
              args = Array.isArray(body.data)
                ? body.data as JsonValue[]
                : [body.data as JsonValue];
            }
            const requestEvent: RequestEvent = {
              request: ctx.req,
              response: ctx,
              nativeEvent: ctx,
              locals: ctx.state,
              functionName,
              redirect: (location, status = 303) => {
                requestEvent.redirected = { location, status };
                koaRedirect(ctx, location, status);
              },
              send: (status, body, headers) => {
                requestEvent.sent = { status, body, headers };
                if (headers) {
                  for (const [name, value] of Object.entries(headers)) {
                    ctx.set(name, value);
                  }
                }
                ctx.status = status;
                ctx.body = body;
              },
              header: (name, value) => {
                // Koa flushes after the middleware chain, so the bag write
                // always lands before the response — no commit guard exists
                // to check here. `typeof` narrows cleanly where
                // `Array.isArray` does not (see the express adapter); an
                // empty array sets nothing.
                if (typeof value !== "string" && value.length === 0) return;
                ctx.set(name, typeof value === "string" ? value : [...value]);
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
              args = [checked.value as JsonValue];
            }

            const { data: resultData, cancel } = provideRequestContext(
              requestEvent,
              // Raw arguments, recorded before validation: a rejected input is the
              // case where the shape matters most, and it is the pre-transform shape
              // that answers "what did the client send".
              () => {
                if (emit) seen.args = args;
                // Single input: the wire is still an array, and its first
                // element is the call's input. Always passed explicitly
                // (possibly `undefined`) so dispatch and direct calls
                // observe the same shape.
                return serverFunction.handler(args[0]);
              },
            );
            const onClose = () => cancel(CLIENT_DISCONNECTED);
            ctx.req.on("close", onClose);
            const result = await resultData;
            // The no-JS success path, before the JSON send for the same ordering
            // reason as the `catch` — and only for a navigation, so a `fetch` from the
            // generated stub still gets its JSON.
            const successFlash = formSuccessLocation(
              serverFunction.options?.fallback,
              args[0],
              {
                method: ctx.method,
                contentType: ctx.headers["content-type"] as string | undefined,
                accept: ctx.headers["accept"] as string | undefined,
                secFetchDest: ctx.headers["sec-fetch-dest"] as
                  | string
                  | undefined,
                secFetchMode: ctx.headers["sec-fetch-mode"] as
                  | string
                  | undefined,
              },
            );
            // A handler may have issued its own redirect through the request
            // context. That is a more specific answer than the fallback's, so it
            // wins — otherwise a handler redirect would be silently replaced by
            // the author's fallback target.
            if (successFlash !== undefined && !requestEvent.redirected) {
              requestEvent.redirected = { location: successFlash, status: 303 };
              koaRedirect(ctx, successFlash);
              return;
            }
            ctx.req.off("close", onClose);

            // Skip the JSON send when the server function issued a redirect or
            // short-circuited with `send`; the bound Koa adapter already set
            // ctx.status/ctx.body.
            // istanbul ignore else
            if (!requestEvent.redirected && !requestEvent.sent) {
              ctx.status = 200;
              ctx.body = { data: result };
            }
          } catch (err) {
            // A malformed request is a client error, not a server fault. rpc raises
            // these with a status (see `httpError`), and host frameworks signal the
            // same class the same way — h3's body limit throws 413 from inside the
            // read, Express's body-parser throws 400, and Fastify's parser does the
            // same before rpc is reached. Answering 500 for any of them both
            // The no-JS flow goes **first**, ahead of the client-error branch below:
            // a `ValidationError` is itself client-facing, so that branch would claim it
            // and render a `422` JSON body, leaving the only user this feature exists
            // for staring at raw JSON.
            const flash = formFallbackLocation(
              err,
              serverFunction.options?.fallback,
              args[0],
              {
                method: ctx.method,
                contentType: ctx.headers["content-type"] as string | undefined,
                accept: ctx.headers["accept"] as string | undefined,
                secFetchDest: ctx.headers["sec-fetch-dest"] as
                  | string
                  | undefined,
                secFetchMode: ctx.headers["sec-fetch-mode"] as
                  | string
                  | undefined,
              },
            );
            if (flash !== undefined) {
              seen.status = 303;
              koaRedirect(ctx, flash);
              return;
            }
            // misreports the fault and turns a trivial client mistake into a log
            // entry. The body comes from a fixed table, so nothing from the
            // underlying error is echoed back.
            // Reported here rather than by the wrapper: this adapter catches the
            // throw itself and writes the body, so nothing escapes `run`.
            seen.error = err;
            const isProduction = process.env.NODE_ENV === "production";
            if (isClientHttpError(err)) {
              const status = clientErrorStatus(err);
              ctx.status = status;
              ctx.body = formatError(err, isProduction);
              return;
            }
            console.error(String(err));
            ctx.status = 500;
            ctx.body = formatError(err, isProduction);
          }
        },
      }),
  });
};
