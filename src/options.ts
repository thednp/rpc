import type {
  MiddlewareOptions,
  RpcPluginOptions,
  ServerFunctionOptions,
} from "./types.d.ts";

export const defaultServerFnOptions = {
  contentType: "application/json",
  credentials: "same-origin",
} satisfies ServerFunctionOptions;

export const defaultRPCOptions: RpcPluginOptions = {
  rpcPrefix: "__rpc",
  adapter: "express",
};

export const defaultMiddlewareOptions = {
  rpcPrefix: undefined,
  path: undefined,
} satisfies MiddlewareOptions;
