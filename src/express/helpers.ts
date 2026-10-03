// src/express/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type { BodyResult, JsonValue } from "@thednp/rpc";
import type { ViteDevServer } from "vite";
import type { Express } from "express";
import type { RequestDetails, ResponseDetails } from "./types.d.ts";
import { createRPCMiddleware } from "./createMiddleware.ts";
import { preParsedBody, readStream } from "../body.ts";
import { safeURL } from "../server-helpers.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to an Express app.
 * Dynamically imports loadRPCConfig and creates the middleware with loaded options.
 * @param app - Express application instance
 */
export async function attachRPC(app: Express) {
  // The main plugin entry statically imports Vite, so loadRPCConfig is
  // imported lazily: function bundles that never call attachRPC (e.g.
  // serverless functions) keep Vite out of the bundle (or externalized).
  const { loadRPCConfig } = await import("@thednp/rpc");
  const options = await loadRPCConfig();
  app.use(createRPCMiddleware(options));
}

/**
 * Attaches Vite's dev server middlewares to an Express app for development mode.
 * @param app - Express application instance
 * @param vite - Running Vite dev server
 */
export function attachVite(app: Express, vite: ViteDevServer) {
  app.use(vite.middlewares);
}

/**
 * Reads and parses the HTTP request body from an Express or Node IncomingMessage.
 * If a body parser middleware (e.g. express.json()) already consumed the stream,
 * uses the pre-parsed body from `req.body`.
 * @param req - Express or Node.js IncomingMessage
 * @param limit - Streamed byte cap; `0` disables it
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = (
  req: ExpressRequest | IncomingMessage,
  limit?: number,
): Promise<BodyResult> => {
  const declared = req.headers["content-type"];

  // If an Express body parser already consumed the stream via
  // app.use(express.json()), the decoded body is authoritative.
  if (hasPreParsedBody(req) && req.body !== undefined) {
    return Promise.resolve(preParsedBody(req.body, declared));
  }

  return readStream(req, req.headers["content-type"], { limit });
};

/**
 * Type guard that checks whether a request is an Express Request (has `originalUrl`).
 * @param req - A Node IncomingMessage or Express Request
 * @returns True if the request is an Express Request
 */
export const isExpressRequest = (
  req: IncomingMessage | ExpressRequest,
): req is ExpressRequest => {
  return "originalUrl" in req;
};

/**
 * Type guard that checks whether a response is an Express Response (has `json` and `send` methods).
 * @param res - A Node ServerResponse or Express Response
 * @returns True if the response is an Express Response
 */
export const isExpressResponse = (
  res: ServerResponse | ExpressResponse,
): res is ExpressResponse => {
  return "json" in res && "send" in res;
};

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
export const redirect = (
  res: ServerResponse | ExpressResponse,
  location: string,
  status = 303,
): void => {
  if (isExpressResponse(res)) {
    res.redirect(status, location);
    return;
  }
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
};

/**
 * Type guard that checks whether a request has a pre-parsed body (`body` property).
 * Used to detect if a body-parser middleware already consumed the stream.
 * @param req - A Node IncomingMessage or Express Request
 * @returns True if the request has a body property
 */
export const hasPreParsedBody = (
  req: IncomingMessage | ExpressRequest,
): req is ExpressRequest => {
  return "body" in req;
};

/**
 * Extracts normalized request details from an Express or Node IncomingMessage.
 * Parses the URL to extract pathname, search string, and search params.
 * @param request - Express or Node.js request object
 * @returns Normalized request details including URL, headers, and method
 */
export const getRequestDetails = (
  request: ExpressRequest | IncomingMessage,
): RequestDetails => {
  const rawUrl = (
    isExpressRequest(request) ? request.originalUrl : request.url
  ) as string;
  const url = safeURL(rawUrl);

  return {
    url: url.pathname,
    search: url.search,
    searchParams: url.searchParams,
    headers: request.headers,
    method: request.method,
  };
};

/**
 * Wraps an Express or Node ServerResponse with a uniform API for setting headers,
 * status codes, and sending JSON responses. Handles the Express vs raw Node API differences.
 * @param response - Express or Node.js server response object
 * @returns A ResponseDetails object with setHeader, setStatusCode, and sendResponse helpers
 */
export const getResponseDetails = (
  response: ExpressResponse | ServerResponse,
): ResponseDetails => {
  const isResponseSent = response.headersSent || response.writableEnded;

  const setHeader = (name: string, value: string | readonly string[]) => {
    // A readonly array cannot flow into the mutable slots below, and
    // spreading a string would split it into characters — branch first.
    const outgoing = typeof value === "string" ? value : [...value];
    if (isExpressResponse(response)) {
      response.header(name, outgoing);
    } else {
      response.setHeader(name, outgoing);
    }
  };

  const setStatusCode = (code: number) => {
    if (isExpressResponse(response)) {
      response.status(code);
    } else {
      response.statusCode = code;
    }
  };

  const sendResponse = (code: number, output: JsonValue) => {
    setStatusCode(code);
    setHeader("Content-Type", "application/json");

    if (isExpressResponse(response)) {
      response.send(JSON.stringify(output));
    } else {
      response.end(JSON.stringify(output));
    }
  };

  return {
    isResponseSent,
    setHeader,
    statusCode: response.statusCode,
    setStatusCode,
    sendResponse,
  };
};
