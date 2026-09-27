// src/h3/types.d.ts
import type { H3, H3Event, Middleware } from "h3";
import type { AdapterName, MiddlewareOptions } from "@thednp/rpc";

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
export type H3MiddlewareFn = <A extends AdapterName = "h3">(
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

/**
 * Framework types re-exported from `h3` so consumers can annotate apps and
 * events without a direct dependency on h3 types.
 */
import type { RequestDetails, ResponseDetails } from "../adapter-types.ts";

/**
 * Normalized request/response shapes, shared with every adapter so a wrapper
 * can write one helper across all five frameworks.
 */
export type { RequestDetails, ResponseDetails };

export type { H3 } from "h3";
export type { H3Event } from "h3";
/** Canonical request-type name — h3's request is reached through the event. */
export type { H3Event as H3Request } from "h3";
/** h3's response wrapper (`event.res`). */
export type { H3Response } from "h3";
/** h3's middleware type and its `next` continuation. */
export type { Middleware as H3Middleware } from "h3";
export type { EventHandler as H3Next } from "h3";
