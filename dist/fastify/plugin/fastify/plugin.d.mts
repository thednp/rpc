import { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { Connect } from "vite";
import "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { NextFunction, Request, Response as Response$1 } from "express";
import { MiddlewareHandler } from "hono";
import "@hono/node-server";
import { Context, Next } from "koa";
//#region src/express/types.d.ts
interface ExpressMiddlewareHooks {
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response$1, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
//#endregion
//#region src/hono/types.d.ts
interface HonoMiddlewareHooks {
  handler: MiddlewareHandler;
}
//#endregion
//#region src/fastify/types.d.ts
interface FastifyMiddlewareHooks {
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
//#endregion
//#region src/koa/types.d.ts
interface KoaMiddlewareHooks {
  handler: (ctx: Context, next: Next) => Promise<void>;
}
//#endregion
//#region src/types.d.ts
interface FrameworkHooks {
  express: ExpressMiddlewareHooks;
  hono: HonoMiddlewareHooks;
  fastify: FastifyMiddlewareHooks;
  koa: KoaMiddlewareHooks;
}
/**
 * ### @thednp/rpc
 * The plugin configuration allows for granular control of your
 * application RPC calls. The default settings are optimized for development
 * environments while providing a secure foundation for production use.
 */
interface RpcPluginOptions {
  // RPC Middleware Options
  /**
   * RPC prefix without leading slash (e.g. "__rpc")
   * Leading slash will be added automatically by the middleware.
   * This prefix defines the base path for all RPC endpoints.
   * @default "__rpc"
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPreffix: "api/rpc"
   */
  rpcPreffix: "__rpc" | string;
  /**
   * Option to set an adapter for the middleware connection. The default is _express_,
   * which is the most popular and battle tested server app. The _express_ adapter is
   * also compatible with the vite's Connect development server.
   * @default express
   */
  adapter: "express" | "hono" | "fastify" | "koa";
}
interface MiddlewareOptions<A extends RpcPluginOptions["adapter"] = "express"> {
  /**
   * Name for the middleware (used for identification in Express stack)
   */
  name?: string;
  /**
   * Path pattern to match for middleware execution.
   * Accepts string or RegExp to filter requests based on URL path.
   *
   * @example
   * // String path
   * path: "/api/v1"
   *
   * // RegExp pattern
   * path: /^\/api\/v[0-9]+/
   */
  path?: string | RegExp;
  /**
   * RPC prefix without leading slash (e.g. "__rpc")
   * Leading slash will be added automatically by the middleware.
   * This prefix defines the base path for all RPC endpoints.
   * @default string
   * @example
   * // Results in endpoints like: /api/rpc/myFunction
   * rpcPreffix: "api/rpc"
   */
  rpcPreffix?: string | false;
  /**
   * Async handler for request processing.
   * Core middleware function that processes incoming requests.
   *
   * @param req - The incoming request object
   * @param res - The server response object
   * @param next - Function to pass control to the next middleware
   *
   * @example
   * handler: async (req, res, next) => {
   *   // Process request
   *   const data = await processRequest(req);
   *
   *   // Send response
   *   sendResponse(res, { data }, 200);
   * }
   */
  handler?: FrameworkHooks[A]["handler"];
}
//#endregion
//#region src/fastify/plugin.d.ts
declare const RpcPlugin: (fastify: FastifyInstance, initialOptions: Partial<MiddlewareOptions<"fastify">>, done: () => void) => void;
declare const rpcPlugin: typeof RpcPlugin;
//#endregion
export { type MiddlewareOptions, rpcPlugin as default };
//# sourceMappingURL=plugin.d.mts.map