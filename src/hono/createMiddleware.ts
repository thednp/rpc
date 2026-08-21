// src/hono/createMiddleware.ts
import type { Context, Next } from "hono";
import type {
  ContentfulStatusCode,
  RedirectStatusCode,
} from "hono/utils/http-status";
import type { HonoMiddlewareFn, HonoMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
import { createMiddleware as createHonoMiddleware } from "hono/factory";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  escapeRegExp,
  formatError,
  hasContentTypeMismatch,
  provideRequestContext,
  safeURL,
  scanForServerFiles,
} from "@thednp/rpc/server";
import {
  ensurePrefixFromGlobal,
  getFunctionsForPrefix,
} from "../functionsMap.ts";
import {
  defaultMiddlewareOptions,
  defaultPrefix,
  defaultRPCOptions,
  setGlobalPrefix,
} from "../options.ts";
import {
  BAD_REQUEST,
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
  UNSUPPORTED_MEDIA_TYPE,
} from "../constants.ts";
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

      rpcPrefix = (rpcPrefix ?? defaultPrefix) as string;
      ensurePrefixFromGlobal(rpcPrefix);

      // When serving from production server, scan for server files
      if (getFunctionsForPrefix(rpcPrefix).size === 0) {
        await scanForServerFiles({
          rpcPrefix,
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
    { rpcPrefix: defaultRPCOptions.rpcPrefix },
    initialOptions,
  ) as HonoMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefix = rpcPrefix || defaultPrefix;
  if (rpcPrefix) setGlobalPrefix(rpcPrefix as string);
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${prefix}/`;

  return createMiddleware({
    ...options,
    handler: async (c: Context, _next: Next) => {
      const { path: reqPath } = c.req;
      // const { rpcPrefix: prefix } = options;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore if
      if (prefixRegex && !prefixRegex.test(reqPath)) {
        /* istanbul ignore next */
        return;
      }

      // Optional origin check: reject requests whose Origin header does not
      // match the configured origin. Requests without an Origin header
      // (curl, native clients) pass through unchecked.
      const origin = options.origin;
      const requestOrigin = c.req.header("origin");
      if (origin && requestOrigin && requestOrigin !== origin) {
        return c.json({ error: REQUEST_FORBIDDEN }, 403);
      }

      const functionName = reqPath.replace(prefixReplace, "");
      ensurePrefixFromGlobal(prefix);
      const serverFunction = getFunctionsForPrefix(prefix).get(functionName);

      if (!serverFunction) {
        return c.json({ error: FUNCTION_NOT_FOUND }, 404);
      }

      try {
        const method = serverFunction.options?.method || "POST";
        if (c.req.method.toUpperCase() !== method) {
          return c.json({ error: METHOD_NOT_ALLOWED }, 405);
        }

        let args: JsonValue[] = [];
        if (method === "GET") {
          const raw = c.req.query("args");
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
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
          const body = await readBody(c);
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
        };
        const fnResult = provideRequestContext(
          requestEvent,
          () => serverFunction.handler(...args),
        );
        const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
        // The runtime adapter may be absent in some Hono environments
        // (e.g. standalone serverless adapters), so guard the close hook.
        c.env.incoming?.on("close", onAbort);
        const result = await fnResult.data;
        c.env.incoming?.off("close", onAbort);

        if (requestEvent.redirected) {
          return c.redirect(
            requestEvent.redirected.location,
            requestEvent.redirected.status as RedirectStatusCode,
          ) as Response;
        }

        if (requestEvent.sent) {
          const { status, body, headers } = requestEvent.sent;
          return c.body(JSON.stringify(body), status as ContentfulStatusCode, {
            "content-type": "application/json",
            ...headers,
          });
        }

        return c.json({ data: result }, 200);
      } catch (err) {
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        return c.json(formatError(err, isProduction), 500);
      }
    },
  });
};
