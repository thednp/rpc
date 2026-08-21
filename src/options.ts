import type {
  MiddlewareOptions,
  RpcPluginOptions,
  ServerFunctionOptions,
} from "./types.d.ts";

export const defaultServerFnOptions: ServerFunctionOptions = {
  contentType: "application/json",
  credentials: "same-origin",
  method: "POST",
};

export const defaultPrefix = "__rpc";

export const defaultRPCOptions: RpcPluginOptions = {
  rpcPrefix: defaultPrefix,
  adapter: "express",
  serverFiles: "exact",
  scanRoot: undefined,
};

export const defaultMiddlewareOptions: MiddlewareOptions = {
  rpcPrefix: undefined,
  path: undefined,
  origin: undefined,
};
