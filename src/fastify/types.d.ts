import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type fp from "fastify-plugin";
import type { AdapterName, MiddlewareOptions } from "@thednp/rpc";

/**
 * Fastify RPC plugin signature: registers the middleware as a preHandler hook.
 */
export type FastifyRPCPlugin = (
  fastify: FastifyInstance,
  initialOptions: Partial<MiddlewareOptions<"fastify">>,
  done: () => void,
) => void;

/**
 * `fastify-plugin` function type, used to type the wrapped export.
 */
export type FastifyPlugin = typeof fp;

/**
 * Return type of `fastify-plugin` wrapping, matching the final plugin export.
 */
export type RegisteredFastifyRPCPlugin = ReturnType<FastifyPlugin>;

/**
 * Options accepted by the Fastify RPC plugin (`fp()`-wrapped registration).
 */
export type RpcFastifyPluginOptions = MiddlewareOptions<"fastify"> & {
  /** Whether this is an RPC plugin registration */
  isRPC: boolean;
};

/**
 * Fastify-specific middleware options, constrained to the `"fastify"` adapter.
 */
export type FastifyMiddlewareOptions = MiddlewareOptions<"fastify">;

/**
 * Fastify middleware factory: takes optional initial options and returns
 * the Fastify-compatible handler.
 */
export type FastifyMiddlewareFn = <
  A extends AdapterName = "fastify",
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
 * Framework types re-exported from `fastify` so consumers can annotate
 * instances, requests, and replies without a direct dependency on fastify
 * types.
 */
import type { RequestDetails, ResponseDetails } from "../adapter-types.ts";

/**
 * Normalized request/response shapes, shared with every adapter so a wrapper
 * can write one helper across all five frameworks.
 */
export type { RequestDetails, ResponseDetails };

export type { FastifyInstance as Fastify } from "fastify";
/** Canonical app-type name, matching the `<Fw>App` convention across adapters. */
export type { FastifyInstance as FastifyApp } from "fastify";
export type { FastifyRequest } from "fastify";
export type { FastifyReply } from "fastify";
/** Canonical response-type name, matching the `<Fw>Response` convention. */
export type { FastifyReply as FastifyResponse } from "fastify";
/** The `done` callback a Fastify hook receives — the `next` equivalent. */
export type { HookHandlerDoneFunction as FastifyNext } from "fastify";
