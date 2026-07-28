import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

export type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;

export type FastifyMiddlewareFn = <
  A extends RpcPluginOptions["adapter"] = "fastify",
>(
  initialOptions?: Partial<FastifyMiddlewareOptions>,
) => FastifyMiddlewareHooks["handler"];

export interface FastifyMiddlewareHooks {
  handler: (
    req: FastifyRequest,
    res: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => Promise<void>;
}

// Define the plugin function
export type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  isRPC: boolean;
};
