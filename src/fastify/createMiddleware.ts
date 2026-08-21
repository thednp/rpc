// src/fastify/createMiddleware.ts
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type {
  FastifyMiddlewareFn,
  FastifyMiddlewareOptions,
} from "./types.d.ts";
import type { JsonValue } from "@thednp/rpc";
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
import { readBody, redirect as fastifyRedirect } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

/**
 * Creates a Fastify preHandler hook with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated. Prefix and path regexes are compiled once at creation time.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns A Fastify preHandler hook function
 */
export const createMiddleware: FastifyMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as FastifyMiddlewareOptions;

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
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => {
    const reqUrl = safeURL(req.url);
    const url = reqUrl.pathname;

    // No need to continue when no handler provided
    if (!handler) {
      done();
      return;
    }

    // Path matching
    if (pathMatcher && !pathMatcher.test(url)) {
      done();
      return;
    }

    // rpcPrefix matching (boundary-safe via escaped regex)
    if (prefixRegex && !prefixRegex.test(url)) {
      done();
      return;
    }

    rpcPrefix = (rpcPrefix ?? defaultPrefix) as string;
    ensurePrefixFromGlobal(rpcPrefix);

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
    await handler(req, reply, done);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

/**
 * Creates the Fastify RPC middleware that routes incoming requests to registered server functions.
 * Wraps the generic createMiddleware with the RPC handler that reads the body, dispatches
 * to the matching function, and sends the JSON-serialized result.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns A Fastify preHandler hook function
 */
export const createRPCMiddleware: FastifyMiddlewareFn = (
  initialOptions = {},
) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    { rpcPrefix: defaultRPCOptions.rpcPrefix },
    initialOptions,
  ) as FastifyMiddlewareOptions;

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
    handler: async (
      req: FastifyRequest,
      reply: FastifyReply,
      _done: HookHandlerDoneFunction,
    ) => {
      const reqUrl = safeURL(req.url);
      const url = reqUrl.pathname;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore if
      if (prefixRegex && !prefixRegex.test(url)) {
        return;
      }

      // Optional origin check: reject requests whose Origin header does not
      // match the configured origin. Requests without an Origin header
      // (curl, native clients) pass through unchecked.
      const origin = options.origin;
      const requestOrigin = req.headers.origin;
      if (origin && requestOrigin && requestOrigin !== origin) {
        reply.status(403).send({ error: REQUEST_FORBIDDEN });
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      ensurePrefixFromGlobal(prefix);
      const serverFunction = getFunctionsForPrefix(prefix).get(functionName);

      if (!serverFunction) {
        reply.status(404).send({
          error: FUNCTION_NOT_FOUND,
        });
        return;
      }

      try {
        const method = serverFunction.options?.method || "POST";
        if (req.method.toUpperCase() !== method) {
          reply.status(405).send({ error: METHOD_NOT_ALLOWED });
          return;
        }

        let args: JsonValue[] = [];
        if (method === "GET") {
          const raw = reqUrl.searchParams.get("args");
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              reply.status(400).send({ error: BAD_REQUEST });
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
            reply.status(415).send({ error: UNSUPPORTED_MEDIA_TYPE });
            return;
          }
          const body = await readBody(req);
          args = Array.isArray(body.data)
            ? body.data as JsonValue[]
            : [body.data as JsonValue];
        }
        const requestEvent: RequestEvent = {
          request: req,
          response: reply,
          nativeEvent: req,
          locals: {},
          functionName,
          redirect: (location, status = 303) => {
            requestEvent.redirected = { location, status };
            fastifyRedirect(reply, location, status);
          },
          send: (status, body, headers) => {
            requestEvent.sent = { status, body, headers };
            if (headers) {
              for (const [name, value] of Object.entries(headers)) {
                reply.header(name, value);
              }
            }
            reply.status(status).send(body);
          },
        };
        const { data: dataResult, cancel } = provideRequestContext(
          requestEvent,
          () => serverFunction.handler(...args),
        );
        const onClose = () => cancel(CLIENT_DISCONNECTED);

        req.raw.on("close", onClose);
        const data = await dataResult;
        req.raw.off("close", onClose);

        // istanbul ignore else
        if (
          !requestEvent.redirected &&
          !requestEvent.sent &&
          !reply.raw.headersSent
        ) {
          reply.status(200).send({ data });
        }
      } catch (err) {
        console.error(String(err));
        const isProduction = process.env.NODE_ENV === "production";
        reply.status(500).send(formatError(err, isProduction));
      }
    },
  });
};
