import type { Connect } from "vite";
import type {
  JsonValue,
  MiddlewareOptions,
  RpcPluginOptions,
} from "@thednp/rpc";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { NextFunction, Request, Response } from "express";

/**
 * Express-specific middleware options, constrained to the `"express"` adapter.
 */
export type ExpressMiddlewareOptions = MiddlewareOptions<"express">;

/**
 * Express middleware factory: takes optional initial options and returns
 * the Express/Connect-compatible handler.
 */
export type ExpressMiddlewareFn = <
  A extends RpcPluginOptions["adapter"] = "express",
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
 * Wraps a server response to normalize status, header, and send operations
 * across Node `ServerResponse` and Express `Response` objects.
 */
export type ResponseDetails = {
  /** Whether the response was already sent */
  isResponseSent: boolean;
  /** Sets a response header */
  setHeader: (name: string, value: string) => void;
  /** Current response status code */
  statusCode: number;
  /** Sets the response status code */
  setStatusCode: (code: number) => void;
  /** Sends a JSON response with the given status code and output */
  sendResponse: (code: number, output: JsonValue) => void;
};

/**
 * Normalized view of an incoming request: URL parts, headers, and method.
 */
export type RequestDetails = {
  /** Full request URL (path + query string) */
  url: string;
  /** Query string including the leading `?` */
  search: string;
  /** Parsed query string parameters */
  searchParams: URLSearchParams;
  /** Raw request headers */
  headers: IncomingHttpHeaders;
  /** HTTP method (GET, POST, etc.) */
  method: string | undefined;
};

/**
 * Framework types re-exported from `express` so consumers can annotate
 * apps, handlers, and middleware without a direct dependency on express
 * types. The RPC middleware handler tuple is composed of these.
 */
export type { Express } from "express";
export type { Request as ExpressRequest } from "express";
export type { Response as ExpressResponse } from "express";
export type { NextFunction as ExpressNext } from "express";
