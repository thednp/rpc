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

export const defaultPrefix = "__rpc";

export const defaultRPCOptions: RpcPluginOptions = {
  rpcPrefix: defaultPrefix,
  adapter: "express",
  serverFiles: "exact",
  scanRoot: undefined,
};

export const defaultMiddlewareOptions = {
  rpcPrefix: undefined,
  path: undefined,
  origin: undefined,
} satisfies MiddlewareOptions;

const globalPrefixSymbol = Symbol.for("thednp.rpc.globalPrefix");

/** Global rpcPrefix from the last loaded config / middleware — fallback for functions without explicit prefix. */
export const getGlobalPrefix = (): string | undefined =>
  (globalThis as unknown as Record<symbol, string | undefined>)[
    globalPrefixSymbol
  ];

export const setGlobalPrefix = (prefix: string | undefined): void => {
  if (prefix) {
    (globalThis as unknown as Record<symbol, string | undefined>)[
      globalPrefixSymbol
    ] = prefix;
  } else {
    delete (globalThis as unknown as Record<symbol, string | undefined>)[
      globalPrefixSymbol
    ];
  }
};
