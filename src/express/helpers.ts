// src/express/helpers.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import type { BodyResult, JsonValue } from "@thednp/rpc";
import { Buffer } from "node:buffer";
import type { ViteDevServer } from "vite";
import type { Express } from "express";
import { createRPCMiddleware } from "./createMiddleware.ts";

export async function attachRPC(app: Express) {
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { adapter: _adapter, ...options } = await loadRPCConfig();
  app.use(createRPCMiddleware(options));
}

export function attachVite(app: Express, vite: ViteDevServer) {
  app.use(vite.middlewares);
}

// src/express/helpers.ts
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

export const isExpressRequest = (
  req: IncomingMessage | ExpressRequest,
): req is ExpressRequest => {
  return "originalUrl" in req;
};

export const isExpressResponse = (
  res: ServerResponse | ExpressResponse,
): res is ExpressResponse => {
  return "json" in res && "send" in res;
};

export const hasPreParsedBody = (
  req: IncomingMessage | ExpressRequest,
): req is ExpressRequest => {
  return "body" in req;
};

export const getRequestDetails = (
  request: ExpressRequest | IncomingMessage,
) => {
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

export const getResponseDetails = (
  response: ExpressResponse | ServerResponse,
) => {
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
