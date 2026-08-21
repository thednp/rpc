import { createServerFunction } from "@thednp/rpc/server";
import { normalizeValue } from "../util/helpers";
import { auditLog, rateLimit } from "./middleware";
import type { ServerTime, User } from "./types";
import * as v from "valibot";

const publicUserLimit = rateLimit({ max: 5, windowMs: 10_000 });

export const sayHi = createServerFunction(
  "say-hi",
  async (signal, name: string) => {
    signal?.throwIfAborted();
    await new Promise((res) => setTimeout(res, 1500));
    signal?.throwIfAborted();
    return `Hello ${name}!`;
  },
  { contentType: "text/plain", rpcPrefix: "public:rpc" },
);

const AddSchema = v.object({
  a: v.number(),
  b: v.number(),
});

export const add = createServerFunction(
  "add-numbers",
  async (signal, formData: string) => {
    auditLog();
    await new Promise((res) => setTimeout(res, 331));
    const json = JSON.parse(formData as string);
    const preparsed = Object.fromEntries(
      Object.entries(json).map(([key, val]) => [key, normalizeValue(val)]),
    );
    const valid = v.safeParse(AddSchema, preparsed);
    signal?.throwIfAborted();
    if (valid.issues) {
      const { nested } = v.flatten(valid.issues);
      return { error: nested };
    }
    signal?.throwIfAborted();

    return valid.output.a + valid.output.b;
  },
  { rpcPrefix: "public:rpc" },
);

export const getServerTime = createServerFunction(
  "get-server-time",
  async (signal, locale: string) => {
    auditLog();
    signal?.throwIfAborted();
    await new Promise((res) => setTimeout(res, 500));
    return {
      locale,
      time: new Date().toLocaleTimeString(locale),
      iso: new Date().toISOString(),
    } satisfies ServerTime;
  },
  { method: "GET", rpcPrefix: "public:rpc" },
);

// Public user record — rate-limited via universal middleware.
export const getUser = createServerFunction(
  "get-user",
  async (_signal, id: string) => {
    auditLog();
    publicUserLimit();
    return {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`,
    } satisfies User;
  },
  { rpcPrefix: "public:rpc" },
);
