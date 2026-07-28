import type {
  MiddlewareOptions,
  RpcPluginOptions,
  ServerFunctionOptions,
} from "./types.d.ts";

export const defaultServerFnOptions = {
  contentType: "application/json",
} satisfies ServerFunctionOptions;

export const defaultRPCOptions: RpcPluginOptions = {
  rpcPreffix: "__rpc",
  adapter: "express",
};

export const defaultMiddlewareOptions = {
  rpcPreffix: undefined,
  path: undefined,
} satisfies MiddlewareOptions;
