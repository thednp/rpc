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
// import type { JsonArray, JsonValue } from "@thednp/rpc";
import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { defaultMiddlewareOptions, defaultRPCOptions } from "../options.ts";
import { escapeRegExp } from "../tools.ts";
import { readBody } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

// Define the middleware function for Fastify
export const createMiddleware: FastifyMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as FastifyMiddlewareOptions;

  const middlewareName = options.name;
  const rpcPreffix = options.rpcPreffix;
  const path = options.path;
  const handler = options.handler;

  let name = middlewareName;
  if (!name) {
    name = "viteRPCMiddleware-" + middlewareCount;
    middlewareCount += 1;
  }
  if (middlewareStack.has(name)) {
    throw new Error(`The middleware name "${name}" is already used.`);
  }
  middlewareStack.add(name);

  // Hoist regex compilation out of per-request path. Escape the prefix to
  // prevent regex injection via metacharacters in the config string.
  const prefixRegex: RegExp | null = rpcPreffix
    ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`)
    : null;
  const pathMatcher: RegExp | null = path
    ? (typeof path === "string" ? new RegExp(path) : path)
    : null;

  const middlewareHandler = async (
    req: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => {
    const reqUrl = new URL(req.url, "http://localhost");
    const url = reqUrl.pathname;

    // When serving from production server, scan for server files
    if (serverFunctionsMap.size === 0) {
      await scanForServerFiles();
    }

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

    // rpcPreffix matching (boundary-safe via escaped regex)
    if (prefixRegex && !prefixRegex.test(url)) {
      done();
      return;
    }

    // Execute handler
    await handler(req, _reply, done);
  };

  Object.defineProperty(middlewareHandler, "name", {
    value: name,
  });

  return middlewareHandler;
};

export const createRPCMiddleware: FastifyMiddlewareFn = (
  initialOptions = {},
) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    { rpcPreffix: defaultRPCOptions.rpcPreffix },
    initialOptions,
  ) as FastifyMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPreffix = options.rpcPreffix;
  const prefixRegex = rpcPreffix
    ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${rpcPreffix}/`;

  return createMiddleware({
    ...options,
    handler: async (
      req: FastifyRequest,
      reply: FastifyReply,
      _done: HookHandlerDoneFunction,
    ) => {
      const reqUrl = new URL(req.url, "http://localhost");
      const url = reqUrl.pathname;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore if
      if (prefixRegex && !prefixRegex.test(url)) {
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = serverFunctionsMap.get(functionName);

      if (!serverFunction) {
        reply.status(404).send({
          error: "Function not found",
        });
        return;
      }

      try {
        const body = await readBody(req);
        const args = Array.isArray(body.data) ? body.data : [body.data];
        const { data: dataResult, cancel } = serverFunction.handler(...args);
        const onClose = () => cancel("client disconnected");

        req.raw.on("close", onClose);
        const data = await dataResult;
        req.raw.off("close", onClose);

        // istanbul ignore else
        if (!reply.raw.headersSent) reply.status(200).send({ data });
      } catch (err) {
        console.error(String(err));
        reply.status(500).send({ error: "Internal Server Error" });
      }
    },
  });
};
