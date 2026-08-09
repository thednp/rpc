// src/h3/types.d.ts
import type { H3, H3Event, Middleware } from "h3";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

/**
 * h3-specific middleware options, constrained to the `"h3"` adapter.
 */
export type H3MiddlewareOptions = MiddlewareOptions<"h3">;

/**
 * h3 middleware handler signature used by the RPC middleware.
 */
export interface H3MiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param event - h3 event object
   * @param next - h3 next function
   */
  handler: Middleware;
}

/**
 * h3 middleware factory: takes optional initial options and returns
 * the h3-compatible handler.
 */
export type H3MiddlewareFn = <A extends RpcPluginOptions["adapter"] = "h3">(
  initialOptions?: Partial<H3MiddlewareOptions>,
) => H3MiddlewareHooks["handler"];

/**
 * h3 application reference used by helpers that attach middleware to an app.
 */
export type H3App = H3;

/**
 * h3 event extended with an optional pre-parsed body.
 */
export type H3EventWithBody = H3Event & { body?: unknown };
