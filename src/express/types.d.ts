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

export type ResponseDetails = {
  isResponseSent: boolean;
  setHeader: (name: string, value: string) => void;
  statusCode: number;
  setStatusCode: (code: number) => void;
  sendResponse: (code: number, output: Record<string, JsonValue>) => void;
};

export type RequestDetails = {
  url: string;
  search: string;
  searchParams: URLSearchParams;
  headers: IncomingHttpHeaders;
  method: string | undefined;
};
