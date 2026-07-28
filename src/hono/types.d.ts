import type { MiddlewareHandler } from "hono";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

export type HonoMiddlewareOptions = MiddlewareOptions<"hono">;

export interface HonoMiddlewareHooks {
  handler: MiddlewareHandler;
}

export type HonoMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "hono">(
  initialOptions?: Partial<MiddlewareOptions<A>>,
) => HonoMiddlewareHooks["handler"];
