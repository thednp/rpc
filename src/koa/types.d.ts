// src/koa/types.d.ts
import type { Context, Next } from "koa";
import type {
  JsonValue,
  MiddlewareOptions,
  RpcPluginOptions,
} from "@thednp/rpc";

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
export type KoaMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "koa">(
  initialOptions?: Partial<KoaMiddlewareOptions>,
) => KoaMiddlewareHooks["handler"];
