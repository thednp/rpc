import { Connect, Plugin } from "vite";
import { MiddlewareOptions as MiddlewareOptions$1, RpcPluginOptions as RpcPluginOptions$1 } from "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { NextFunction, Request, Response as Response$1 } from "express";
import { MiddlewareHandler } from "hono";
import "@hono/node-server";
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { Context, Next } from "koa";
//#region src/express/types.d.ts
type ExpressMiddlewareOptions = MiddlewareOptions$1<"express">;
type ExpressMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "express">(initialOptions?: Partial<ExpressMiddlewareOptions>) => ExpressMiddlewareHooks["handler"];
interface ExpressMiddlewareHooks {
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response$1, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
//#endregion
//#region src/hono/types.d.ts
interface HonoMiddlewareHooks {
  handler: MiddlewareHandler;
}
type HonoMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "hono">(initialOptions?: Partial<MiddlewareOptions$1<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/fastify/types.d.ts
type FastifyMiddlewareOptions = MiddlewareOptions$1<"fastify">;
type FastifyMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
interface FastifyMiddlewareHooks {
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
//#endregion
//#region src/koa/types.d.ts
type KoaMiddlewareOptions = MiddlewareOptions$1<"koa">;
interface KoaMiddlewareHooks {
  handler: (ctx: Context, next: Next) => Promise<void>;
}
type KoaMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "koa">(initialOptions?: Partial<KoaMiddlewareOptions>) => KoaMiddlewareHooks["handler"];
//#endregion
//#region src/types.d.ts
interface FrameworkHooks {
  express: ExpressMiddlewareHooks;
  hono: HonoMiddlewareHooks;
  fastify: FastifyMiddlewareHooks;
  koa: KoaMiddlewareHooks;
}
interface FrameworkMiddlewareFn {
  express: ExpressMiddlewareFn;
  hono: HonoMiddlewareFn;
  fastify: FastifyMiddlewareFn;
  koa: KoaMiddlewareFn;
}
type SupportableContentType = "multipart/form-data" | "application/json" | "text/plain" | "application/octet-stream";
type ContentType = "application/json" | "text/plain";
type Credentials = "same-origin" | "include" | "omit";
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
};
interface ServerFunctionOptions {
  /* @default "application/json" */
  contentType: ContentType;
  /* @default "same-origin" */
  credentials?: Credentials;
}
// primitives and their compositions
type JsonPrimitive = string | number | boolean | null | undefined;
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
// Keep these as a refference
// Date strings are common in APIs
// export type ISODateString = string; // for dates in ISO format
// Special types that might be useful
// export type Base64String = string; // for binary data encoded as base64
// export type URLString = string; // for URLs
// export type EmailString = string; // for email addresses
// export type RPCValue =
//   | JsonValue
//   | Date // will be serialized as ISOString
//   | Uint8Array // will be serialized as base64
//   | File // for file uploads
//   | Blob // for binary data
//   | URLSearchParams; // for query parameters
// export type ServerFnArgs = [JsonObject | JsonPrimitive, ...JsonArray];
type ServerFnArgs = [...JsonArray];
type ServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
type ServerFunctionInit<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
type ClientFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (...args: TArgs) => {
  data: Promise<TResult>;
  cancel: (reason: string) => void;
};
type ClientFunctionWithOptions = ClientFunction & {
  name: string;
  options?: ServerFunctionOptions;
};
interface ServerFnEntry {
  name: string;
  handler: ClientFunctionWithOptions;
  options?: ServerFunctionOptions;
  exportName?: string;
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
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix: "__rpc" | string;
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
   * rpcPrefix: "api/rpc"
   */
  rpcPrefix?: string | false;
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
//#region src/index.d.ts
/**
 * Utility to define `@thednp/rpc` configuration file similar to vite.
 * @param uniConfig a system wide RPC configuration
 */
declare const defineConfig: (uniConfig: Partial<RpcPluginOptions>) => RpcPluginOptions;
/**
 * Utility to load `@thednp/rpc` configuration file system wide.
 * @param configFile an optional parameter to specify a file within your project scope
 */
declare function loadRPCConfig(configFile?: string): Promise<RpcPluginOptions>;
declare function rpcPlugin(devOptions?: Partial<RpcPluginOptions>): Plugin<unknown>;
//#endregion
export { type BodyResult, type ClientFunction, type ClientFunctionWithOptions, type ContentType, type Credentials, type FrameworkHooks, type FrameworkMiddlewareFn, type JsonArray, type JsonObject, type JsonPrimitive, type JsonValue, type MiddlewareOptions, type RpcPluginOptions, type ServerFnArgs, type ServerFnEntry, type ServerFunction, type ServerFunctionInit, type ServerFunctionOptions, type SupportableContentType, rpcPlugin as default, defineConfig, loadRPCConfig };
//# sourceMappingURL=index.d.mts.map