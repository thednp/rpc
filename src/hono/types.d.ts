import type { MiddlewareHandler } from "hono";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

/**
 * Hono-specific middleware options, constrained to the `"hono"` adapter.
 */
export type HonoMiddlewareOptions = MiddlewareOptions<"hono">;

/**
 * Hono middleware handler signature used by the RPC middleware.
 */
export interface HonoMiddlewareHooks {
  /** Hono middleware handler */
  handler: MiddlewareHandler;
}

/**
 * Hono middleware factory: takes optional initial options and returns
 * the Hono-compatible handler.
 */
export type HonoMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "hono">(
  initialOptions?: Partial<MiddlewareOptions<A>>,
) => HonoMiddlewareHooks["handler"];
