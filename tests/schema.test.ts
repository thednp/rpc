/** @module Tests for the input-validation contract: the Standard Schema runner, the typed error, and the structural builder. */
import { describe, expect, it } from "vitest";

import {
  array,
  field,
  nullable,
  optional,
  record,
  runValidation,
  schema,
} from "../src/schema.ts";
import type { InferInput, InferOutput } from "../src/schema.ts";
import { createServerFunction } from "../src/createFunction.ts";
import {
  clientErrorMessage,
  clientErrorStatus,
  formatError,
  ValidationError,
  validationErrorBody,
} from "../src/server-helpers.ts";
import type { StandardSchemaV1, ValidationIssue } from "../src/types.d.ts";

/** The settled result of a validation, however it was produced. */
type Settled =
  | { ok: true; value: unknown }
  | { ok: false; error: ValidationError };

/**
 * The rendered issues a rejection produced, or `null` when it was accepted.
 *
 * Accepts a promise or an already-awaited result, so a test can write whichever
 * reads better without the argument type becoming the thing under test.
 */
const issues = async (
  result: Settled | Promise<Settled>,
): Promise<ValidationIssue[] | null> => {
  const settled = await result;
  return settled.ok ? null : [...settled.error.issues];
};

/** The paths a rejection reported. */
const paths = async (
  result: Settled | Promise<Settled>,
): Promise<(string | undefined)[] | null> =>
  (await issues(result))?.map((i) => i.path) ?? null;

describe("runValidation", () => {
  it("returns the validated value when the input matches", async () => {
    const s = schema({ email: field.string(), age: field.number() });
    const r = await runValidation(s, { email: "a@b.c", age: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ email: "a@b.c", age: 30 });
  });

  it("rejects with a 422 ValidationError carrying the rendered issues", async () => {
    const s = schema({ email: field.string() });
    const r = await runValidation(s, { email: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ValidationError);
      // 422, not 400: the body parsed and the fields are wrong, which is a
      // different thing from a request that could not be parsed at all. Sharing
      // one status left a client unable to tell a broken body from a rejected
      // input without reading prose.
      expect(clientErrorStatus(r.error)).toBe(422);
      expect(r.error.issues).toEqual([
        { path: "email", message: "expected a string" },
      ]);
    }
  });

  it("rejects a non-object for an object schema", async () => {
    const list = await issues(
      runValidation(schema({ a: field.string() }), 5),
    );
    expect(list?.[0].message).toBe("expected an object");
  });

  it("accepts any Standard Schema, not just ours", async () => {
    const foreign: StandardSchemaV1<unknown, { n: number }> = {
      "~standard": {
        version: 1,
        vendor: "some-other-library",
        validate: (value) =>
          typeof (value as { n?: unknown })?.n === "number"
            ? { value: value as { n: number } }
            : { issues: [{ message: "n must be a number", path: ["n"] }] },
      },
    };
    expect((await runValidation(foreign, { n: 1 })).ok).toBe(true);
    const list = await issues(runValidation(foreign, { n: "x" }));
    expect(list?.[0].message).toBe("n must be a number");
  });

  it("awaits an async validator instead of treating the Promise as valid", async () => {
    // The spec allows `validate` to return a Promise. A consumer that reads the
    // result synchronously sees `issues === undefined` on the Promise object,
    // concludes the input was valid, and hands the handler the Promise — so
    // async validation would be silently skipped.
    const asyncOk: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "async-lib",
        validate: async (value) =>
          value === "good"
            ? { value: "accepted" }
            : { issues: [{ message: "not good" }] },
      },
    };
    const good = await runValidation(asyncOk, "good");
    expect(good.ok && good.value).toBe("accepted");

    const bad = await runValidation(asyncOk, "bad");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error.issues[0].message).toBe("not good");
  });

  it("propagates async through a composed builder schema", async () => {
    // Every composition point has to cope, not just the runner.
    const asyncLeaf: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "async-lib",
        validate: async (value) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "nope" }] },
      },
    };
    const s = schema({
      name: field.custom(asyncLeaf),
      tags: array(field.custom(asyncLeaf)),
    });
    expect((await runValidation(s, { name: "x", tags: ["y"] })).ok).toBe(true);
    expect(
      await paths(await runValidation(s, { name: 1, tags: [2] })),
    ).toEqual(["name", "tags[0]"]);
  });

  it("stays synchronous when nothing in the schema is async", () => {
    // The common case should not pay a microtask: the runner may return a
    // Promise, but a purely synchronous schema resolves to a plain result.
    const s = schema({ a: field.string() });
    const impl = s["~standard"];
    const result = impl.validate({ a: "x" });
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });

  it("forwards libraryOptions to the validator", async () => {
    let seen: unknown;
    const spy: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "spy",
        validate: (_value, options) => {
          seen = options?.libraryOptions;
          return { value: 1 };
        },
      },
    };
    await runValidation(spy, 1, { libraryOptions: { strict: true } });
    expect(seen).toEqual({ strict: true });
  });

  it("rejects a schema that does not implement the interface", async () => {
    await expect(runValidation({} as StandardSchemaV1, 1)).rejects.toThrow(
      /Standard Schema interface/,
    );
  });

  it("refuses an unknown Standard Schema version rather than guessing", async () => {
    // Honoring an interface we do not understand is what would make "bring any
    // Standard Schema validator" false.
    const future = {
      "~standard": {
        version: 2,
        vendor: "x",
        validate: () => ({ value: 1 }),
      },
    } as unknown as StandardSchemaV1;
    await expect(runValidation(future, 1)).rejects.toThrow(
      /Unsupported Standard Schema version 2/,
    );
  });

  it("treats a falsy `issues` as success, as the spec words it", async () => {
    // "A falsy value for `issues` indicates success."
    const odd: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "odd",
        validate: () => ({ value: 7, issues: null as unknown as undefined }),
      },
    };
    const r = await runValidation(odd, 1);
    expect(r.ok && r.value).toBe(7);
  });
});

describe("path rendering", () => {
  it("renders nested and indexed paths", async () => {
    const s = schema({
      profile: schema({ email: field.string() }),
      tags: array(field.string()),
    });
    expect(
      await paths(
        await runValidation(s, { profile: { email: 1 }, tags: ["ok", 2] }),
      ),
    ).toEqual(["profile.email", "tags[1]"]);
  });

  it("accepts the `{ key }` path-segment form the spec also allows", async () => {
    const s = {
      "~standard": {
        version: 1,
        vendor: "x",
        validate: () => ({
          issues: [{ message: "bad", path: [{ key: "a" }] }],
        }),
      },
    } as unknown as StandardSchemaV1;
    expect(await paths(await runValidation(s, 1))).toEqual(["a"]);
  });

  it("renders a key that is not a plain identifier", async () => {
    const s = schema({ "a-b": field.string() });
    expect(await paths(await runValidation(s, { "a-b": 1 }))).toEqual(["a-b"]);
  });
});

describe("hints", () => {
  it("attaches a field hint declared on a builder schema", async () => {
    const s = schema({ email: field.string({ hint: "use .optional()" }) });
    const list = await issues(await runValidation(s, { email: 1 }));
    expect(list?.[0].hint).toBe("use .optional()");
  });

  it("applies an element hint to an indexed path but not the container", async () => {
    // Otherwise `tags: expected an array` would carry "one tag per entry",
    // because `tags[1]` and `tags` both reduce to the same leaf.
    const s = schema({ tags: array(field.string({ hint: "one per entry" })) });
    const element = await issues(await runValidation(s, { tags: [1] }));
    expect(element?.[0]).toEqual({
      path: "tags[0]",
      message: "expected a string",
      hint: "one per entry",
    });
    const container = await issues(await runValidation(s, { tags: "nope" }));
    expect(container?.[0].hint).toBeUndefined();
  });

  it("accepts hints from the call site, for a foreign schema", async () => {
    const foreign: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "x",
        validate: () => ({ issues: [{ message: "bad", path: ["email"] }] }),
      },
    };
    const list = await issues(
      await runValidation(foreign, {}, { hints: { email: "check it" } }),
    );
    expect(list?.[0].hint).toBe("check it");
  });

  it("falls back to the leaf name for a nested path", async () => {
    const foreign: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "x",
        validate: () => ({ issues: [{ message: "bad", path: ["p", "e"] }] }),
      },
    };
    const list = await issues(
      await runValidation(foreign, {}, { hints: { e: "leaf hint" } }),
    );
    expect(list?.[0].hint).toBe("leaf hint");
  });

  it("requires an exact match for a top-level field", async () => {
    const foreign: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "x",
        validate: () => ({ issues: [{ message: "bad", path: ["email"] }] }),
      },
    };
    const list = await issues(
      await runValidation(foreign, {}, { hints: { mail: "wrong leaf" } }),
    );
    expect(list?.[0].hint).toBeUndefined();
  });

  it("applies a schema-level hint to the object as a whole", async () => {
    const s = schema({ a: field.string() }, { hint: "check the shape" });
    const list = await issues(await runValidation(s, 5));
    expect(list?.[0].hint).toBe("check the shape");
  });

  it("carries a function-wide hint on the error", async () => {
    const s = schema({ a: field.string() });
    const r = await runValidation(s, { a: 1 }, { hint: "see the docs" });
    expect(r.ok === false && r.error.hint).toBe("see the docs");
  });
});

describe("structural builder", () => {
  it("rejects unknown properties rather than passing them through", async () => {
    // A function that silently drops an unexpected field has an input contract
    // nobody can reason about.
    const list = await issues(
      await runValidation(schema({ a: field.string() }), {
        a: "x",
        b: 1,
      }),
    );
    expect(list).toEqual([{ path: "b", message: "unexpected property" }]);
  });

  it("optional accepts undefined but not null", async () => {
    const s = schema({ a: optional(field.string()) });
    expect((await runValidation(s, {})).ok).toBe(true);
    const list = await issues(await runValidation(s, { a: null }));
    expect(list?.[0].message).toBe("expected a string");
  });

  it("nullable accepts null but not undefined", async () => {
    const s = schema({ a: nullable(field.string()) });
    expect((await runValidation(s, { a: null })).ok).toBe(true);
    const list = await issues(await runValidation(s, {}));
    expect(list?.[0].message).toBe("expected a string");
  });

  it("array validates every element and reports the index", async () => {
    const s = schema({ xs: array(field.number()) });
    expect(await paths(await runValidation(s, { xs: [1, "a", 3] }))).toEqual([
      "xs[1]",
    ]);
    const list = await issues(await runValidation(s, { xs: 5 }));
    expect(list?.[0].message).toBe("expected an array");
  });

  it("record validates every value", async () => {
    const s = schema({ m: record(field.boolean()) });
    expect(await paths(await runValidation(s, { m: { ok: true, bad: 1 } })))
      .toEqual(["m.bad"]);
    const list = await issues(await runValidation(s, { m: [] }));
    expect(list?.[0].message).toBe("expected an object");
  });

  it("field.number rejects NaN and Infinity", async () => {
    const s = schema({ n: field.number() });
    expect(await issues(await runValidation(s, { n: Number.NaN }))).not
      .toBeNull();
    expect(
      await issues(await runValidation(s, { n: Number.POSITIVE_INFINITY })),
    ).not.toBeNull();
  });

  it("record accepts a matching value", async () => {
    const s = schema({ m: record(field.boolean()) });
    const r = await runValidation(s, { m: { ok: true } });
    expect(r.ok && r.value).toEqual({ m: { ok: true } });
  });

  it("carries hints through optional and nullable wrappers", async () => {
    // `withPrefix` rebuilds the hint maps, so an optional field with a hint has
    // to still be found after the wrapper.
    const s = schema({
      a: optional(field.string({ hint: "optional hint" })),
      b: nullable(field.string({ hint: "nullable hint" })),
    });
    const list = await issues(await runValidation(s, { a: 1, b: 2 }));
    expect(list?.map((i) => [i.path, i.hint])).toEqual([
      ["a", "optional hint"],
      ["b", "nullable hint"],
    ]);
    expect((await runValidation(s, { b: null })).ok).toBe(true);
    expect((await runValidation(s, { a: "x", b: null })).ok).toBe(true);
    // `nullable` accepts `null` but still requires the key, so omitting `b`
    // fails while omitting the optional `a` does not.
    expect((await runValidation(s, {})).ok).toBe(false);
  });

  it("quotes a nested key that is not a plain identifier", async () => {
    // A top-level odd key renders bare; a nested one has to be bracketed so the
    // path stays unambiguous.
    const s = schema({ outer: schema({ "a-b": field.string() }) });
    expect(
      await paths(await runValidation(s, { outer: { "a-b": 1 } })),
    ).toEqual(['outer["a-b"]']);
  });

  it("rebases hints through a wrapper around a nested schema and an array", async () => {
    // Exercises the `joinPath` and `elementHints` rebase paths that only a
    // wrapper around a *hinted child* can reach.
    const s = schema({
      wrapped: optional(schema({ a: field.string({ hint: "inner hint" }) })),
      list: optional(array(field.string({ hint: "element hint" }))),
    });
    const list = await issues(
      await runValidation(s, { wrapped: { a: 1 }, list: [2] }),
    );
    expect(list?.map((i) => [i.path, i.hint])).toEqual([
      ["wrapped.a", "inner hint"],
      ["list[0]", "element hint"],
    ]);
  });

  it("field.custom composes a foreign validator as a leaf", async () => {
    // The escape hatch that stops this being a second dialect.
    const inner: StandardSchemaV1<unknown, { n: number }> = {
      "~standard": {
        version: 1,
        vendor: "other",
        validate: (value) =>
          typeof (value as { n?: unknown })?.n === "number"
            ? { value: value as { n: number } }
            : { issues: [{ message: "n bad", path: ["n"] }] },
      },
    };
    const s = schema({ wrapped: field.custom(inner) });
    expect(await paths(await runValidation(s, { wrapped: { n: "x" } })))
      .toEqual(["wrapped.n"]);
    expect((await runValidation(s, { wrapped: { n: 1 } })).ok).toBe(true);
  });
});

describe("foreign validators at the edges of the builder", () => {
  /** A foreign schema whose issues carry no `path` at all. */
  const pathless = (
    message: string,
  ): StandardSchemaV1<unknown, string> => ({
    "~standard": {
      version: 1,
      vendor: "pathless-lib",
      validate: () => ({ issues: [{ message }] }),
    },
  });

  it("rebases a pathless issue through optional and nullable", async () => {
    // A foreign validator need not supply a path, so the rebase has to cope
    // with `undefined` rather than only an array.
    const s = schema({
      a: optional(pathless("bad a")),
      b: nullable(pathless("bad b")),
    });
    const list = await issues(await runValidation(s, { a: 1, b: 2 }));
    expect(list?.map((i) => [i.path, i.message])).toEqual([
      ["a", "bad a"],
      ["b", "bad b"],
    ]);
  });

  it("rebases a pathless issue through record", async () => {
    const s = schema({ m: record(pathless("bad value")) });
    const list = await issues(await runValidation(s, { m: { k: 1 } }));
    expect(list?.map((i) => [i.path, i.message])).toEqual([[
      "m.k",
      "bad value",
    ]]);
  });

  it("keeps a nested hint when a container wraps an object", async () => {
    // `array` splits the child's hints: the empty key becomes an *element* hint,
    // and a nested key like `a` stays a field hint because that path only
    // exists on an element.
    const s = schema({
      rows: array(schema({ a: field.string({ hint: "row hint" }) })),
      map: record(schema({ b: field.string({ hint: "map hint" }) })),
    });
    const list = await issues(
      await runValidation(s, { rows: [{ a: 1 }], map: { k: { b: 2 } } }),
    );
    expect(list?.map((i) => [i.path, i.hint])).toEqual([
      ["rows[0].a", "row hint"],
      ["map.k.b", "map hint"],
    ]);
  });

  it("accepts a hint on every leaf kind and on custom", async () => {
    const inner: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "n",
        validate: (value) =>
          typeof value === "number"
            ? { value }
            : { issues: [{ message: "no" }] },
      },
    };
    const s = schema({
      n: field.number({ hint: "number hint" }),
      b: field.boolean({ hint: "boolean hint" }),
      c: field.custom(inner, { hint: "custom hint" }),
    });
    const list = await issues(await runValidation(s, { n: "x", b: 1, c: "y" }));
    expect(list?.map((i) => [i.path, i.hint])).toEqual([
      ["n", "number hint"],
      ["b", "boolean hint"],
      ["c", "custom hint"],
    ]);
  });

  it("falls through cleanly for a nested field that declares no value hints", async () => {
    // `outer` has no value hints at all, so the per-field lookup finds no group
    // and must return without a hint rather than reaching into a sibling's.
    const s = schema({
      outer: schema({ a: field.string() }),
      m: record(field.string({ hint: "map hint" })),
    });
    const list = await issues(
      await runValidation(s, { outer: { a: 1 }, m: {} }),
    );
    expect(list).toEqual([{ path: "outer.a", message: "expected a string" }]);
  });

  it("returns no hint when a value group exists but matches no key", async () => {
    // `record(inner)` validates each *value*, so `m`'s value hints are keyed by
    // the inner field (`b`). The failing key here is `k`, so the lookup finds the
    // group and still finds nothing in it.
    const s = schema({ m: record(schema({ b: field.string({ hint: "b" }) })) });
    const list = await issues(await runValidation(s, { m: { k: 1 } }));
    expect(list).toEqual([{ path: "m.k", message: "expected an object" }]);
  });

  it("does not borrow a sibling field's value hint", async () => {
    const s = schema({
      m: record(field.string({ hint: "map hint" })),
      other: schema({ b: field.string() }),
    });
    const list = await issues(
      await runValidation(s, { m: {}, other: { b: 2 } }),
    );
    expect(list).toEqual([{ path: "other.b", message: "expected a string" }]);
  });

  it("does not resolve a hint for a path that is only an index", async () => {
    // A path of `["[0]"]` renders as `[0]`, which contains an index marker but
    // no leaf name, so there is nothing for the fallback to match.
    const odd: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "odd",
        validate: () => ({ issues: [{ message: "bad", path: ["[0]"] }] }),
      },
    };
    const list = await issues(
      await runValidation(odd, 1, { hints: { "": "should not match" } }),
    );
    expect(list?.[0]).toEqual({ path: "[0]", message: "bad" });
  });
});

describe("formatError with a validation failure", () => {
  const err = new ValidationError(
    [{ path: "email", message: "expected a string", hint: "use .optional()" }],
    "see the docs",
  );

  it("renders the issues, hints, and code in development", () => {
    expect(formatError(err, false)).toEqual({
      error: "Validation failed",
      code: "VALIDATION",
      data: {
        issues: [
          {
            path: "email",
            message: "expected a string",
            hint: "use .optional()",
          },
        ],
      },
      hint: "see the docs",
    });
  });

  it("leads with a function-wide hint and keeps rpc's documentation pointer", () => {
    // The adapters compose these: the caller's advice first, then the wiki link,
    // so a single function-wide `hint` does not cost the documentation pointer.
    const composed = "a and b are numbers — " +
      "input did not match the function's schema; see wiki/server-functions.md#input-validation";
    expect(
      formatError(
        new ValidationError([{ path: "b", message: "bad" }], composed),
        false,
      ),
    )
      .toMatchObject({ hint: composed });
  });

  it("omits the hint key entirely when the error has none", () => {
    // A caller can validate without a function-wide hint, so the body must not
    // carry a `hint: undefined` key.
    const bare = new ValidationError([{ path: "a", message: "bad" }]);
    expect(formatError(bare, false)).toEqual({
      error: "Validation failed",
      code: "VALIDATION",
      data: { issues: [{ path: "a", message: "bad" }] },
    });
  });

  it("keeps the paths and hints, and drops only the vendor message, in production", () => {
    // The production rule is drawn on authorship, not on environment alone: a
    // `path` names a field the caller itself supplied, and a `hint` is authored
    // in `ServerFunctionOptions`, so sending either was deliberate. A vendor
    // `message` is neither, and some libraries interpolate the failing value
    // into it (valibot: "Expected string but received 12345").
    expect(formatError(err, true)).toEqual({
      error: "Unprocessable Content",
      code: "VALIDATION",
      data: { issues: [{ path: "email", hint: "use .optional()" }] },
      hint: "see the docs",
    });
  });

  it("sends `error` from the status table in production, never the author message", () => {
    // Every other client error in the library sources its production body from
    // the fixed table. Validation does too, so `error` is a constant rather than
    // anything the author or a validator wrote.
    const body = formatError(err, true);
    expect(body.error).toBe(clientErrorMessage(422));
    expect(body.error).not.toBe("Validation failed");
  });

  it("omits the `message` key entirely in production, rather than sending undefined", () => {
    // A `message: undefined` would still be a key in the JSON and would break
    // `Object.keys`-based client checks.
    const body = formatError(err, true);
    expect(body.data).toEqual({
      issues: [{ path: "email", hint: "use .optional()" }],
    });
    expect(
      (body.data as { issues: object[] }).issues.every(
        (i) => !("message" in i),
      ),
    ).toBe(true);
  });

  it("sends a bare path when the issue has no hint either", () => {
    // The common case for an author who wrote no `hints`: the submitter still
    // learns which field failed, which is most of the value of the body.
    const bare = new ValidationError([{ path: "age", message: "bad" }]);
    expect(formatError(bare, true)).toEqual({
      error: "Unprocessable Content",
      code: "VALIDATION",
      data: { issues: [{ path: "age" }] },
    });
  });
});

/* ─── schema.from — the inference boundary ─────────────────────────────────
 * It is transparent, so most of what matters is a compile-time property. These
 * assert the runtime half, and the type half is exercised by the assertions
 * below compiling at all.
 */

describe("schema.from", () => {
  const vendor = {
    "~standard": {
      version: 1,
      vendor: "test-vendor",
      validate: () => ({ value: { a: 1 } }),
    },
  } satisfies StandardSchemaV1<unknown, { a: number }>;

  it("returns the very same object — it converts nothing", () => {
    expect(schema.from(vendor)).toBe(vendor);
  });

  it("is still a Standard Schema afterwards", async () => {
    const result = await runValidation(schema.from(vendor), "anything");
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("does not launder a non-conforming schema: the version pin still fires", async () => {
    // The reason this stays a transparent wrapper rather than a converting one.
    // `from` must not give a non-conforming object the appearance of conformance.
    const impostor = { "~standard": { version: 2, validate: () => ({}) } };
    await expect(
      runValidation(schema.from(impostor as never), 1),
    ).rejects.toThrow(/Unsupported Standard Schema version/);
  });

  it("rejects a schema with no ~standard at all", async () => {
    await expect(runValidation({} as never, 1)).rejects.toThrow(
      /~standard/,
    );
  });

  it("preserves the input and output types across the boundary", () => {
    // Compile-time: `schema.from` must not widen I/O to `unknown`, or every
    // caller that adopts it loses the whole point of declaring a schema.
    const narrow = schema.from(vendor);
    const out: InferOutput<typeof narrow> = { a: 1 };
    const inp: InferInput<typeof narrow> = "raw";
    expect(out.a).toBe(1);
    expect(inp).toBe("raw");
  });

  it("is optional — a plain schema works without it", async () => {
    const plain = schema({ a: field.number() });
    const result = await runValidation(plain, { a: 2 });
    expect(result).toMatchObject({ ok: true });
  });

  it("flows through createServerFunction's inference unchanged", () => {
    // The client stub's argument is the schema's Input; the handler parameter is
    // its Output. If `from` broke either, this would not compile.
    const S = schema.from(vendor);
    const fn = createServerFunction("f", async (_signal, input) => input.a, {
      schema: S,
    });
    expect(typeof fn).toBe("function");
  });
});

/**
 * One mock **per vendor**, shaped like that library's real output rather than six
 * copies of one stub. The suite below varies only the `vendor` string, which
 * proves rpc does not branch on it — but it cannot prove rpc survives the
 * differences that actually exist between the libraries.
 *
 * Those differences are known from `examples/advanced`, which runs the same
 * contract through all four, and are reproduced here so they are locked rather
 * than remembered:
 *
 * | vendor   | `validate` is | default message                        | echoes input |
 * | -------- | -------------- | ------------------------------------- | ------------ |
 * | valibot  | sync           | `Expected string but received 12345`   | **yes**      |
 * | zod      | sync           | `Invalid input: expected string, ...`  | no           |
 * | arktype  | sync           | `name must be a string (was a number)` | no           |
 * | effect   | **async**      | —                                      | no           |
 *
 * Effect is the one that matters most: its Standard Schema adapter returns a
 * Promise, and a runner reading the result synchronously would see
 * `issues === undefined`, conclude the input was valid, and hand the handler a
 * Promise. Every case below therefore asserts the **rejected** path as well as
 * the accepted one, because that is where a missing `await` shows up.
 */
/**
 * A validated payload is an object. An array is refused by name, because the
 * alternative reports a wiring mistake as a data error: a tuple schema is never
 * handed the tuple it describes, so it rejects with "expected array, received
 * number" and the author goes looking for a bad value instead of a bad signature.
 */
describe("array payloads are rejected", () => {
  const tupleish = {
    "~standard": {
      version: 1,
      vendor: "tuple-lib",
      validate: (value: unknown) => ({ value }),
    },
  } satisfies StandardSchemaV1<unknown, unknown>;

  it("refuses an array on the runner, naming the fix", async () => {
    const error = await runValidation(
      tupleish as StandardSchemaV1<unknown, unknown>,
      [1, 2],
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 400 });
    expect(String((error as Error).message)).toMatch(/single object argument/);
  });

  it("refuses an array on a direct call too", async () => {
    // Both call paths share the runner, so the guard cannot be side-stepped by
    // calling the function in-process instead of over HTTP.
    const fn = createServerFunction(
      "tupleish",
      async (_s: AbortSignal, _a: unknown) => "x",
      {
        schema: tupleish as never,
      },
    );
    const error = await fn([1, 2] as never).data.catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 400 });
    expect(String((error as Error).message)).toMatch(/single object argument/);
  });

  it("still accepts an object, and an empty object", async () => {
    const ok = await runValidation(
      tupleish as StandardSchemaV1<unknown, unknown>,
      { a: 1 },
    );
    expect(ok.ok).toBe(true);
    const empty = await runValidation(
      tupleish as StandardSchemaV1<unknown, unknown>,
      {},
    );
    expect(empty.ok).toBe(true);
  });

  it("does not confuse a nested array with an array payload", async () => {
    // The rule is about the *root*. An array-valued field is the supported way to
    // express a field array, so this must keep working.
    const arrayOfStrings: StandardSchemaV1<unknown, string[]> = {
      "~standard": {
        version: 1,
        vendor: "array-lib",
        validate: (value: unknown) =>
          Array.isArray(value) && value.every((v) => typeof v === "string")
            ? { value: value as string[] }
            : { issues: [{ message: "expected an array of strings" }] },
      },
    };
    const nested = schema({ items: field.custom(arrayOfStrings) });
    const r = await runValidation(nested, { items: ["a", "b"] });
    expect(r.ok).toBe(true);
    // …and it is the root that is refused, not the field.
    const bad = await runValidation(nested, { items: [1] });
    expect(bad.ok).toBe(false);
  });
});

describe("per-vendor output shapes", () => {
  type Issue = { message: string; path?: readonly PropertyKey[] };
  // The spec's `Result` is a discriminated union, not two optional fields: on
  // success `issues` is `undefined`, on failure it is a **non-empty** tuple and
  // `value` is absent. Writing it as one shape with two optionals would let a
  // mock return `{ value }` *and* `{ issues: [...] }`, which the spec forbids —
  // and modelling that wrongly is how a runner starts trusting a shape no real
  // library emits.
  // `value` is the schema's **Output**, not `unknown` — the spec types it
  // `readonly value: Output`, and `satisfies` below is what proves these mocks
  // are spec-shaped rather than merely accepted.
  type Result =
    | { value: string; issues?: undefined }
    | { value?: undefined; issues: [Issue, ...Issue[]] };
  const accepts = (value: string): Result => ({ value });
  const rejects = (message: string): Result => ({ issues: [{ message }] });

  /** valibot interpolates the rejected value into its default message. */
  const valibot = {
    "~standard": {
      version: 1,
      vendor: "valibot",
      validate: (value: unknown): Result =>
        typeof value === "string" ? accepts(value) : rejects(
          `Invalid type: Expected string but received ${JSON.stringify(value)}`,
        ),
    },
  } satisfies StandardSchemaV1<unknown, string>;

  /** zod names the expected and received *types*, never the value. */
  const zod = {
    "~standard": {
      version: 1,
      vendor: "zod",
      validate: (value: unknown): Result =>
        typeof value === "string" ? accepts(value) : rejects(
          "Invalid input: expected string, received number",
        ),
    },
  } satisfies StandardSchemaV1<unknown, string>;

  /** arktype names the field and both types. */
  const arktype = {
    "~standard": {
      version: 1,
      vendor: "arktype",
      validate: (value: unknown): Result =>
        typeof value === "string" ? accepts(value) : rejects(
          "name must be a string (was a number)",
        ),
    },
  } satisfies StandardSchemaV1<unknown, string>;

  /**
   * Effect's adapter is async — the regression guard for the `await` in
   * `runValidation`.
   */
  const effect = {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: async (value: unknown): Promise<Result> =>
        typeof value === "string" ? accepts(value) : rejects("Expected string"),
    },
  } satisfies StandardSchemaV1<unknown, string>;

  const shapes = [
    ["valibot", valibot],
    ["zod", zod],
    ["arktype", arktype],
    ["effect", effect],
  ] as const;

  for (const [name, shape] of shapes) {
    it(`rejects a bad value through the "${name}" shape`, async () => {
      const bad = await runValidation(
        shape as StandardSchemaV1<unknown, string>,
        12345,
      );
      expect(bad.ok).toBe(false);
      // The library's own wording survives into `issues`, whatever it is.
      expect(bad.ok === false && (bad.error.issues[0]?.message ?? "").length)
        .toBeGreaterThan(0);
    });

    it(`accepts a good value through the "${name}" shape`, async () => {
      const good = await runValidation(
        shape as StandardSchemaV1<unknown, string>,
        "ok",
      );
      expect(good.ok && good.value).toBe("ok");
    });
  }

  it("gives every vendor the same production body, echo included", async () => {
    // The vendor's own wording differs — that is the whole reason production
    // withholds `message`. The *production* body must be byte-identical across
    // all four, or a client could fingerprint which validator an author picked,
    // and the echoing vendor's interpolation would reach the wire.
    const prod = await Promise.all(
      shapes.map(async ([, shape]) => {
        const r = await runValidation(
          shape as StandardSchemaV1<unknown, string>,
          12345,
        );
        return r.ok === false
          ? validationErrorBody(r.error, { includeMessages: false })
          : null;
      }),
    );
    const [first] = prod;
    expect(first).not.toBeNull();
    for (const b of prod) expect(b).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("12345");
  });

  it("still surfaces the library's message in development", async () => {
    // The development body keeps it, which is the point of the split: the vendor
    // text is the useful thing while you are writing the schema, and the unsafe
    // thing once real input can reach it.
    const dev = await Promise.all(
      shapes.map(async ([, shape]) => {
        const r = await runValidation(
          shape as StandardSchemaV1<unknown, string>,
          12345,
        );
        return r.ok === false ? validationErrorBody(r.error) : null;
      }),
    );
    const messages = dev.map((b) => JSON.stringify(b));
    // At least two distinct wordings — otherwise the mocks model nothing and the
    // equality asserted above would prove nothing either.
    expect(new Set(messages).size).toBeGreaterThan(1);
    // valibot's echo is here in dev, and is what must not be in production.
    expect(messages[0]).toContain("12345");
  });
});

describe("vendor-agnostic validation", () => {
  /**
   * The `schema` option accepts any Standard Schema v1, and `examples/advanced`
   * relies on that: the same contract written in valibot, zod, arktype and
   * effect is sent through four registered functions and the page compares what
   * comes back.
   *
   * The four libraries are not root devDependencies, and a test importing them
   * would mostly assert their behaviour rather than rpc's. So the property worth
   * locking is the one rpc actually owns: **it branches on nothing.** Every
   * schema below declares a different `vendor` — the four real ones, two
   * plausible future ones, and one that does not exist — and must produce
   * identical results, on both call paths.
   *
   * A future `if (vendor === "zod")` in the dispatch would fail this.
   */
  const vendors = [
    "valibot",
    "zod",
    "arktype",
    "effect",
    "some-future-library",
    "not a real vendor at all",
  ];

  const makeSchema = (vendor: string): StandardSchemaV1<unknown, number> => ({
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => {
        const n = typeof value === "string" ? Number(value) : value;
        if (typeof n !== "number" || Number.isNaN(n)) {
          return { issues: [{ message: "expected a number", path: ["age"] }] };
        }
        if (n < 0) {
          return { issues: [{ message: "too small", path: ["age"] }] };
        }
        return { value: n };
      },
    },
  });

  for (const vendor of vendors) {
    it(`behaves identically for vendor "${vendor}" on both call paths`, async () => {
      const fn = createServerFunction(
        `coerce-${vendor}`,
        // Explicitly hostile types on purpose: the schema is `as never`, so
        // inference is defeated and the test isolates runtime behaviour —
        // identical validation on both call paths — from whatever the types
        // happen to say. An annotated `never` input keeps it compiling.
        async (_s: AbortSignal, _age: never) => _age,
        {
          schema: makeSchema(vendor) as never,
          hint: "send a number",
        },
      );

      // Direct call: accepted input, coerced to the schema's Output.
      expect(await fn("42" as never).data).toBe(42);
      // `path` is rendered to a dotted string (`address.city`, `tags[0]`)
      // rather than left as the spec's `PropertyKey[]`, which is what lets one
      // body drive `fieldErrors` regardless of the library that produced it.
      // The *schema* above still returns the array — that is the spec's shape,
      // and rpc is the thing normalising it.

      // Rejected input is the same failure whatever the vendor claims to be,
      // and it never reaches the handler. The `ValidationError` message is the
      // generic "Validation failed" — the library's own text is in `issues`, so
      // that is what has to be asserted here.
      const nanIssue = await fn("nope" as never).data.catch((e: unknown) => e);
      expect(nanIssue).toBeInstanceOf(ValidationError);
      expect((nanIssue as InstanceType<typeof ValidationError>).issues).toEqual(
        [
          { message: "expected a number", path: "age" },
        ],
      );

      const smallIssue = await fn(-1 as never).data.catch((e: unknown) => e);
      expect((smallIssue as InstanceType<typeof ValidationError>).issues)
        .toEqual([
          { message: "too small", path: "age" },
        ]);
    });
  }

  it("reports the vendor it was handed, and nothing else, on the failure body", async () => {
    // `describeOriginRequest`-style vendor strings reach the client nowhere:
    // a 400 body carries the message and the path, never the vendor, so the
    // error surface cannot be used to fingerprint which library a project uses.
    const fn = createServerFunction(
      "vendor-leak",
      async (_s: AbortSignal, _age: never) => _age,
      {
        schema: makeSchema("arktype") as never,
      },
    );
    try {
      await fn("nope" as never).data;
      expect.unreachable("should have rejected");
    } catch (err) {
      const body = formatError(err, false);
      expect(JSON.stringify(body)).not.toContain("arktype");
      expect(body.data).toMatchObject({
        issues: [{ message: "expected a number", path: "age" }],
      });
    }
  });
});

describe("production disclosure cannot reflect the submitted value", () => {
  /**
   * The reason the production body drops the vendor `message`.
   *
   * Some validator libraries interpolate the value that failed into their
   * default message. Measured through `~standard.validate` — the exact path rpc
   * uses — with `name: 12345`:
   *
   *   valibot   "Invalid type: Expected string but received 12345"   echoes it
   *   zod       "Invalid input: expected string, received number"     type only
   *   arktype   "name must be a string (was a number)"                type only
   *
   * So whether a message is safe to send depends on which library the author
   * picked, which cannot be reasoned about portably and therefore has to be
   * structural rather than a rule each author remembers.
   *
   * The echo below is shaped like valibot's, because that is the case that
   * motivates the rule. The point is not the message wording — it is that the
   * production body must not contain it, or anything derived from the input.
   */
  const echoingSchema = {
    "~standard": {
      version: 1,
      vendor: "echoing-vendor",
      validate: (value: unknown) => {
        const v = value as { password?: unknown };
        if (typeof v?.password !== "string") {
          return {
            issues: [{
              // The hazard: the submitted value, reflected back.
              message: `expected a string but received ${
                JSON.stringify(v?.password)
              }`,
              path: ["password"],
            }],
          };
        }
        return { value: v as { password: string } };
      },
    },
  } satisfies StandardSchemaV1<{ password: string }, { password: string }>;

  it("leaks neither the value nor the vendor text in production", async () => {
    // A type failure is what produces an echo, and this is the measured case
    // verbatim: valibot answers `"Expected string but received 12345"` for a
    // failed `name: 12345`. The submitted value is a secret-shaped string nested
    // in the failing field, so an echo would carry it verbatim.
    const submitted = "hunter2-stolen-password";
    const r = await runValidation(echoingSchema, {
      password: { raw: submitted },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;

    // Development is where the vendor text belongs, and it is expected to echo.
    const dev = JSON.stringify(formatError(r.error, false));
    expect(dev).toContain(submitted);

    // Production must contain neither the reflected value nor the vendor text.
    const prod = JSON.stringify(formatError(r.error, true));
    expect(prod).not.toContain(submitted);
    expect(prod).not.toContain("expected a string but received");
    // …while still saying which field to look at.
    expect(prod).toContain("password");
  });

  it("keeps an author-written hint in production, since that is the safe text", async () => {
    const r = await runValidation(echoingSchema, { password: 12345 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const withHint = new ValidationError(
      r.error.issues,
      "passwords are strings",
    );
    const prod = JSON.stringify(formatError(withHint, true));
    expect(prod).toContain("passwords are strings");
    expect(prod).not.toContain("12345");
  });
});

describe("validationErrorBody", () => {
  const err = new ValidationError(
    [{ path: "email", message: "vendor text", hint: "author text" }],
    "function-wide",
  );

  it("defaults to the development body when called with no options", () => {
    // The default is the fuller shape on purpose: a caller that does not pass
    // the option gets `message`, so the flag has to be set deliberately rather
    // than being the thing that happens to be falsy.
    expect(validationErrorBody(err)).toEqual({
      error: "Validation failed",
      code: "VALIDATION",
      data: {
        issues: [{
          path: "email",
          message: "vendor text",
          hint: "author text",
        }],
      },
      hint: "function-wide",
    });
  });

  it("is the same call `formatError` makes, so the two cannot drift", () => {
    expect(validationErrorBody(err, { includeMessages: false })).toEqual(
      formatError(err, true),
    );
  });
});
