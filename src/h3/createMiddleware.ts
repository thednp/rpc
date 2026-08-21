// src/h3/createMiddleware.ts
import type { H3Event, Middleware } from "h3";
import type { H3MiddlewareFn, H3MiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  escapeRegExp,
  formatError,
  getGlobalPrefix,
  hasContentTypeMismatch,
  provideRequestContext,
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
import {
  defaultMiddlewareOptions,
  defaultPrefix,
  defaultRPCOptions,
} from "../options.ts";
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
  let rpcPrefix = options.rpcPrefix;
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
  const prefixRegex: RegExp | null = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
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

    rpcPrefix = rpcPrefix || getGlobalPrefix() || defaultPrefix;

    // When serving from production server, scan for server files
    if (getFunctionsForPrefix(rpcPrefix).size === 0) {
      await scanForServerFiles({
        rpcPrefix,
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
    { rpcPrefix: defaultRPCOptions.rpcPrefix },
    initialOptions,
  ) as H3MiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = rpcPrefix || defaultPrefix;
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${prefix}/`;

  return createMiddleware({
    ...options,
    handler: async (event: H3Event, _next?: () => unknown) => {
      const url = event.url.pathname;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore if
      if (prefixRegex && !prefixRegex.test(url)) {
        /* istanbul ignore next */
        return undefined;
      }

      // Optional origin check: reject requests whose Origin header does not
      // match the configured origin. Requests without an Origin header
      // (curl, native clients) pass through unchecked.
      const origin = options.origin;
      const requestOrigin = event.req.headers.get("origin") ?? undefined;
      if (origin && requestOrigin && requestOrigin !== origin) {
        event.res.status = 403;
        return { error: REQUEST_FORBIDDEN };
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = getFunctionsForPrefix(prefix).get(functionName);

      if (!serverFunction) {
        event.res.status = 404;
        return { error: FUNCTION_NOT_FOUND };
      }

      try {
        const method = serverFunction.options?.method || "POST";
        if (event.req.method.toUpperCase() !== method) {
          event.res.status = 405;
          return { error: METHOD_NOT_ALLOWED };
        }

        let args: JsonValue[] = [];
        if (method === "GET") {
          const raw = event.url.searchParams.get("args");
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
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
          const body = await readBody(event);
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
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        event.res.status = 500;

        return formatError(err, isProduction);
      }
    },
  });
};
