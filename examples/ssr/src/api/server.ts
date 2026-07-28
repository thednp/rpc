import { createServerFunction } from "@thednp/rpc/server";
import { normalizeValue } from "../util/helpers";
import * as v from "valibot";

export const sayHi = createServerFunction(
  "say-hi",
  async (signal, name: string) => {
    signal.throwIfAborted();
    await new Promise((res) => setTimeout(res, 1500));
    signal.throwIfAborted();
    return `Hello ${name}!`;
  },
);

const AddSchema = v.object({
  a: v.number(),
  b: v.number(),
});

export const add = createServerFunction(
  "add-numbers",
  async (signal, formData: string) => {
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
);
