import { createServerFunction } from "@thednp/rpc/server";
import * as v from "valibot";

export const sayHi = createServerFunction(
  "say-hi",
  async (signal, name: string) => {
    signal?.throwIfAborted();
    await new Promise((res) => setTimeout(res, 1500));
    signal?.throwIfAborted();
    return `Hello ${name}!`;
  },
  { contentType: "text/plain" },
);

/**
 * The no-JS `<form>` fallback submits every field as a string, while a JSON
 * client sends real numbers, so the schema accepts either and normalises to
 * `number`. The handler therefore receives `a: number, b: number` with no cast
 * and no hand-written coercion.
 *
 * This replaces a `normalizeValue` helper plus a `v.safeParse` + `v.flatten`
 * sequence that ran inside the handler. The difference that matters: the old
 * path coerced first and validated second, and its coercion accepted anything
 * numeric-ish, so a typo became a silent `NaN` rather than a `400`.
 */
const AddSchema = v.object({
  a: v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.number()),
  b: v.pipe(v.union([v.string(), v.number()]), v.transform(Number), v.number()),
});

export const add = createServerFunction(
  "add-numbers",
  async (signal, { a, b }) => {
    await new Promise((res) => setTimeout(res, 331));
    signal?.throwIfAborted();
    return a + b;
  },
  { schema: AddSchema, hint: "a and b are numbers; the form sends strings" },
);
export const getServerTime = createServerFunction(
  "get-server-time",
  async (signal, locale: string) => {
    signal?.throwIfAborted();
    await new Promise((res) => setTimeout(res, 500));
    return {
      locale,
      time: new Date().toLocaleTimeString(locale),
      iso: new Date().toISOString(),
    };
  },
  { method: "GET" },
);
