import "vite";
import "@thednp/rpc";
import "express";
import "hono";
import "@hono/node-server";
import "hono/factory";
import "fastify";
import "koa";
//#region src/types.d.ts
type Credentials = "same-origin" | "include" | "omit";
// primitives and their compositions
type JsonPrimitive = string | number | boolean | null | undefined;
type JsonObject = {
  [key: string]: JsonValue | JsonArray;
};
type JsonArray = JsonValue[];
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
//#endregion
//#region src/helpers.d.ts
declare const handleResponse: (response: Response) => Promise<JsonValue | void>;
type InnerModReturn = {
  data: Promise<JsonValue | void>;
  cancel: (reason: string) => void;
};
declare const innerModule: (body: BodyInit, headers: HeadersInit, credentials: Credentials, prefix: string, name: string) => InnerModReturn;
//#endregion
export { handleResponse, innerModule };
//# sourceMappingURL=helpers.d.mts.map