import { ResolvedConfig, ViteDevServer } from "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "fastify";
import "koa";
//#region src/types.d.ts
/**
 * Content types the RPC client modules send with each request.
 */
type ContentType = "application/json" | "text/plain";
/**
 * Fetch `credentials` policy used by the generated client modules.
 */
type Credentials = "same-origin" | "include" | "omit";
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
//#endregion
//#region src/functionsMap.d.ts
declare const serverFunctionsMap: Map<string, ServerFnEntry>;
//#endregion
//#region src/scanForServerFiles.d.ts
/**
 * Partial Vite config used when scanning server files outside a running dev server.
 */
type ScanConfig = Pick<ResolvedConfig, "root" | "base"> & {
  /** Vite server options override (e.g. `middlewareMode`) */
  server?: Partial<ResolvedConfig["server"]>;
};
/**
 * Scans `src/api/` for server function files (`server.ts`, `server.js`, `server.mjs`, `server.mts`)
 * and populates the global `serverFunctionsMap` with their exported functions.
 * Uses Vite's SSR module loading to resolve and execute each file.
 * @param initialCfg - Optional Vite config overrides (root, base, server)
 * @param devServer - Optional running Vite dev server instance; when provided, skips creating a new one
 */
declare const scanForServerFiles: (initialCfg?: ScanConfig, devServer?: ViteDevServer) => Promise<void>;
//#endregion
//#region src/createFunction.d.ts
/**
 * Creates a server-side RPC function.
 * Registers the function in the server functions map and returns a client-compatible
 * wrapper that exposes `data` (Promise) and `cancel` (function) for request lifecycle control.
 * @param name - Unique identifier used by the RPC router to dispatch requests
 * @param handler - The actual implementation receiving an AbortSignal followed by JSON-serializable arguments
 * @param fnOptions - Optional contentType and credentials settings
 * @returns A client stub with `data` promise and `cancel` method, auto-registered in the server map
 */
declare function createServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue>(name: string, handler: ServerFunctionInit<TArgs, TResult>, fnOptions?: Partial<ServerFunctionOptions>): ClientFunction<TArgs, TResult>;
//#endregion
//#region src/getClientModules.d.ts
/**
 * Internal plugin options accepted by `getClientModules`.
 */
interface RpcPluginOptionsInternal {
  /** RPC endpoint prefix (e.g. "__rpc") */
  rpcPrefix: string;
  /** Framework adapter name */
  adapter?: string | undefined;
}
/**
 * Generates the complete client-side module bundle by iterating all registered server functions
 * and producing fetch-based stubs for each. The result is transformed by Vite (or Oxc) during
 * the dev server or production build.
 * @param initialOptions - Plugin options containing rpcPrefix and optional adapter
 * @returns A string of JavaScript code with all client RPC modules and their import dependencies
 */
declare const getClientModules: (initialOptions: RpcPluginOptionsInternal) => string;
//#endregion
//#region src/options.d.ts
declare const defaultServerFnOptions: {
  contentType: "application/json";
  credentials: "same-origin";
  method: "POST";
};
declare const defaultRPCOptions: RpcPluginOptions;
declare const defaultMiddlewareOptions: {
  rpcPrefix: undefined;
  path: undefined;
  origin: undefined;
};
//#endregion
export { createServerFunction, defaultMiddlewareOptions, defaultRPCOptions, defaultServerFnOptions, getClientModules, scanForServerFiles, serverFunctionsMap };
//# sourceMappingURL=server.d.mts.map