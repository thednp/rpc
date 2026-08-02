// src/koa/createMiddleware.ts
import type { Context, Next } from "koa";
import type { KoaMiddlewareFn, KoaMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "../types.d.ts";
import { escapeRegExp } from "../tools.ts";
import {
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  INTERNAL_SERVER_ERROR,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
} from "../constants.ts";

import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { defaultMiddlewareOptions, defaultRPCOptions } from "../options.ts";
import { readBody } from "./helpers.ts";

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
  const prefixRegex: RegExp | null = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : null;
  const pathMatcher: RegExp | null = path
    ? (typeof path === "string" ? new RegExp(path) : path)
    : null;

  const middlewareHandler = async (ctx: Context, next: Next) => {
    const url = new URL(ctx.url, "http://localhost").pathname;

    if (serverFunctionsMap.size === 0) {
      await scanForServerFiles();
    }

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
    { rpcPrefix: defaultRPCOptions.rpcPrefix },
    initialOptions,
  ) as KoaMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${rpcPrefix}/`;

  return createMiddleware({
    ...options,
    handler: async (ctx: Context, _next: Next) => {
      const reqUrl = new URL(ctx.url, "http://localhost");
      const url = reqUrl.pathname;
      // const { rpcPrefix } = options;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(url)) {
        return;
      }

      // Optional origin check: reject requests whose Origin header does not
      // match the configured origin. Requests without an Origin header
      // (curl, native clients) pass through unchecked.
      const origin = options.origin;
      const requestOrigin = ctx.headers.origin;
      if (origin && requestOrigin && requestOrigin !== origin) {
        ctx.status = 403;
        ctx.body = { error: REQUEST_FORBIDDEN };
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = serverFunctionsMap.get(functionName);

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
          if (raw) args = JSON.parse(raw);
        } else {
          const body = await readBody(ctx);
          args = Array.isArray(body.data) ? body.data : [body.data];
        }
        const { data: resultData, cancel } = serverFunction.handler(...args);
        const onClose = () => cancel(CLIENT_DISCONNECTED);
        ctx.req.on("close", onClose);
        const result = await resultData;
        ctx.req.off("close", onClose);
        ctx.status = 200;
        ctx.body = { data: result };
      } catch (err) {
        console.error(String(err));
        ctx.status = 500;
        ctx.body = { error: INTERNAL_SERVER_ERROR };
      }
    },
  });
};
