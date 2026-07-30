// src/express/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type { BodyResult, JsonValue } from "@thednp/rpc";
import type { Buffer } from "node:buffer";
import type { ViteDevServer } from "vite";
import type { Express } from "express";
import { createRPCMiddleware } from "./createMiddleware.ts";
import type { RequestDetails, ResponseDetails } from "./types.d.ts";

/**
 * Convenience function to load RPC config and attach the RPC middleware to an Express app.
 * Dynamically imports loadRPCConfig and creates the middleware with loaded options.
 * @param app - Express application instance
 */
export async function attachRPC(app: Express) {
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();
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
 * @returns A promise resolving to the parsed body with its content type
 */
export const readBody = (
  req: ExpressRequest | IncomingMessage,
): Promise<BodyResult> => {
  return new Promise((resolve, reject) => {
    // If an Express body parser already consumed the stream
    // via app.use(express.json()), use req.body directly
    if (hasPreParsedBody(req) && req.body !== undefined) {
      // istanbul ignore next
      const contentType = req.headers["content-type"]?.toLowerCase() || "";
      const isJSON = contentType.includes("json");
      resolve({
        contentType: isJSON ? "application/json" : "text/plain",
        data: isJSON ? req.body : String(req.body),
      } as BodyResult);
      return;
    }

    // Else we parse the body right away
    let body = "";

    const toggleListeners = (add?: boolean) => {
      const method = add ? "on" : "off";
      req[method]("data", onData);
      req[method]("end", onEnd);
      req[method]("error", onError);
    };

    const onData = (chunk: Buffer) => {
      body += chunk.toString();
    };

    const onEnd = () => {
      toggleListeners();
      const incomingType = req.headers["content-type"]?.toLowerCase() || "";
      const isJSON = incomingType.includes("json");
      try {
        const data = JSON.parse(body);
        resolve({
          contentType: isJSON ? "application/json" : "text/plain",
          data,
        });
      } catch (_e) {
        resolve({ contentType: "text/plain", data: String(body) });
      }
    };

    const onError = (err: Error) => {
      toggleListeners();

      reject(err);
    };

    toggleListeners(true);
  });
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
  const url = new URL(rawUrl, "http://localhost");

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

  const setHeader = (name: string, value: string) => {
    if (isExpressResponse(response)) {
      response.header(name, value);
    } else {
      response.setHeader(name, value);
    }
  };

  const setStatusCode = (code: number) => {
    if (isExpressResponse(response)) {
      response.status(code);
    } else {
      response.statusCode = code;
    }
  };

  const sendResponse = (code: number, output: Record<string, JsonValue>) => {
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
