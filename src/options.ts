import { DEFAULT_BODY_LIMIT } from "./constants.ts";
import type {
  MiddlewareOptions,
  RpcPluginOptions,
  ServerFunctionOptions,
} from "./types.d.ts";

/**
 * Defaults applied to a server function that declares no `method`,
 * `credentials`, or `contentType` of its own.
 */
export const defaultServerFnOptions: ServerFunctionOptions = {
  contentType: "application/json",
  credentials: "same-origin",
  method: "POST",
};

/**
 * The built-in RPC endpoint prefix, used when neither an explicit prefix nor a
 * global one (`getGlobalPrefix`) is supplied. Kept for backward compatibility
 * with pre-multi-prefix setups, where every function lived under this one map.
 */
export const defaultPrefix = "__rpc";

/**
 * Baseline plugin options. `defineConfig` merges a user's partial config over
 * these, and `loadRPCConfig` merges a loaded config file over them, so every
 * option has a defined value even when a config file omits it.
 */
export const defaultRPCOptions: RpcPluginOptions = {
  rpcPrefix: defaultPrefix,
  serverFiles: "exact",
  scanRoot: undefined,
};

/**
 * Baseline middleware options. Note `rpcPrefix` is `undefined` rather than
 * `defaultPrefix` on purpose: leaving it unset lets `resolveRPCPrefix` fall
 * through to the global prefix, which is what makes a published global prefix
 * reach the middleware.
 *
 * `origin` is the opposite case, and deliberately so: it defaults to the secure
 * `"self"` policy rather than to "no check", so an RPC endpoint created with no
 * options at all is cross-origin protected. `allowHeaderless` defaults to
 * `false` for the same reason — headerless clients are opt-in.
 *
 * Neither default is a bypass. `Object.assign(defaults, options)` copies an
 * explicit `origin: undefined` over the default, so `isOriginRequestAllowed`
 * also resolves an absent policy to `"self"` itself. Two independent guards,
 * because a security default that one merge call can erase is not a default.
 */
export const defaultMiddlewareOptions: MiddlewareOptions = {
  rpcPrefix: undefined,
  path: undefined,
  origin: "self",
  allowHeaderless: false,
  bodyLimit: DEFAULT_BODY_LIMIT,
};
