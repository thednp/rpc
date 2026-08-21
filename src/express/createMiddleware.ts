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
import type { JsonValue } from "../types.d.ts";
import type { RequestEvent } from "@thednp/rpc/server";
import {
  escapeRegExp,
  formatError,
  hasContentTypeMismatch,
  provideRequestContext,
  scanForServerFiles,
} from "@thednp/rpc/server";
import { getFunctionsForPrefix } from "../functionsMap.ts";
import {
  defaultMiddlewareOptions,
  defaultPrefix,
  defaultRPCOptions,
} from "../options.ts";
import {
  getRequestDetails,
  getResponseDetails,
  readBody,
  redirect as expressRedirect,
} from "./helpers.ts";
import {
  BAD_REQUEST,
  CLIENT_DISCONNECTED,
  FUNCTION_NOT_FOUND,
  METHOD_NOT_ALLOWED,
  MIDDLEWARE_NAME_USED,
  REQUEST_FORBIDDEN,
  UNSUPPORTED_MEDIA_TYPE,
} from "../constants.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates an Express middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated — reusing a name throws an error.
 * Prefix and path regexes are compiled once at creation time (hoisted) for performance.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns An Express middleware function
 */
export const createMiddleware: ExpressMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as ExpressMiddlewareOptions;
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

  const middlewareHandler = async (
    req: IncomingMessage | ExpressRequest,
    res: ServerResponse | ExpressResponse,
    next: Connect.NextFunction | NextFunction,
  ) => {
    const { url } = getRequestDetails(req);

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

    rpcPrefix = (rpcPrefix ?? defaultPrefix) as string;

    // When serving from production server, scan for server files
    if (getFunctionsForPrefix(rpcPrefix).size === 0) {
      await scanForServerFiles({
        rpcPrefix,
        serverFiles: (options as unknown as { serverFiles?: "exact" | "glob" })
          .serverFiles,
        scanRoot: (options as unknown as { scanRoot?: string }).scanRoot,
      } as never);
    }

    // Execute handler
    await handler(req, res, next);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Express RPC middleware that routes incoming requests to registered server functions.
 * Reads the request body, dispatches to the matching function via getFunctionsForPrefix,
 * and sends the JSON-serialized result. Handles client disconnection via abort signals.
 * Supports multi-prefix setups where different middleware instances can route to functions
 * registered under different prefixes.
 * @param initialOptions - Options including rpcPrefix for URL routing and prefix-scoped function lookup
 * @returns An Express middleware function
 */
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
  const prefix = rpcPrefix || defaultPrefix;
  const prefixRegex = rpcPrefix
    ? new RegExp(`^/${escapeRegExp(rpcPrefix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${prefix}/`;

  return createMiddleware({
    ...options,
    handler: async (
      req: IncomingMessage | ExpressRequest,
      res: ServerResponse | ExpressResponse,
      _next: NextFunction | Connect.NextFunction,
    ) => {
      const { url: path, searchParams } = getRequestDetails(req);
      const { sendResponse } = getResponseDetails(res);

      // Validate the url starts with the prefix via the escaped regex
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(path)) {
        // falls through to next handler (never reached in practice; the outer
        // createMiddleware already gates on this, but kept for defense-in-depth)
        return;
      }

      // Optional origin check: reject requests whose Origin header does not
      // match the configured origin. Requests without an Origin header
      // (curl, native clients) pass through unchecked.
      const origin = options.origin;
      const requestOrigin = req.headers.origin;
      if (origin && requestOrigin && requestOrigin !== origin) {
        sendResponse(403, { error: REQUEST_FORBIDDEN });
        return;
      }

      const functionName = path.replace(prefixReplace, "");
      // Look up function in the prefix-scoped map
      const serverFunctionsForPrefix = getFunctionsForPrefix(prefix);
      const serverFunction = serverFunctionsForPrefix.get(functionName);

      if (!serverFunction) {
        sendResponse(404, { error: FUNCTION_NOT_FOUND });
        return;
      }

      try {
        const method = serverFunction.options?.method || "POST";
        if (req.method?.toUpperCase() !== method) {
          sendResponse(405, { error: METHOD_NOT_ALLOWED });
          return;
        }

        let args: JsonValue[] = [];
        if (method === "GET") {
          const raw = searchParams.get("args");
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              sendResponse(400, { error: BAD_REQUEST });
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
              req.headers["content-type"],
            )
          ) {
            sendResponse(415, { error: UNSUPPORTED_MEDIA_TYPE });
            return;
          }
          const body = await readBody(req);
          args = Array.isArray(body.data)
            ? (body.data as JsonValue[])
            : [body.data as JsonValue];
        }
        // ─── Dispatch ────────────────────────────────────────────────────
        // Establish the per-request context around the *entire* dispatch so
        // server functions (and async continuations spawned by their work)
        // read `getRequestContext()` and can call the framework-level
        // `redirect(location)`. The adapter-specific redirect is bound into the
        // context here; `serverFunction.handler` must be invoked inside the
        // context callback so its async increments run with the context live.
        const requestEvent: RequestEvent = {
          request: req,
          response: res,
          nativeEvent: { req, res },
          locals: (res as ExpressResponse).locals ?? {},
          functionName,
          redirect: (location, status = 303) => {
            requestEvent.redirected = { location, status };
            expressRedirect(res, location, status);
          },
          send: (status, body, headers) => {
            requestEvent.sent = { status, body, headers };
            const details = getResponseDetails(res);
            if (headers) {
              for (const [name, value] of Object.entries(headers)) {
                details.setHeader(name, value);
              }
            }
            details.sendResponse(status, body);
          },
        };

        const { data, cancel } = provideRequestContext(
          requestEvent,
          () => serverFunction.handler(...args),
        );
        const onClose = () => cancel(CLIENT_DISCONNECTED);
        req.on("close", onClose);
        const result = await data;
        req.off("close", onClose);

        // Skip the JSON send when the server function issued a redirect or
        // short-circuited with `send`; the bound adapter already wrote the
        // response. Express may also have ended the response via headersSent.
        // istanbul ignore else
        if (
          !requestEvent.redirected &&
          !requestEvent.sent &&
          !res.headersSent
        ) {
          sendResponse(200, { data: result });
        }
      } catch (err) {
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        sendResponse(500, formatError(err, isProduction));
      }
    },
  });
};
