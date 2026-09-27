// src/koa/types.d.ts
import type Koa from "koa";
import type { Context, Next } from "koa";
import type { AdapterName, JsonValue, MiddlewareOptions } from "@thednp/rpc";

/**
 * Koa-specific middleware options, constrained to the `"koa"` adapter.
 */
export type KoaMiddlewareOptions = MiddlewareOptions<"koa">;

/**
 * Koa context extended with an optional parsed request body.
 */
export interface KoaContext extends Context {
  /** Koa request with an optional parsed JSON/plain-text body */
  request: Context["request"] & { body?: string | JsonValue };
}

/**
 * Koa middleware handler signature used by the RPC middleware.
 */
export interface KoaMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param ctx - Koa context object
   * @param next - Koa next function
   */
  handler: (ctx: Context, next: Next) => Promise<void>;
}

/**
 * Koa middleware factory: takes optional initial options and returns
 * the Koa-compatible handler.
 */
export type KoaMiddlewareFn = <A extends AdapterName = "koa">(
  initialOptions?: Partial<KoaMiddlewareOptions>,
) => KoaMiddlewareHooks["handler"];

/**
 * Framework types re-exported from `koa` so consumers can annotate apps,
 * contexts, and middleware without a direct dependency on koa types.
 */
import type { RequestDetails, ResponseDetails } from "../adapter-types.ts";

/**
 * Normalized request/response shapes, shared with every adapter so a wrapper
 * can write one helper across all five frameworks.
 */
export type { RequestDetails, ResponseDetails };

export type { Context as KoaContext } from "koa";
export type { Next as KoaNext } from "koa";
/** The Koa application object. */
export type { Koa };

/** Canonical app-type name, matching the `<Fw>App` convention across adapters. */
export type { Koa as KoaApp };
/** Canonical request-type name — Koa's request is reached through its context. */
export type { Context as KoaRequest } from "koa";
/** Koa's underlying Node response object (`ctx.res`). */
export type { ServerResponse as KoaResponse } from "node:http";
