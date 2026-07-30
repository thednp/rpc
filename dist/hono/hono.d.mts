import { createMiddleware as createMiddleware$1 } from "hono/factory";
import { Context, Hono, MiddlewareHandler } from "hono";
import { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { HttpBindings } from "@hono/node-server";
import { ViteDevServer } from "vite";
import "express";
import "fastify";
import "koa";
//#region src/hono/types.d.ts
type HonoMiddlewareOptions = MiddlewareOptions<"hono">;
interface HonoMiddlewareHooks {
  handler: MiddlewareHandler;
}
type HonoMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "hono">(initialOptions?: Partial<MiddlewareOptions<A>>) => HonoMiddlewareHooks["handler"];
//#endregion
//#region src/hono/createMiddleware.d.ts
declare const createMiddleware: HonoMiddlewareFn;
declare const createRPCMiddleware: HonoMiddlewareFn;
//#endregion
//#region src/types.d.ts
type BodyResult = {
  contentType: "application/json";
  data: JsonValue;
} | {
  contentType: "text/plain";
  data: string;
};
// primitives and their compositions
type JsonPrimitive = string | number | boolean | null | undefined;
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
//#endregion
//#region src/hono/helpers.d.ts
declare function attachRPC(app: Hono): Promise<void>;
declare const attachVite: (app: Hono, vite: ViteDevServer) => void;
/**
 * Creates a hono compatible middleware for a given vite development server.
 * @see https://github.com/honojs/hono/issues/3162#issuecomment-2331118049
 * @param vite the vite development server
 */
declare const viteMiddleware: (vite: ViteDevServer) => ReturnType<typeof createMiddleware$1<{
  Bindings: HttpBindings;
}>>;
declare const readBody: (c: Context) => Promise<BodyResult>;
//#endregion
export { type HonoMiddlewareFn, type HonoMiddlewareHooks, type HonoMiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody, viteMiddleware };
//# sourceMappingURL=hono.d.mts.map