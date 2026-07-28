import { Connect, ViteDevServer } from "vite";
import { BodyResult, JsonValue, MiddlewareOptions, RpcPluginOptions } from "@thednp/rpc";
import { IncomingMessage, ServerResponse } from "node:http";
import { Express, NextFunction, Request, Response } from "express";
//#region src/express/types.d.ts
type ExpressMiddlewareOptions = MiddlewareOptions<"express">;
type ExpressMiddlewareFn = <A extends RpcPluginOptions["adapter"] = "express">(initialOptions?: Partial<ExpressMiddlewareOptions>) => ExpressMiddlewareHooks["handler"];
interface ExpressMiddlewareHooks {
  handler: (req: IncomingMessage | Request, res: ServerResponse | Response, next: Connect.NextFunction | NextFunction) => Promise<void>;
}
//#endregion
//#region src/express/createMiddleware.d.ts
declare const createMiddleware: ExpressMiddlewareFn;
declare const createRPCMiddleware: ExpressMiddlewareFn;
//#endregion
//#region src/express/helpers.d.ts
declare function attachRPC(app: Express): Promise<void>;
declare function attachVite(app: Express, vite: ViteDevServer): void;
declare const readBody: (req: Request | IncomingMessage) => Promise<BodyResult>;
declare const isExpressRequest: (req: IncomingMessage | Request) => req is Request;
declare const isExpressResponse: (res: ServerResponse | Response) => res is Response;
declare const hasPreParsedBody: (req: IncomingMessage | Request) => req is Request;
declare const getRequestDetails: (request: Request | IncomingMessage) => {
  url: string;
  search: string;
  searchParams: URLSearchParams;
  headers: import("node:http").IncomingHttpHeaders;
  method: string | undefined;
};
declare const getResponseDetails: (response: Response | ServerResponse) => {
  isResponseSent: boolean;
  setHeader: (name: string, value: string) => void;
  statusCode: number;
  setStatusCode: (code: number) => void;
  sendResponse: (code: number, output: Record<string, JsonValue>) => void;
};
//#endregion
export { type ExpressMiddlewareFn, type ExpressMiddlewareHooks, type ExpressMiddlewareOptions, attachRPC, attachVite, createMiddleware, createRPCMiddleware, getRequestDetails, getResponseDetails, hasPreParsedBody, isExpressRequest, isExpressResponse, readBody };
//# sourceMappingURL=express.d.mts.map