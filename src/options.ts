import type {
  MiddlewareOptions,
  RpcPluginOptions,
  ServerFunctionOptions,
} from "./types.d.ts";

export const defaultServerFnOptions = {
  contentType: "application/json",
  credentials: "same-origin",
  method: "POST",
} satisfies ServerFunctionOptions;

export const defaultRPCOptions: RpcPluginOptions = {
  rpcPrefix: "__rpc",
  adapter: "express",
  serverFiles: "exact",
  scanRoot: undefined,
};

export const defaultMiddlewareOptions = {
  rpcPrefix: undefined,
  path: undefined,
  origin: undefined,
} satisfies MiddlewareOptions;
