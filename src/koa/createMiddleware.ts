// src/koa/createMiddleware.ts
import type { Context, Next } from "koa";
import type { KoaMiddlewareFn, KoaMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  clientErrorMessage,
  clientErrorStatus,
  escapeRegExp,
  formatError,
  hasContentTypeMismatch,
  isClientHttpError,
  isOriginRequestAllowed,
  provideRequestContext,
  resolveRPCPrefix,
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
} from "../constants.ts";

import { defaultMiddlewareOptions } from "../options.ts";
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

  return createMiddleware({
    ...options,
    // Hand the resolved prefix down so the gate and the dispatch agree.
    rpcPrefix: prefix,
    handler: async (ctx: Context, _next: Next) => {
      const reqUrl = safeURL(ctx.url);
      const url = reqUrl.pathname;
      // const { rpcPrefix } = options;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(url)) {
        return;
      }

      // Optional origin check. When Origin survives, the allowlist decides;
      // when it has been stripped, Sec-Fetch-Site is consulted instead and
      // fails closed. See `isOriginRequestAllowed` for the four tiers.
      if (
        !isOriginRequestAllowed(
          options.origin,
          ctx.headers.origin,
          ctx.headers["sec-fetch-site"],
        )
      ) {
        ctx.status = 403;
        ctx.body = { error: REQUEST_FORBIDDEN };
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = getFunctionsForPrefix(prefix).get(functionName);

      if (!serverFunction) {
        ctx.status = 404;
        ctx.body = { error: FUNCTION_NOT_FOUND };
        return;
      }

      try {
        const method = serverFunction.options?.method || "POST";
        if (ctx.method.toUpperCase() !== method) {
          ctx.status = 405;
          ctx.body = { error: METHOD_NOT_ALLOWED };
          return;
        }

        let args: JsonValue[] = [];
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
          const body = await readBody(ctx);
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
        };
        const { data: resultData, cancel } = provideRequestContext(
          requestEvent,
          () => serverFunction.handler(...args),
        );
        const onClose = () => cancel(CLIENT_DISCONNECTED);
        ctx.req.on("close", onClose);
        const result = await resultData;
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
        // misreports the fault and turns a trivial client mistake into a log
        // entry. The body comes from a fixed table, so nothing from the
        // underlying error is echoed back.
        if (isClientHttpError(err)) {
          const status = clientErrorStatus(err);
          ctx.status = status;
          ctx.body = { error: clientErrorMessage(status) };
          return;
        }
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        ctx.status = 500;
        ctx.body = formatError(err, isProduction);
      }
    },
  });
};
