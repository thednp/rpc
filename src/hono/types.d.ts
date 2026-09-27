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
import type { RequestDetails, ResponseDetails } from "../adapter-types.ts";

/**
 * Normalized request/response shapes, shared with every adapter so a wrapper
 * can write one helper across all five frameworks.
 */
export type { RequestDetails, ResponseDetails };

export type { Hono } from "hono";
/** Canonical app-type name, matching the `<Fw>App` convention across adapters. */
export type { Hono as HonoApp } from "hono";
export type { Context as HonoContext } from "hono";
export type { MiddlewareHandler as HonoMiddlewareHandler } from "hono";
/** The Hono request object (`c.req`) — not covered by `HonoContext`. */
export type { HonoRequest } from "hono";
/** The Fetch `Response` a Hono handler returns. */
export type { Response as HonoResponse } from "hono";
/** Hono's `next` continuation passed to middleware. */
export type { Next as HonoNext } from "hono";
