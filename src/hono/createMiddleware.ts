// src/hono/createMiddleware.ts
import type { Context, Next } from "hono";
import type {
  ContentfulStatusCode,
  RedirectStatusCode,
} from "hono/utils/http-status";
import type { HonoMiddlewareFn, HonoMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  createDispatcher,
  dispatchRequest,
  responseStatus,
  tagResponseId,
} from "../execution-log.ts";
import type { ContentType } from "../types.d.ts";
import { createMiddleware as createHonoMiddleware } from "hono/factory";
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
import { defaultMiddlewareOptions } from "../options.ts";
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
import { formFallbackLocation, formSuccessLocation } from "../form-fallback.ts";
import { readBody } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates a Hono middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * Uses Hono's factory `createMiddleware` to wrap the handler.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Hono middleware function
 */
export const createMiddleware: HonoMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as HonoMiddlewareOptions;

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

  const middlewareHandler = createHonoMiddleware(
    async (c: Context, next: Next) => {
      const reqUrl = safeURL(c.req.path);
      const url = reqUrl.pathname;

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
          serverFiles:
            (options as unknown as { serverFiles?: "exact" | "glob" })
              .serverFiles,
          scanRoot: (options as unknown as { scanRoot?: string }).scanRoot,
        } as never);
      }

      return (await handler(c, next)) as Response;
    },
  );

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Hono RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and returns the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Hono middleware function
 */
export const createRPCMiddleware: HonoMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as HonoMiddlewareOptions;

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
    handler: async (c: Context, _next: Next) =>
      await dispatchRequest<Response | undefined>({
        emit,
        prefix,
        method: () => c.req.method,
        // From the returned `Response`, not `c.res`: hono's `c.json(body, 404)`
        // does not set the context response inside the handler, so reading
        // `c.res` here would report 200 for every failure.
        readStatus: responseStatus,
        // hono returns a `Response` rather than writing a body anywhere the
        // adapter owns, so the id is merged by re-serialising it.
        withId: tagResponseId,
        run: async (seen) => {
          const { path: reqPath } = c.req;
          // const { rpcPrefix: prefix } = options;

          // Defense-in-depth: validate prefix match via escaped regex even though
          // the outer createMiddleware gates on the same prefix already.
          // istanbul ignore if
          if (prefixRegex && !prefixRegex.test(reqPath)) {
            /* istanbul ignore next */
            return;
          }

          // Cross-origin check, on by default (`origin: "self"`). `Origin` decides
          // when present; `Sec-Fetch-Site` is the fail-closed fallback once it is
          // gone; headerless clients are opt-in via `allowHeaderless`. The Host
          // header is used only for the host-only "self" comparison — no forwarded
          // header is trusted. See `isOriginRequestAllowed` for the three tiers.
          const origin = describeOriginRequest({
            allowed: options.origin,
            origin: c.req.header("origin"),
            site: c.req.header("sec-fetch-site"),
            host: c.req.header("host"),
            allowHeaderless: options.allowHeaderless,
          });
          seen.originTier = origin.tier;
          if (!origin.allowed) {
            return c.json({ error: REQUEST_FORBIDDEN }, 403);
          }

          const functionName = reqPath.replace(prefixReplace, "");
          const forPrefix = getFunctionsForPrefix(prefix);
          const serverFunction = forPrefix.get(functionName);
          if (emit) {
            seen.functionName = functionName;
            // The sibling names turn "Function not found" into a question an agent
            // can actually answer.
            seen.registered = [...forPrefix.keys()];
            seen.actualContentType = c.req.header("content-type");
          }

          if (!serverFunction) {
            return c.json({ error: FUNCTION_NOT_FOUND }, 404);
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
                c.req.header("content-type"),
              );
            }
            if (c.req.method.toUpperCase() !== method) {
              return c.json({ error: METHOD_NOT_ALLOWED }, 405);
            }

            if (method === "GET") {
              const raw = c.req.query("args");
              if (raw) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // A malformed `?args=` is a malformed request, not a server
                  // fault, so it answers 400 like the non-array case above.
                  return c.json({ error: BAD_REQUEST }, 400);
                }
                if (!Array.isArray(parsed)) {
                  return c.json({ error: BAD_REQUEST }, 400);
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
                  c.req.header("content-type"),
                )
              ) {
                return c.json({ error: UNSUPPORTED_MEDIA_TYPE }, 415);
              }
              const body = await readBody(c, options.bodyLimit);
              args = Array.isArray(body.data)
                ? body.data as JsonValue[]
                : [body.data as JsonValue];
            }
            const requestEvent: RequestEvent = {
              request: c.req,
              response: c.res,
              nativeEvent: c,
              locals: {},
              functionName,
              // Hono's `c.redirect`/`c.json` return a `Response` (never write
              // directly), so the bound redirect/send only record the intent; the
              // middleware uses them after the dispatch to return the Response.
              redirect: (location, status = 303) => {
                requestEvent.redirected = { location, status };
              },
              send: (status, body, headers) => {
                requestEvent.sent = { status, body, headers };
              },
              // Hono's `c.redirect`/`c.json`/`c.body` return a `Response` built
              // after the dispatch; `c.header()` state is merged into it by
              // `#newResponse`.
              header: (name, value) => {
                c.header(name, value);
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

            const fnResult = provideRequestContext(
              requestEvent,
              // Raw arguments, recorded before validation: a rejected input is the
              // case where the shape matters most, and it is the pre-transform shape
              // that answers "what did the client send".
              () => {
                if (emit) seen.args = args;
                return serverFunction.handler(...args);
              },
            );
            const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
            // The runtime adapter may be absent in some Hono environments
            // (e.g. Workers, Bun, Deno, standalone serverless adapters), so guard
            // the close hook. `c.env?.incoming?.` — the `?.` after `incoming` alone
            // guards a null `incoming`, not an undefined `c.env`, which is what
            // actually threw here and turned every request into a 500.
            c.env?.incoming?.on("close", onAbort);
            const result = await fnResult.data;
            // The no-JS success path, before the JSON send for the same ordering
            // reason as the `catch` — and only for a navigation, so a `fetch` from
            // the generated stub still gets its JSON.
            const successFlash = formSuccessLocation(
              serverFunction.options?.fallback,
              args[0],
              {
                method: c.req.method,
                contentType: c.req.header("content-type"),
                accept: c.req.header("accept"),
                secFetchDest: c.req.header("sec-fetch-dest"),
                secFetchMode: c.req.header("sec-fetch-mode"),
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
            c.env?.incoming?.off("close", onAbort);

            if (requestEvent.redirected) {
              return c.redirect(
                requestEvent.redirected.location,
                requestEvent.redirected.status as RedirectStatusCode,
              ) as Response;
            }

            if (requestEvent.sent) {
              const { status, body, headers } = requestEvent.sent;
              return c.body(
                JSON.stringify(body),
                status as ContentfulStatusCode,
                {
                  "content-type": "application/json",
                  ...headers,
                },
              );
            }

            return c.json({ data: result }, 200);
          } catch (err) {
            // A malformed request is a client error, not a server fault. rpc raises
            // these with a status (see `httpError`), and host frameworks signal the
            // same class the same way — h3's body limit throws 413 from inside the
            // read, Express's body-parser throws 400, and Fastify's parser does the
            // same before rpc is reached. Answering 500 for any of them both
            // misreports the fault and turns a trivial client mistake into a log
            // entry. The body comes from a fixed table, so nothing from the
            // The no-JS flow goes **first**, ahead of the client-error branch:
            // a `ValidationError` is itself client-facing, so that branch would
            // claim it and render a `422` JSON body, leaving the only user this
            // feature exists for staring at raw JSON.
            const flash = formFallbackLocation(
              err,
              serverFunction.options?.fallback,
              args[0],
              {
                method: c.req.method,
                contentType: c.req.header("content-type"),
                accept: c.req.header("accept"),
                secFetchDest: c.req.header("sec-fetch-dest"),
                secFetchMode: c.req.header("sec-fetch-mode"),
              },
            );
            if (flash !== undefined) {
              seen.status = 303;
              return c.redirect(flash, 303);
            }
            // underlying error is echoed back.
            // Reported here rather than by the wrapper: this adapter catches the
            // throw itself and returns a `c.json(...)`, so nothing escapes `run`.
            seen.error = err;
            const isProduction = process.env.NODE_ENV === "production";
            if (isClientHttpError(err)) {
              const status = clientErrorStatus(err);
              return c.json(
                formatError(err, isProduction),
                status as ContentfulStatusCode,
              );
            }
            console.error(String(err));
            return c.json(formatError(err, isProduction), 500);
          }
        },
      }),
  });
};
