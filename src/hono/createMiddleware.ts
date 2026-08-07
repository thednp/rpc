// src/hono/createMiddleware.ts
import type { Context, Next } from "hono";
import type { HonoMiddlewareFn, HonoMiddlewareOptions } from "./types.d.ts";
import type { JsonValue } from "../types.d.ts";
import { createMiddleware as createHonoMiddleware } from "hono/factory";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { defaultMiddlewareOptions, defaultRPCOptions } from "../options.ts";
import { escapeRegExp } from "../tools.ts";
import { formatError } from "../server-helpers.ts";
import {
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
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

  const middlewareHandler = createHonoMiddleware(
    async (c: Context, next: Next) => {
      const reqUrl = new URL(c.req.path, "http://localhost");
      const url = reqUrl.pathname;

      if (serverFunctionsMap.size === 0) {
        await scanForServerFiles();
      }

      // No need to continue when no handler provided
      if (!handler) {
        await next();
        return;
      }

      if (pathMatcher && !pathMatcher.test(url)) {
        await next();
        return;
      }

      if (prefixRegex && !prefixRegex.test(url)) {
        await next();
        return;
      }

      return await handler(c, next);
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
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${rpcPrefix}/`;

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
      const serverFunction = serverFunctionsMap.get(functionName);

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
          // istanbul ignore else
          if (raw) args = JSON.parse(raw);
        } else {
          const body = await readBody(c);
          args = Array.isArray(body.data)
            ? body.data as JsonValue[]
            : [body.data as JsonValue];
        }
        const fnResult = serverFunction.handler(...args);
        const onAbort = () => fnResult.cancel(CLIENT_DISCONNECTED);
        // The runtime adapter may be absent in some Hono environments
        // (e.g. standalone serverless adapters), so guard the close hook.
        c.env.incoming?.on("close", onAbort);
        const result = await fnResult.data;
        c.env.incoming?.off("close", onAbort);

        return c.json({ data: result }, 200);
      } catch (err) {
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        return c.json(formatError(err, isProduction), 500);
      }
    },
  });
};
