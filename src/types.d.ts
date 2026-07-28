// @thednp/rpc/src/types.d.ts
import type {
  ExpressMiddlewareFn,
  ExpressMiddlewareHooks,
} from "./express/index.ts";

import type { HonoMiddlewareFn, HonoMiddlewareHooks } from "./hono/index.ts";

import type {
  FastifyMiddlewareFn,
  FastifyMiddlewareHooks,
} from "./fastify/index.ts";

import type { KoaMiddlewareFn, KoaMiddlewareHooks } from "./koa/index.ts";

export interface FrameworkHooks {
  express: ExpressMiddlewareHooks;
  hono: HonoMiddlewareHooks;
  fastify: FastifyMiddlewareHooks;
  koa: KoaMiddlewareHooks;
}

export interface FrameworkMiddlewareFn {
  express: ExpressMiddlewareFn;
  hono: HonoMiddlewareFn;
  fastify: FastifyMiddlewareFn;
  koa: KoaMiddlewareFn;
}

export type SupportableContentType =
  | "multipart/form-data"
  | "application/json"
  | "text/plain"
  | "application/octet-stream";

export type ContentType = "application/json" | "text/plain";

export type BodyResult =
  | { contentType: "application/json"; data: JsonValue }
  | { contentType: "text/plain"; data: string };

export interface ServerFunctionOptions {
  contentType: ContentType;
}

// primitives and their compositions
export type JsonPrimitive = string | number | boolean | null | undefined;
export type JsonObject = { [key: string]: JsonValue | JsonArray };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

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
export type ServerFnArgs = [...JsonArray];

export type ServerFunction<
  TArgs extends JsonArray = JsonArray,
  TResult extends JsonValue = JsonValue,
> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;

export type ServerFunctionInit<
  TArgs extends JsonArray = JsonArray,
  TResult extends JsonValue = JsonValue,
> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;

export type ClientFunction<
  TArgs extends JsonArray = JsonArray,
  TResult extends JsonValue = JsonValue,
> = (...args: TArgs) => {
  data: Promise<TResult>;
  cancel: (reason: string) => void;
};

export type ClientFunctionWithOptions = ClientFunction & {
  name: string;
  options?: ServerFunctionOptions;
};

export interface ServerFnEntry {
  name: string;
  handler: ClientFunctionWithOptions;
  options?: ServerFunctionOptions;
  exportName?: string;
}

export interface CacheEntry<T> {
  data?: T;
  timestamp: number;
  promise?: Promise<T>;
}

/**
 * ### @thednp/rpc
 * The plugin configuration allows for granular control of your
 * application RPC calls. The default settings are optimized for development
 * environments while providing a secure foundation for production use.
 */
export interface RpcPluginOptions {
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

export interface MiddlewareOptions<
  A extends RpcPluginOptions["adapter"] = "express",
> {
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
