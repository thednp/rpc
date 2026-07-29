// src/express/createMidleware.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type {
  ExpressMiddlewareFn,
  ExpressMiddlewareOptions,
} from "./types.d.ts";
import type { Connect } from "vite";
// import type { JsonArray, JsonValue } from "@thednp/rpc";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { defaultMiddlewareOptions, defaultRPCOptions } from "../options.ts";
import { getRequestDetails, getResponseDetails, readBody } from "./helpers.ts";
import { escapeRegExp } from "../tools.ts";
import {
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  INTERNAL_SERVER_ERROR,
  MIDDLEWARE_NAME_USED,
} from "../constants.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

export const createMiddleware: ExpressMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as ExpressMiddlewareOptions;
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

  const middlewareHandler = async (
    req: IncomingMessage | ExpressRequest,
    _res: ServerResponse | ExpressResponse,
    next: Connect.NextFunction | NextFunction,
  ) => {
    const { url } = getRequestDetails(req);

    // When serving from production server, scan for server files
    if (serverFunctionsMap.size === 0) {
      await scanForServerFiles();
    }

    // No need to continue when no handler provided
    if (!handler) {
      return next?.();
    }

    // Path matching
    if (pathMatcher && !pathMatcher.test(url)) return next?.();

    // rpcPrefix matching (boundary-safe via escaped regex)
    if (prefixRegex && !prefixRegex.test(url)) {
      return next?.();
    }

    // Execute handler
    await handler(req, _res, next);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

// Create RPC middleware
export const createRPCMiddleware: ExpressMiddlewareFn = (
  initialOptions = {},
) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    { rpcPrefix: defaultRPCOptions.rpcPrefix },
    initialOptions,
  ) as ExpressMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPrefix = options.rpcPrefix;
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${rpcPrefix}/`;

  return createMiddleware({
    ...options,
    handler: async (
      req: IncomingMessage | ExpressRequest,
      res: ServerResponse | ExpressResponse,
      _next: NextFunction | Connect.NextFunction,
    ) => {
      const { url } = getRequestDetails(req);
      const { sendResponse } = getResponseDetails(res);

      // Validate the url starts with the prefix via the escaped regex
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(url)) {
        // falls through to next handler (never reached in practice; the outer
        // createMiddleware already gates on this, but kept for defense-in-depth)
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = serverFunctionsMap.get(functionName);

      if (!serverFunction) {
        sendResponse(404, { error: FUNCTION_NOT_FOUND });
        return;
      }

      try {
        const body = await readBody(req);
        const args = Array.isArray(body.data) ? body.data : [body.data];
        const { data, cancel } = serverFunction.handler(...args);
        const onClose = () => cancel(CLIENT_DISCONNECTED);

        req.on("close", onClose);
        const result = await data;
        req.off("close", onClose);

        // istanbul ignore else
        if (!res.headersSent) sendResponse(200, { data: result });
      } catch (err) {
        console.error(String(err));
        sendResponse(500, { error: INTERNAL_SERVER_ERROR });
      }
    },
  });
};
