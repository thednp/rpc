import { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { ViteDevServer } from "vite";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "koa";
//#region src/fastify/types.d.ts
type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;
type FastifyMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "fastify">(initialOptions?: Partial<FastifyMiddlewareOptions>) => FastifyMiddlewareHooks["handler"];
interface FastifyMiddlewareHooks {
  handler: (req: FastifyRequest, res: FastifyReply, done: HookHandlerDoneFunction) => Promise<void>;
}
// Define the plugin function
type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  isRPC: boolean;
};
//#endregion
//#region src/fastify/createMiddleware.d.ts
declare const createMiddleware: FastifyMiddlewareFn;
declare const createRPCMiddleware: FastifyMiddlewareFn;
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
//#region src/fastify/helpers.d.ts
declare function attachRPC(app: FastifyInstance): Promise<void>;
declare function attachVite(app: FastifyInstance, vite: ViteDevServer): void;
declare const readBody: (req: FastifyRequest) => Promise<BodyResult>;
//#endregion
export { type FastifyMiddlewareFn, type FastifyMiddlewareHooks, type FastifyMiddlewareOptions, type RpcFastifyPluginOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, readBody };
//# sourceMappingURL=fastify.d.mts.map