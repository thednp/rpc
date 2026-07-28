import type { Connect } from "vite";
import type { MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction, Request, Response } from "express";

export type ExpressMiddlewareOptions = MiddlewareOptions<"express">;

export type ExpressMiddlewareFn = <
  A extends RpcPluginOptions["adapter"] = "express",
>(
  initialOptions?: Partial<ExpressMiddlewareOptions>,
) => ExpressMiddlewareHooks["handler"];

export interface ExpressMiddlewareHooks {
  handler: (
    req: IncomingMessage | Request,
    res: ServerResponse | Response,
    next: Connect.NextFunction | NextFunction,
  ) => Promise<void>;
}
