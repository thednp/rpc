// src/koa/createMiddleware.ts
import type { Context, Next } from "koa";
// import type { JsonArray, JsonValue } from "@thednp/rpc";
import type { KoaMiddlewareFn, KoaMiddlewareOptions } from "./types.d.ts";
import { escapeRegExp } from "../tools.ts";

import { scanForServerFiles, serverFunctionsMap } from "@thednp/rpc/server";
import { defaultMiddlewareOptions, defaultRPCOptions } from "../options.ts";
import { readBody } from "./helpers.ts";

let middlewareCount = 0;
const middlewareStack = new Set<string>();

export const createMiddleware: KoaMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    initialOptions,
  ) as KoaMiddlewareOptions;

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

export const createRPCMiddleware: KoaMiddlewareFn = (initialOptions = {}) => {
  const options = Object.assign(
    {},
    defaultMiddlewareOptions,
    { rpcPreffix: defaultRPCOptions.rpcPreffix },
    initialOptions,
  ) as KoaMiddlewareOptions;

  // Hoist prefix regex (escaped) and the literal prefix-for-replace out of the
  // per-request handler to avoid regex injection and per-request compilation.
  const rpcPreffix = options.rpcPreffix;
  const prefixRegex = rpcPreffix
    ? new RegExp(`^/${escapeRegExp(rpcPreffix)}/`)
    : /* istanbul ignore next */ null;
  const prefixReplace = `/${rpcPreffix}/`;

  return createMiddleware({
    ...options,
    handler: async (ctx: Context, _next: Next) => {
      const url = new URL(ctx.url, "http://localhost").pathname;
      // const { rpcPreffix } = options;

      // Defense-in-depth: validate prefix match via escaped regex even though
      // the outer createMiddleware gates on the same prefix already.
      // istanbul ignore next
      if (prefixRegex && !prefixRegex.test(url)) {
        return;
      }

      const functionName = url.replace(prefixReplace, "");
      const serverFunction = serverFunctionsMap.get(functionName);

      if (!serverFunction) {
        ctx.status = 404;
        ctx.body = { error: "Function not found" };
        return;
      }

      try {
        const body = await readBody(ctx);
        const args = Array.isArray(body.data) ? body.data : [body.data];
        const { data: resultData, cancel } = serverFunction.handler(...args);
        const onClose = () => cancel("client disconnected");
        ctx.req.on("close", onClose);
        const result = await resultData;
        ctx.req.off("close", onClose);
        ctx.status = 200;
        ctx.body = { data: result };
      } catch (err) {
        console.error(String(err));
        ctx.status = 500;
        ctx.body = { error: "Internal Server Error" };
      }
    },
  });
};
