import "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "fastify";
import "koa";
//#region src/types.d.ts
type Credentials = "same-origin" | "include" | "omit";
//#endregion
//#region src/helpers.d.ts
declare const handleResponse: (response: Response) => Promise<any>;
declare const innerModule: (body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string) => {
  data: Promise<any>;
  cancel: (reason: string) => void;
};
//#endregion
export { handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map