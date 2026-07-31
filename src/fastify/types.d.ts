import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";

/**
 * Fastify-specific middleware options, constrained to the `"fastify"` adapter.
 */
export type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;

/**
 * Fastify middleware factory: takes optional initial options and returns
 * the Fastify-compatible handler.
 */
export type FastifyMiddlewareFn = <
  A extends RpcPluginOptions["adapter"] = "fastify",
>(
  initialOptions?: Partial<FastifyMiddlewareOptions>,
) => FastifyMiddlewareHooks["handler"];

/**
 * Fastify middleware handler signature used by the RPC middleware.
 */
export interface FastifyMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Fastify request object
   * @param res - Fastify reply object
   * @param done - Fastify hook completion callback
   */
  handler: (
    req: FastifyRequest,
    res: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => Promise<void>;
}

/**
 * Options accepted by the Fastify RPC plugin (`fp()`-wrapped registration).
 */
export type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  /** Whether this is an RPC plugin registration */
  isRPC: boolean;
};
