import { ResolvedConfig, ViteDevServer } from "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "fastify";
import "koa";
//#region src/types.d.ts
type ContentType = "application/json" | "text/plain";
type Credentials = "same-origin" | "include" | "omit";
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
//#endregion
//#region src/functionsMap.d.ts
declare const serverFunctionsMap: Map<string, ServerFnEntry>;
//#endregion
//#region src/scanForServerFiles.d.ts
type ScanConfig = Pick<ResolvedConfig, "root" | "base"> & {
  server?: Partial<ResolvedConfig["server"]>;
};
declare const scanForServerFiles: (initialCfg?: ScanConfig, devServer?: ViteDevServer) => Promise<void>;
//#endregion
//#region src/createFunction.d.ts
declare function createServerFunction<TArgs extends JsonArray = JsonArray, TResult extends JsonValue = JsonValue>(name: string, handler: ServerFunctionInit<TArgs, TResult>, fnOptions?: Partial<ServerFunctionOptions>): ClientFunction<TArgs, TResult>;
//#endregion
//#region src/getClientModules.d.ts
interface RpcPluginOptionsInternal {
  rpcPrefix: string;
  adapter?: string | undefined;
}
declare const getClientModules: (initialOptions: RpcPluginOptionsInternal) => string;
//#endregion
//#region src/options.d.ts
declare const defaultServerFnOptions: {
  contentType: "application/json";
  credentials: "same-origin";
};
declare const defaultRPCOptions: RpcPluginOptions;
declare const defaultMiddlewareOptions: {
  rpcPrefix: undefined;
  path: undefined;
};
//#endregion
export { createServerFunction, defaultMiddlewareOptions, defaultRPCOptions, defaultServerFnOptions, getClientModules, scanForServerFiles, serverFunctionsMap };
//# sourceMappingURL=server.d.mts.map