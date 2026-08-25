import type { MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

/**
 * Node incoming message with an optional pre-parsed body.
 */
export type IncomingWithBody = IncomingMessage & { body?: unknown };

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

/**
 * Framework types re-exported from `hono` so consumers can annotate apps
 * and handlers without a direct dependency on hono types.
 */
export type { Hono } from "hono";
export type { Context as HonoContext } from "hono";
export type { MiddlewareHandler as HonoMiddlewareHandler } from "hono";
