import { createServerFunction, schema } from "@thednp/rpc/server";
import { auditLog, rateLimit } from "./middleware.ts";
import type { ServerTime, User } from "./types.d.ts";
import * as v from "valibot";
import type { ValidatorName } from "./types.d.ts";
import { type } from "arktype";
import {
  arktypeProfile,
  builderProfile,
  effectProfile,
  SELECTOR_SCHEMA,
  valibotProfile,
  zodProfile,
} from "./validators.ts";

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

/**
 * Accepts either a real number or a string holding one, and narrows to `number`.
 *
 * The two real callers disagree: the no-JS `<form>` fallback submits every field
 * as a string, while a JSON client sends numbers. The union covers both. The
 * alternative this replaced, `normalizeValue`, did the same conversion by hand
 * inside the handler — after the body was read, with nothing validating the
 * input, and it accepted anything coercible, so a typo became a silent `NaN`
 * rather than a `400`.
 *
 * Named, because the same shape is used twice and a schema is the one place a
 * repeated expression should not be.
 */
const numeric = v.pipe(
  v.union([v.string(), v.number()]),
  // `minLength(1)` is load-bearing. The form's fields are not `required`, so
  // clearing one and submitting sent `""` — and `Number("")` is `0`, which is a
  // perfectly valid number. The page therefore opened on `Result: 0` instead of
  // an error, and a typo in a number field was indistinguishable from a blank
  // one. This is the one place a structural check is not enough and the *value*
  // has to be constrained.
  v.check((value) => value !== "", "a number is required"),
  v.transform(Number),
  v.number(),
);

const AddSchema = v.object({ a: numeric, b: numeric });

export const add = createServerFunction(
  "add-numbers",
  // No annotation and no cast: `input` is inferred from `AddSchema`, and
  // annotating it with anything the schema does not produce is a type error.
  // Writing it out anyway would be a third copy of this shape to keep in sync.
  async (signal, { a, b }: { a: number; b: number }) => {
    auditLog();
    await new Promise((res) => setTimeout(res, 331));
    signal?.throwIfAborted();
    return a + b;
  },
  {
    rpcPrefix: "public:rpc",
    schema: AddSchema,
    // One hint for the whole function rather than one per field — the advice is
    // the same for both. A rejection is a 400 carrying this plus the issue paths,
    // in development; nothing is returned as data any more.
    hint: "a and b are numbers; the form sends them as strings",
  },
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

/**
 * The input contract for {@link getUser}, written in arktype's type-first
 * syntax — the third validator in this example, and the same `schema` option the
 * other two use.
 *
 * Three libraries, three syntaxes, one interface:
 *
 * | validator | shape | note |
 * | --- | --- | --- |
 * | valibot  | `v.object({...})`  | value-first, plus a coercion pipe on `add` |
 * | zod      | `z.string()…`      | builder chain, on the `admin:rpc` prefix |
 * | arktype  | `type("string ≤ 64")` | type-first, and a `narrow` for the trim rule |
 *
 * The `narrow` is what a bare type expression cannot say: `"string >= 1"` counts
 * characters, and `"   "` has three of them. Trimming first is the difference
 * between rejecting a whitespace-only id and accepting one.
 *
 * The `schema.from(...)` wrapper is load-bearing for types, and the runtime
 * behaviour is identical without it — it returns the same object. See
 * `schema.from` for the full note; in short, arktype's `.narrow()` produces a
 * type graph too large for an older TypeScript to walk at the
 * `createServerFunction` call, and the boundary moves that work to a separate
 * inference site. Prefer this over dropping the `narrow`.
 */
const userIdSchema = schema.from(
  type("string <= 64").narrow((value, ctx) =>
    value.trim().length >= 1 ? true : ctx.mustBe("a non-empty user id")
  ),
);

// Public user record — rate-limited via universal middleware.
export const getUser = createServerFunction(
  "get-user",
  async (_signal, id) => {
    auditLog();
    publicUserLimit();
    return await Promise.resolve(
      {
        id,
        name: `User ${id}`,
        email: `user${id}@example.com`,
      } satisfies User,
    );
  },
  {
    rpcPrefix: "public:rpc",
    // arktype implements Standard Schema, so this is the same option the public
    // `add` uses with valibot and the admin `get-user` uses with zod.
    schema: userIdSchema,
    hint: "the id from the input above, e.g. u-42",
  },
);

/* ─── Five validators, one option ────────────────────────────────────────────
 *
 * Five functions with identical bodies and identical options, differing only in
 * the schema each declares. The point is what does *not* differ: rpc receives
 * five `StandardSchemaV1` values and has no idea which library produced any of
 * them — the fifth was produced by no library at all. Each is registered under
 * its own name so the network panel says which validator ran — which is the
 * whole reason to wire this into a page.
 */

const summarise = (p: {
  name: string;
  age: number;
  tags: readonly string[];
  address: { city: string };
}) => ({
  name: p.name,
  age: p.age,
  // The `age` type is the proof the schema's *output* reached the handler: all
  // four declare `number` here, and a caller that sent `"30"` still arrives as
  // a number — except arktype, which rejects rather than coerces.
  ageType: typeof p.age,
  tagCount: p.tags.length,
  city: p.address.city,
});

const VALIDATOR_HINT =
  "name 1-40 chars, age a non-negative integer, tags an array of strings";

/**
 * Per-field hints, shared by all five profiles.
 *
 * These exist to be **sent**, and that is the point: a `hint` is authored here
 * in `ServerFunctionOptions`, so disclosing it in production was deliberate —
 * unlike the validator library's own `message`, which some libraries interpolate
 * the failing value into (valibot does, zod and arktype do not). A production
 * rejection therefore still arrives with `path` and `hint` for each bad field and
 * no `message` at all, which is what the "Production" panel on this page shows.
 *
 * Shared unchanged by the builder profile on purpose: the hint layer is
 * schema-agnostic, so identical options mean identical `422` bodies whichever
 * schema produced them.
 */
const VALIDATOR_HINTS = {
  name: "1 to 40 characters",
  age: "a non-negative whole number, as a string or a number",
  "address.city": "a non-empty city name",
  "tags": "a list of strings",
} satisfies Record<string, string>;

export const profileWithValibot = createServerFunction(
  "profile-valibot",
  async (signal, profile) => {
    await new Promise((res) => setTimeout(res, 120));
    signal?.throwIfAborted();
    return { via: "valibot" as const, ...summarise(profile) };
  },
  {
    rpcPrefix: "public:rpc",
    schema: valibotProfile,
    hint: VALIDATOR_HINT,
    hints: VALIDATOR_HINTS,
  },
);

export const profileWithZod = createServerFunction(
  "profile-zod",
  async (signal, profile) => {
    await new Promise((res) => setTimeout(res, 120));
    signal?.throwIfAborted();
    return { via: "zod" as const, ...summarise(profile) };
  },
  {
    rpcPrefix: "public:rpc",
    schema: zodProfile,
    hint: VALIDATOR_HINT,
    hints: VALIDATOR_HINTS,
  },
);

export const profileWithArktype = createServerFunction(
  "profile-arktype",
  async (signal, profile) => {
    await new Promise((res) => setTimeout(res, 120));
    signal?.throwIfAborted();
    return { via: "arktype" as const, ...summarise(profile) };
  },
  {
    rpcPrefix: "public:rpc",
    schema: arktypeProfile,
    hint: VALIDATOR_HINT,
    hints: VALIDATOR_HINTS,
  },
);

export const profileWithEffect = createServerFunction(
  "profile-effect",
  async (signal, profile) => {
    await new Promise((res) => setTimeout(res, 120));
    signal?.throwIfAborted();
    return { via: "effect" as const, ...summarise(profile) };
  },
  {
    rpcPrefix: "public:rpc",
    schema: effectProfile,
    hint: VALIDATOR_HINT,
    hints: VALIDATOR_HINTS,
  },
);

export const profileWithBuilder = createServerFunction(
  "profile-builder",
  async (signal, profile) => {
    await new Promise((res) => setTimeout(res, 120));
    signal?.throwIfAborted();
    return { via: "builder" as const, ...summarise(profile) };
  },
  {
    rpcPrefix: "public:rpc",
    schema: builderProfile,
    hint: VALIDATOR_HINT,
    hints: VALIDATOR_HINTS,
  },
);

/**
 * The radio's RPC: tells the server which validator the client has selected.
 *
 * The server does not *need* this — each validator is a separate function — but
 * it is what makes the selection observable server-side, which is the debugging
 * half of the demo. It is itself validated, with a hand-written Standard Schema
 * rather than a library, so switching validators needs no validator on the wire.
 */
export const selectValidator = createServerFunction(
  "select-validator",
  async (signal, input) => {
    auditLog();
    signal?.throwIfAborted();
    return await Promise.resolve(
      { selected: input.name, known: true } satisfies {
        selected: ValidatorName;
        known: boolean;
      },
    );
  },
  {
    rpcPrefix: "public:rpc",
    schema: schema.from(SELECTOR_SCHEMA),
    hint: "one of valibot, zod, arktype, effect, builder",
  },
);
