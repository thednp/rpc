// src/koa/types.d.ts
import type { Context, Next } from "koa";
import type {
  JsonValue,
  MiddlewareOptions,
  RpcPluginOptions,
} from "@thednp/rpc";

export type KoaMiddlewareOptions = MiddlewareOptions<"koa">;

export interface KoaContext extends Context {
  request: Context["request"] & { body?: string | JsonValue };
}

export interface KoaMiddlewareHooks {
  handler: (ctx: Context, next: Next) => Promise<void>;
}

export type KoaMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "koa">(
  initialOptions?: Partial<KoaMiddlewareOptions>,
) => KoaMiddlewareHooks["handler"];
