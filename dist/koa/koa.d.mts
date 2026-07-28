import Koa, { Context, Next } from "koa";
import { BodyResult, JsonValue, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
//#region src/koa/types.d.ts
type KoaMiddlewareOptions = MiddlewareOptions<"koa">;
interface KoaContext extends Context {
  request: Context["request"] & {
    body?: string | JsonValue;
  };
}
interface KoaMiddlewareHooks {
  handler: (ctx: Context, next: Next) => Promise<void>;
}
type KoaMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "koa">(initialOptions?: Partial<KoaMiddlewareOptions>) => KoaMiddlewareHooks["handler"];
//#endregion
//#region src/koa/createMiddleware.d.ts
declare const createMiddleware: KoaMiddlewareFn;
declare const createRPCMiddleware: KoaMiddlewareFn;
//#endregion
//#region src/koa/helpers.d.ts
declare function attachRPC(app: Koa): Promise<void>;
declare function attachVite(app: Koa, vite: ViteDevServer): void;
declare const readBody: (ctx: KoaContext) => Promise<BodyResult>;
//#endregion
export { type Koa, type KoaContext, type KoaMiddlewareFn, type KoaMiddlewareHooks, type KoaMiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };
//# sourceMappingURL=koa.d.mts.map