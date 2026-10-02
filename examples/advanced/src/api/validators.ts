/**
 * The same input contract, written five times — once per Standard Schema
 * library, plus rpc's own dependency-free builder — so the page can send
 * identical input through each and compare what comes back.
 *
 * This file is the point of the demo. rpc's `schema` option takes any Standard
 * Schema, so none of this reaches rpc as more than `StandardSchemaV1<in, out>`:
 * there is no per-library branch anywhere in the library, and the differences you
 * see in the browser are the *libraries'*, not rpc's.
 *
 * Where they genuinely differ, the difference is left visible rather than papered
 * over — see the note on {@link VALIDATOR_NOTES}.
 */
import {
  array,
  field,
  optional,
  schema,
  type StandardSchemaV1,
} from "@thednp/rpc/server";
import type { ValidatorName } from "./types.d.ts";
import { VALIDATORS } from "./validator-info.ts";
import { type } from "arktype";
import { Schema } from "effect";
import * as v from "valibot";
import { z } from "zod";

/**
 * A schema for the validator name itself, built with rpc's own builder — so
 * switching validators is a validated RPC call like anything else, and the page
 * needs no validator library to send it.
 */
export const SELECTOR_SCHEMA: StandardSchemaV1<
  unknown,
  { name: ValidatorName }
> = {
  "~standard": {
    version: 1,
    vendor: "thednp.rpc",
    validate: (value: unknown) => {
      const name = (value as { name?: unknown })?.name;
      if (typeof name !== "string" || !VALIDATORS.includes(name as never)) {
        return {
          issues: [{
            message: `must be one of: ${VALIDATORS.join(", ")}`,
            path: ["name"],
          }],
        };
      }
      return { value: { name: name as ValidatorName } };
    },
  },
};

/* ─── valibot ──────────────────────────────────────────────────────────── */

export const valibotProfile = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  // Accepts the string a `<form>` sends and normalises it, which is why the
  // handler receives `age: number` with no cast.
  age: v.pipe(
    v.union([v.string(), v.number()]),
    v.transform(Number),
    v.number(),
    v.integer(),
    v.minValue(0),
  ),
  tags: v.array(v.string()),
  address: v.object({
    city: v.pipe(v.string(), v.minLength(1)),
    zip: v.optional(v.string()),
  }),
});

/* ─── zod ──────────────────────────────────────────────────────────────── */

export const zodProfile = z.object({
  name: z.string().min(1).max(40),
  age: z
    .union([z.string(), z.number()])
    .transform(Number)
    .pipe(z.number().int().min(0)),
  tags: z.array(z.string()),
  address: z.object({
    city: z.string().min(1),
    zip: z.string().optional(),
  }),
});

/* ─── arktype ──────────────────────────────────────────────────────────── */

/**
 * **The one that needs `schema.from`.**
 *
 * arktype's `Type` carries the whole expression graph — `infer`, `expression`,
 * `json`, the morph flags — and `createServerFunction` infers the handler's
 * parameter with a *structural* match against the schema's own type. That graph
 * does not fit the instantiation budget an older TypeScript allows, so the call
 * fails with TS2589 ("Type instantiation is excessively deep and possibly
 * infinite") on TS 5.x while passing on TS 7. Measured here rather than assumed:
 * with the raw type the example does not compile on 5.9.2, and it does with
 * this wrapper.
 *
 * It is applied at the *declaration* rather than at each call site on purpose —
 * the heaviness is a property of arktype's types, not of one registration, and a
 * wrapper in a call site is a wrapper the next person forgets.
 *
 * The other three are not wrapped because they do not need it. That is the whole
 * point of `from`: it is not ceremony, it is a fix for one specific library.
 */
/**
 * arktype's coercion: a **function** pipe. `type("string|number")` alone rejects
 * `"36"`, and a second `.pipe(type("number"))` does not transform either — but a
 * pipe whose target is a function does, and chaining a constrained type after it
 * restores the integer and range rules the other three express in one step.
 *
 * An earlier draft of this file claimed arktype could not coerce at all, on the
 * grounds that no `morph` is exported. That was wrong: the export list is
 * `ark, configure, declare, define, fn, generic, inferred, keywords, match,
 * regex, scope, type` — no `morph`, and no coercion combinator by that name, but
 * a function pipe is one. The claim was a guess from a missing export, and the
 * page is better for having been checked.
 */
const arktypeNumeric = type("string|number")
  .pipe((value) => Number(value))
  .pipe(type("number.integer >= 0"));

export const arktypeProfile = schema.from(type({
  name: "1 <= string <= 40",
  age: arktypeNumeric,
  tags: "string[]",
  address: {
    city: "string >= 1",
    "zip?": "string",
  },
}));

/* ─── effect ────────────────────────────────────────────────────────────── */

/**
 * effect does not put `~standard` on a `Schema` — the spec adapter is
 * `Schema.toStandardSchemaV1` (named `standardSchemaV1` before effect 4.0.0
 * went stable), which is the documented way to hand a Schema to anything that
 * speaks the standard. Wrapping here rather than at the call site keeps the
 * four registrations identical in shape.
 */
export const effectProfile = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
    ),
    // `NumberFromString` is effect's coercion combinator, and the union is what
    // makes it accept a real number too — the same `string | number` contract
    // the other two express with a pipe. effect 4's checks are `is*` filters
    // applied via `Schema.check` rather than the old pipeable `Schema.int()` /
    // `Schema.greaterThanOrEqualTo()` helpers.
    age: Schema.Union([Schema.Finite, Schema.NumberFromString]).pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
    tags: Schema.Array(Schema.String),
    address: Schema.Struct({
      city: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      zip: Schema.optional(Schema.String),
    }),
  }),
);

"All four vendor libraries ignore an unknown key. rpc's own `schema()` builder is the strict one — it rejects — so the library, not the option, decides this.";

/* ─── rpc's own builder ────────────────────────────────────────────────── */

/**
 * The fifth profile, and the only one with no vendor: `schema()`/`field`
 * from `@thednp/rpc/server` itself. Structure and primitive types only — no
 * coercion, no ranges — so it draws the contract's boundary lines in
 * different places (see `VALIDATOR_NOTES`), while hints, the `422` body,
 * and the inferred handler types work exactly as they do for the vendors.
 */
export const builderProfile = schema({
  name: field.string(),
  age: field.number(),
  tags: array(field.string()),
  address: schema({
    city: field.string(),
    zip: optional(field.string()),
  }),
});
