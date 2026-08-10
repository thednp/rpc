import { Connect, ViteDevServer } from "vite";
import { BodyResult, JsonValue, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Express, NextFunction, Request, Response } from "express";
//#region src/express/types.d.ts
/**
 * Express-specific middleware options, constrained to the `"express"` adapter.
 */
type ExpressMiddlewareOptions = MiddlewareOptions<"express">;
/**
 * Express middleware factory: takes optional initial options and returns
 * the Express/Connect-compatible handler.
 */
type ExpressMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "express">(initialOptions?: Partial<ExpressMiddlewareOptions>) => ExpressMiddlewareHooks["handler"];
/**
 * Express/Connect middleware handler signature used by the RPC middleware.
 */
interface ExpressMiddlewareHooks {
  /**
   * The handler invoked for each matched request.
   * @param req - Node or Express request object
   * @param res - Node or Express response object
   * @param next - Connect or Express next function
   */
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
/**
 * Wraps a server response to normalize status, header, and send operations
 * across Node `ServerResponse` and Express `Response` objects.
 */
type ResponseDetails = {
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
type RequestDetails = {
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
//#endregion
//#region src/express/createMiddleware.d.ts
/**
 * Creates an Express middleware with optional path and rpcPrefix filtering.
 * Middleware names are deduplicated — reusing a name throws an error.
 * Prefix and path regexes are compiled once at creation time (hoisted) for performance.
 * @param initialOptions - Options for rpcPrefix, path matching, and the handler function
 * @returns An Express middleware function
 */
declare const createMiddleware: ExpressMiddlewareFn;
/**
 * Creates the Express RPC middleware that routes incoming requests to registered server functions.
 * Reads the request body, dispatches to the matching function via serverFunctionsMap,
 * and sends the JSON-serialized result. Handles client disconnection via abort signals.
 * @param initialOptions - Options including rpcPrefix for URL routing
 * @returns An Express middleware function
 */
declare const createRPCMiddleware: ExpressMiddlewareFn;
//#endregion
//#region src/express/helpers.d.ts
/**
 * Convenience function to load RPC config and attach the RPC middleware to an Express app.
 * Dynamically imports loadRPCConfig and creates the middleware with loaded options.
 * @param app - Express application instance
 */
declare function attachRPC(app: Express): Promise<void>;
/**
 * Attaches Vite's dev server middlewares to an Express app for development mode.
 * @param app - Express application instance
 * @param vite - Running Vite dev server
 */
declare function attachVite(app: Express, vite: ViteDevServer): void;
/**
 * Reads and parses the HTTP request body from an Express or Node IncomingMessage.
 * If a body parser middleware (e.g. express.json()) already consumed the stream,
 * uses the pre-parsed body from `req.body`.
 * @param req - Express or Node.js IncomingMessage
 * @returns A promise resolving to the parsed body with its content type
 */
declare const readBody: (req: Request | IncomingMessage) => Promise<BodyResult>;
/**
 * Type guard that checks whether a request is an Express Request (has `originalUrl`).
 * @param req - A Node IncomingMessage or Express Request
 * @returns True if the request is an Express Request
 */
declare const isExpressRequest: (req: IncomingMessage | Request) => req is Request;
/**
 * Type guard that checks whether a response is an Express Response (has `json` and `send` methods).
 * @param res - A Node ServerResponse or Express Response
 * @returns True if the response is an Express Response
 */
declare const isExpressResponse: (res: ServerResponse | Response) => res is Response;
/**
 * Issues an HTTP redirect on an Express or raw Node ServerResponse.
 * Uses Express's native `res.redirect(status, location)` when an Express
 * Response is provided, otherwise writes the status code and `Location`
 * header directly on the raw `ServerResponse` (safe for Connect-compatible
 * middlewares and serverless adapters whose mock responses lack `.redirect`).
 * Defaults to `303 See Other` for convention (Post/Redirect/Get).
 * @param res - Express Response or raw Node ServerResponse
 * @param location - The URL to redirect to
 * @param status - HTTP status code, defaults to 303
 */
declare const redirect: (res: ServerResponse | Response, location: string, status?: number) => void;
/**
 * Type guard that checks whether a request has a pre-parsed body (`body` property).
 * Used to detect if a body-parser middleware already consumed the stream.
 * @param req - A Node IncomingMessage or Express Request
 * @returns True if the request has a body property
 */
declare const hasPreParsedBody: (req: IncomingMessage | Request) => req is Request;
/**
 * Extracts normalized request details from an Express or Node IncomingMessage.
 * Parses the URL to extract pathname, search string, and search params.
 * @param request - Express or Node.js request object
 * @returns Normalized request details including URL, headers, and method
 */
declare const getRequestDetails: (request: Request | IncomingMessage) => RequestDetails;
/**
 * Wraps an Express or Node ServerResponse with a uniform API for setting headers,
 * status codes, and sending JSON responses. Handles the Express vs raw Node API differences.
 * @param response - Express or Node.js server response object
 * @returns A ResponseDetails object with setHeader, setStatusCode, and sendResponse helpers
 */
declare const getResponseDetails: (response: Response | ServerResponse) => ResponseDetails;
//#endregion
export { type ExpressMiddlewareFn, type ExpressMiddlewareHooks, type ExpressMiddlewareOptions, type RequestDetails, type ResponseDetails, attachRPC, attachVite, createMiddleware, createRPCMiddleware, getRequestDetails, getResponseDetails, hasPreParsedBody, isExpressRequest, isExpressResponse, readBody, redirect };
//# sourceMappingURL=express.d.mts.map