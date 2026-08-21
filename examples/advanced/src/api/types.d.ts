import type { JsonArray, JsonObject, JsonValue } from "@thednp/rpc";

export interface User extends JsonObject {
  id: string;
  name: string;
  email: string;
}

export interface UserFull extends JsonObject {
  id: string;
  name: string;
  email: string;
  ssn: string;
  role: string;
}

export interface ServerTime extends JsonObject {
  locale: string;
  time: string;
  iso: string;
}
