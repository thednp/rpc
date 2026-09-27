import type { Connect } from "vite";
import type { AdapterName, MiddlewareOptions } from "@thednp/rpc";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction, Request, Response } from "express";
import type { RequestDetails, ResponseDetails } from "../adapter-types.ts";

/**
 * Normalized request/response shapes, shared with every adapter so a wrapper
 * can write one helper across all five frameworks. Re-exported here for
 * back-compat — `@thednp/rpc/express` has always exported these.
 */
export type { RequestDetails, ResponseDetails };

/**
 * Express-specific middleware options, constrained to the `"express"` adapter.
 */
export type ExpressMiddlewareOptions = MiddlewareOptions<"express">;

/**
 * Express middleware factory: takes optional initial options and returns
 * the Express/Connect-compatible handler.
 */
export type ExpressMiddlewareFn = <
  A extends AdapterName = "express",
>(
  initialOptions?: Partial<ExpressMiddlewareOptions>,
) => ExpressMiddlewareHooks["handler"];

/**
 * Express/Connect middleware handler signature used by the RPC middleware.
 */
export interface ExpressMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Node or Express request object
   * @param res - Node or Express response object
   * @param next - Connect or Express next function
   */
  handler: (
    req: IncomingMessage | Request,
    res: ServerResponse | Response,
    next: Connect.NextFunction | NextFunction,
  ) => Promise<void>;
}

/**
 * Framework types re-exported from `express` so consumers can annotate
 * apps, handlers, and middleware without a direct dependency on express
 * types. The RPC middleware handler tuple is composed of these.
 */
export type { Express } from "express";
/** Canonical app-type name, matching the `<Fw>App` convention across adapters. */
export type { Express as ExpressApp } from "express";
export type { Request as ExpressRequest } from "express";
export type { Response as ExpressResponse } from "express";
export type { NextFunction as ExpressNext } from "express";
