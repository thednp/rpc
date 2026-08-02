import { Connect, Plugin } from "vite";
import { MiddlewareOptions as MiddlewareOptions$1, RpcPluginOptions as RpcPluginOptions$1 } from "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { NextFunction, Request, Response } from "express";
import { MiddlewareHandler } from "hono";
import "@hono/node-server";
import "hono/factory";
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { Context, Next } from "koa";
//#region src/express/types.d.ts
/**
 * Express-specific middleware options, constrained to the `"express"` adapter.
 */
type ExpressMiddlewareOptions = MiddlewareOptions$1<"express">;
/**
 * Express middleware factory: takes optional initial options and returns
 * the Express/Connect-compatible handler.
 */
type ExpressMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "express">(initialOptions?: Partial<ExpressMiddlewareOptions>) => ExpressMiddlewareHooks["handler"];
/**
 * Express/Connect middleware handler signature used by the RPC middleware.
 */
interface ExpressMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Node or Express request object
   * @param res - Node or Express response object
   * @param next - Connect or Express next function
   */
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
//#endregion
//#region src/hono/types.d.ts
/**
 * Hono middleware handler signature used by the RPC middleware.
 */
interface HonoMiddlewareHooks {
  /** Hono middleware handler */
  handler: MiddlewareHandler;
}
/**
 * Hono middleware factory: takes optional initial options and returns
 * the Hono-compatible handler.
 */
type HonoMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "hono">(initialOptions?: Partial<MiddlewareOptions$1<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/fastify/types.d.ts
/**
 * Fastify-specific middleware options, constrained to the `"fastify"` adapter.
 */
type FastifyMiddlewareOptions = MiddlewareOptions$1<"fastify">;
/**
 * Fastify middleware factory: takes optional initial options and returns
 * the Fastify-compatible handler.
 */
type FastifyMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
/**
 * Fastify middleware handler signature used by the RPC middleware.
 */
interface FastifyMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Fastify request object
   * @param res - Fastify reply object
   * @param done - Fastify hook completion callback
   */
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
//#endregion
//#region src/koa/types.d.ts
/**
 * Koa-specific middleware options, constrained to the `"koa"` adapter.
 */
type KoaMiddlewareOptions = MiddlewareOptions$1<"koa">;
/**
 * Koa middleware handler signature used by the RPC middleware.
 */
interface KoaMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param ctx - Koa context object
   * @param next - Koa next function
   */
  handler: (ctx: Context, next: Next) => Promise<void>;
}
/**
 * Koa middleware factory: takes optional initial options and returns
 * the Koa-compatible handler.
 */
type KoaMiddlewareFn = <A extends RpcPluginOptions$1["adapter"] = "koa">(initialOptions?: Partial<KoaMiddlewareOptions>) => KoaMiddlewareHooks["handler"];
//#endregion
//#region src/types.d.ts
/**
 * Maps each supported framework adapter to its middleware hooks (handler signatures).
 * Used to keep the middleware options type-safe per adapter.
 */
interface FrameworkHooks {
  /** Express/Connect middleware handler signature */
  express: ExpressMiddlewareHooks;
  /** Hono middleware handler signature */
  hono: HonoMiddlewareHooks;
  /** Fastify middleware handler signature */
  fastify: FastifyMiddlewareHooks;
  /** Koa middleware handler signature */
  koa: KoaMiddlewareHooks;
}
/**
 * Maps each supported framework adapter to its middleware factory function type.
 */
interface FrameworkMiddlewareFn {
  /** Express/Connect middleware factory */
  express: ExpressMiddlewareFn;
  /** Hono middleware factory */
  hono: HonoMiddlewareFn;
  /** Fastify middleware factory */
  fastify: FastifyMiddlewareFn;
  /** Koa middleware factory */
  koa: KoaMiddlewareFn;
}
/**
 * Content types the RPC middleware accepts when reading request bodies.
 * Only `application/json` and `text/plain` are currently supported.
 */
type SupportableContentType = "multipart/form-data" | "application/json" | "text/plain" | "application/octet-stream";
/**
 * Content types the RPC client modules send with each request.
 */
type ContentType = "application/json" | "text/plain";
/**
 * Fetch `credentials` policy used by the generated client modules.
 */
type Credentials = "same-origin" | "include" | "omit";
/**
 * Parsed request body result discriminated by content type.
 */
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
};
/**
 * Options for a single server function, controlling how the generated
 * client module serializes the request body and sends credentials.
 */
interface ServerFunctionOptions {
  /**
   * Content type used for the request body.
   * @default "application/json"
   */
  contentType: ContentType;
  /**
   * Fetch credentials policy.
   * @default "same-origin"
   */
  credentials?: Credentials;
  /**
   * HTTP method used for the RPC request.
   * GET requests send arguments as an `?args=` JSON query parameter
   * (a fetch request body is not allowed on GET).
   * @default "POST"
   */
  method?: "GET" | "POST";
}
// primitives and their compositions
/**
 * Primitive JSON values, including `undefined` for optional parameters.
 */
type JsonPrimitive = string | number | boolean | null | undefined;
/**
 * A JSON object whose values are JSON values or arrays.
 */
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
/**
 * A JSON array of JSON values.
 */
type JsonArray = JsonValue[];
/**
 * Any JSON-serializable value: primitive, array, or object.
 */
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
/**
 * Arguments passed to a server function, spread as a JSON array.
 */
type ServerFnArgs = [...JsonArray];
/**
 * Server-side handler signature: receives the `AbortSignal` first,
 * followed by any serializable arguments.
 */
type ServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
/**
 * Server function initialization signature, identical to `ServerFunction`.
 * Used when registering a function with `createServerFunction`.
 */
type ServerFunctionInit<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (signal: AbortSignal, ...args: TArgs) => Promise<TResult>;
/**
 * Client-side stub signature generated for each server function.
 * Returns a promise-backed `data` handle plus a `cancel` function
 * that aborts the underlying fetch request.
 */
type ClientFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue> = (...args: TArgs) => {
  /** Promise resolving to the server response data */
  data: Promise<TResult>;
  /** Aborts the in-flight request with the given reason */
  cancel: (reason: string) => void;
};
/**
 * A client function augmented with its registered export name and
 * per-function options (content type, credentials).
 */
type ClientFunctionWithOptions = ClientFunction & {
  /** Registered export name of the server function */
  name: string;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
};
/**
 * Entry in the server functions map: registered name, client handler,
 * optional per-function options, and the original export name.
 */
interface ServerFnEntry {
  /** Registered RPC function name (used in the URL path) */
  name: string;
  /** Client-side handler stub for this function */
  handler: ClientFunctionWithOptions;
  /** Per-function content type and credentials options */
  options?: ServerFunctionOptions;
  /** Original export name from the server module */
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
   * Allowed request origin (e.g. "https://example.com").
   * When set, any request carrying an `Origin` header that does not match
   * is rejected with a 403 Forbidden response. Requests without an `Origin`
   * header (curl, native clients) pass through unchecked.
   * When unset (default), no origin validation is performed.
   */
  origin?: string;
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
 * Type-safe helper to create an RPC configuration object.
 * Merges the provided partial config with built-in defaults.
 * @param uniConfig - System-wide RPC configuration overrides
 * @returns Complete RPC plugin options with defaults applied
 */
declare const defineConfig: (c: Partial<RpcPluginOptions>) => RpcPluginOptions;
/**
 * Loads the RPC configuration by searching for config files in the project root.
 * Searches in order: `rpc.config.ts`, `rpc.config.js`, `rpc.config.mjs`, `rpc.config.mts`,
 * `.rpcrc.ts`, `.rpcrc.js`. Falls back to defaults if none found.
 * @param configFile - Optional explicit config file path; skips file search when provided
 * @returns Resolved RPC plugin options
 */
declare const loadRPCConfig: (f?: string) => Promise<RpcPluginOptions>;
/**
 * Vite plugin that enables automatic RPC generation.
 * Transforms server function imports into fetch-based client stubs during development and production builds.
 * In dev mode, attaches the RPC middleware to Vite's Connect server.
 * @param devOptions - Development-only overrides (merged on top of config file values)
 * @returns A Vite plugin object
 */
declare function rpcPlugin(devOptions?: Partial<RpcPluginOptions>): Plugin<unknown>;
//#endregion
export { type BodyResult, type ClientFunction, type ClientFunctionWithOptions, type ContentType, type Credentials, type FrameworkHooks, type FrameworkMiddlewareFn, type JsonArray, type JsonObject, type JsonPrimitive, type JsonValue, type MiddlewareOptions, type RpcPluginOptions, type ServerFnArgs, type ServerFnEntry, type ServerFunction, type ServerFunctionInit, type ServerFunctionOptions, type SupportableContentType, rpcPlugin as default, defineConfig, loadRPCConfig };
//# sourceMappingURL=index.d.mts.map