/** @module Input validation: a structural schema builder that produces [Standard Schema](https://standardschema.dev) validators, plus the runner that turns their issues into a typed, teaching error. Never import this module in client code — it is server-only. */
import type {
  InferInput,
  InferOutput,
  InferShape,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  ValidationIssue,
} from "./types.d.ts";
import { VENDOR } from "./constants.ts";
import { httpError, ValidationError } from "./server-helpers.ts";

export type {
  InferInput,
  InferOutput,
  InferShape,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  ValidationIssue,
};
export { ValidationError };

/** Options accepted by every builder entry point. */
export interface BuildOptions {
  /** A teaching hint for this field or schema. Dev-only in the response. */
  readonly hint?: string;
}

/**
 * A schema this module built, which may additionally carry the hints attached to
 * its own fields.
 *
 * The hints live *beside* `~standard` rather than inside it, so a builder schema
 * stays a valid Standard Schema and a foreign schema (zod, valibot) remains
 * interchangeable with one. A foreign schema has no `hints`, which is why hints
 * can also be supplied at the call site.
 */
export type HintedSchema<S> = S & {
  /** Per-path teaching hints, keyed by the rendered path (`"a.b[0].c"`). */
  hints?: Record<string, string>;
};

/**
 * A schema built by this module, carrying its own hints and output type.
 *
 * Parameterised on `Output` deliberately: a builder that erased it to `unknown`
 * would make `schema({ a: field.number() })` infer `{ a: unknown }`, and the
 * whole point of the type flowing into the handler is lost.
 */
export type BuilderSchema<Output> = StandardSchemaV1<unknown, Output> & {
  hints?: Record<string, string>;
  /**
   * Hints about this schema's **value**, keyed by a path relative to that value.
   *
   * Kept separate from `hints` so a value hint can never be applied to the
   * container's own issue: without the split, `tags: expected an array` would
   * carry "one tag per entry".
   *
   * Relative rather than absolute because a container's keys are not knowable
   * at declaration time — a record produces `map.k.b` and an array
   * `tags[1]`, so a hint written for the value's `b` cannot be stored at an
   * absolute path. Lookup strips the field's own key and matches the remainder.
   */
  valueHints?: Record<string, string>;
  /**
   * Only on the root schema `schema()` returns: `valueHints` for every field,
   * grouped by that field's key. Kept separate from `valueHints` because the
   * two have different shapes — one is relative to a single value, the other
   * maps a field name to such a map.
   */
  valueHintsByField?: Record<string, Record<string, string>>;
  /** Identifies builder schemas, for nesting and debugging. */
  kind?: string;
};

/** A builder schema of unknown output. */
export type AnySchema = BuilderSchema<unknown>;

/** Renders a Standard Schema path as a readable dotted/indexed string. */
const renderPath = (path: StandardSchemaIssue["path"]): string => {
  if (!path || path.length === 0) return "";
  let out = "";
  for (const segment of path) {
    // The spec allows a bare key or a `{ key }` wrapper; both occur in the wild.
    const key = typeof segment === "object" && segment !== null &&
        "key" in segment
      ? segment.key
      : segment as PropertyKey;
    if (typeof key === "number") {
      out += `[${key}]`;
      continue;
    }
    const str = String(key);
    if (out === "") {
      out += str;
    } else if (/^[A-Za-z_$][\w$]*$/.test(str)) {
      out += `.${str}`;
    } else {
      out += `[${JSON.stringify(str)}]`;
    }
  }
  return out;
};

/** Joins a base path with a relative one, respecting array-index syntax. */
const joinPath = (base: string, child: string): string => {
  if (child === "") return base;
  if (base === "") return child;
  // The `[` case would be needed for an index-leading child key. Builder hints
  // are index-agnostic by design (see `array`), so nothing produces one — kept
  // so a hand-supplied `hints` map with an index key still renders correctly.
  // istanbul ignore next
  return child.startsWith("[") ? `${base}${child}` : `${base}.${child}`;
};

/** Prefixes every issue path of `inner` with `prefix`, and rebases its hints. */
const withPrefix = <T>(
  inner: StandardSchemaV1<unknown, T>,
  prefix: string,
  kind: string,
  /**
   * The schema whose hints should be rebased, when it differs from `inner`.
   *
   * `optional` and `nullable` wrap their child in a *new* object to add the
   * nullish check, and that wrapper carries no hints of its own — so reading
   * hints off `inner` would silently drop the child's, and
   * `optional(field.string({ hint }))` would lose the hint.
   */
  hintSource: StandardSchemaV1<unknown, T>,
): BuilderSchema<T> => {
  const child = hintSource as AnySchema;
  const hints: Record<string, string> = {};
  for (const [key, hint] of Object.entries(child.hints ?? {})) {
    hints[joinPath(prefix, key)] = hint;
  }
  const valueHints: Record<string, string> = { ...(child.valueHints ?? {}) };

  return {
    kind,
    hints,
    ...(Object.keys(valueHints).length > 0 ? { valueHints } : {}),
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown) =>
        mapResults(
          [inner["~standard"].validate(value)],
          ([result]) => {
            if (!result.issues) return { value: result.value };
            return {
              issues: result.issues.map((issue) => ({
                ...issue,
                path: [prefix, ...(issue.path ?? [])].filter((p) => p !== ""),
              })),
            };
          },
        ),
    },
  } as BuilderSchema<T>;
};

/**
 * A value that may or may not be a Promise.
 *
 * The spec lets `validate` return either, so every composition point in this
 * module has to cope. `mapResults` keeps the common case synchronous — a purely
 * synchronous schema still returns a plain result, not a Promise — while an async
 * child correctly makes the whole composition async.
 */
type MaybePromise<T> = T | Promise<T>;

const isThenable = <T>(value: MaybePromise<T>): value is Promise<T> =>
  typeof (value as { then?: unknown })?.then === "function";

/** Maps settled results, staying synchronous when none of them is a Promise. */
const mapResults = <A, B>(
  results: readonly MaybePromise<A>[],
  fn: (values: readonly A[]) => B,
): MaybePromise<B> =>
  results.some(isThenable) ? Promise.all(results).then(fn) : fn(results as A[]);

const fail = (
  message: string,
  path: unknown[] = [],
): StandardSchemaResult<never> => ({
  issues: [{ message, path: path as StandardSchemaIssue["path"] }],
});

/** The leaf validators: primitive checks, or a validator you supply. */
export interface FieldHelpers {
  /** Requires a `string`. */
  string(opts?: BuildOptions): BuilderSchema<string>;
  /** Requires a finite `number`; `NaN` and `Infinity` are rejected. */
  number(opts?: BuildOptions): BuilderSchema<number>;
  /** Requires a `boolean`. */
  boolean(opts?: BuildOptions): BuilderSchema<boolean>;
  /**
   * Wraps any Standard Schema as a leaf.
   *
   * This is what stops the builder becoming a second dialect: a leaf can be a
   * zod schema, a valibot schema, or a predicate, and it composes inside our
   * structure unchanged. Its own issue paths are rebased like any other child.
   */
  custom<Output>(
    inner: StandardSchemaV1<unknown, Output>,
    opts?: BuildOptions,
  ): AnySchema;
}

/** A leaf validator: one of the primitive checks, or a validator you supply. */
export const field: FieldHelpers = {
  string(opts: BuildOptions = {}): BuilderSchema<string> {
    return {
      kind: "string",
      hints: opts.hint ? { "": opts.hint } : undefined,
      "~standard": {
        version: 1,
        vendor: VENDOR,
        validate: (value) =>
          typeof value === "string" ? { value } : fail("expected a string"),
      },
    } as BuilderSchema<string>;
  },

  number(opts: BuildOptions = {}): BuilderSchema<number> {
    return {
      kind: "number",
      hints: opts.hint ? { "": opts.hint } : undefined,
      "~standard": {
        version: 1,
        vendor: VENDOR,
        validate: (value) =>
          typeof value === "number" && Number.isFinite(value)
            ? { value }
            : fail("expected a number"),
      },
    } as BuilderSchema<number>;
  },

  boolean(opts: BuildOptions = {}): BuilderSchema<boolean> {
    return {
      kind: "boolean",
      hints: opts.hint ? { "": opts.hint } : undefined,
      "~standard": {
        version: 1,
        vendor: VENDOR,
        validate: (value) =>
          typeof value === "boolean" ? { value } : fail("expected a boolean"),
      },
    } as BuilderSchema<boolean>;
  },

  custom<Output>(
    inner: StandardSchemaV1<unknown, Output>,
    opts: BuildOptions = {},
  ): BuilderSchema<Output> {
    const source = inner as AnySchema;
    const hints: Record<string, string> = { ...(source.hints ?? {}) };
    if (opts.hint) hints[""] = opts.hint;
    return {
      kind: "custom",
      hints,
      "~standard": source["~standard"],
    } as BuilderSchema<Output>;
  },
};

/** Allows `undefined`; `null` is still rejected. */
export const optional = <T>(
  inner: StandardSchemaV1<unknown, T>,
): BuilderSchema<T | undefined> =>
  withPrefix(
    {
      "~standard": {
        version: 1,
        vendor: VENDOR,
        validate: (value: unknown) =>
          value === undefined
            ? { value: undefined }
            : inner["~standard"].validate(value),
      },
    } as StandardSchemaV1<unknown, T | undefined>,
    "",
    "optional",
    inner,
  );

/** Allows `null`; `undefined` is still rejected. */
export const nullable = <T>(
  inner: StandardSchemaV1<unknown, T>,
): BuilderSchema<T | null> =>
  withPrefix(
    {
      "~standard": {
        version: 1,
        vendor: VENDOR,
        validate: (value: unknown) =>
          value === null ? { value: null } : inner["~standard"].validate(value),
      },
    } as StandardSchemaV1<unknown, T | null>,
    "",
    "nullable",
    inner,
  );

/**
 * An array whose every element matches `inner`.
 *
 * Element hints are kept index-agnostic: a hint written for the inner field
 * applies to every element, and the lookup strips `[n]` before matching, so
 * `array(field.string({ hint }))` teaches the right thing for `tags[7]`.
 */
export const array = <T>(
  inner: StandardSchemaV1<unknown, T>,
): BuilderSchema<T[]> => ({
  kind: "array",
  // The inner's *own* hint describes an element, so it moves to `elementHints`.
  // Its nested hints (e.g. `{"a.b": ...}`) stay field hints, because those paths
  // only exist on an element.
  hints: undefined,
  valueHints: {
    ...(inner as AnySchema).valueHints,
    ...(inner as AnySchema).hints,
  },
  "~standard": {
    version: 1,
    vendor: VENDOR,
    validate: (value: unknown) => {
      if (!Array.isArray(value)) return fail("expected an array");
      return mapResults(
        value.map((item) => inner["~standard"].validate(item)),
        (results) => {
          const out: T[] = [];
          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.issues) {
              return {
                issues: result.issues.map((issue) => ({
                  ...issue,
                  path: [i, ...(issue.path ?? [])],
                })),
              };
            }
            out.push(result.value);
          }
          return { value: out };
        },
      );
    },
  },
} as BuilderSchema<T[]>);

/** An object with arbitrary keys whose values all match `inner`. */
export const record = <T>(
  inner: StandardSchemaV1<unknown, T>,
): BuilderSchema<Record<string, T>> => {
  const child = inner as AnySchema;
  return {
    kind: "record",
    hints: undefined,
    valueHints: { ...child.valueHints, ...child.hints },
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown) => {
        if (
          typeof value !== "object" || value === null || Array.isArray(value)
        ) {
          return fail("expected an object");
        }
        const entries = Object.entries(value);
        return mapResults(
          entries.map(([, raw]) => inner["~standard"].validate(raw)),
          (results) => {
            const out: Record<string, T> = {};
            for (let i = 0; i < entries.length; i++) {
              const [key] = entries[i];
              const result = results[i];
              if (result.issues) {
                return {
                  issues: result.issues.map((issue) => ({
                    ...issue,
                    path: [key, ...(issue.path ?? [])],
                  })),
                };
              }
              out[key] = result.value;
            }
            return { value: out };
          },
        );
      },
    },
  } as BuilderSchema<Record<string, T>>;
};

/**
 * An object built from named fields. This is the primary entry point.
 *
 * Unknown keys are **rejected** rather than passed through. A server function
 * that silently drops an unexpected field is a server function whose input
 * contract nobody can reason about — the same reason a typed object literal
 * complains about an excess property.
 * @param shape - The field map
 * @param opts - Schema-wide options
 * @returns A Standard Schema whose output type is the inferred shape
 */
const buildSchema = <
  S extends Record<string, StandardSchemaV1<unknown, unknown>>,
>(
  shape: S,
  opts: BuildOptions = {},
): HintedSchema<StandardSchemaV1<unknown, InferShape<S>>> => {
  const keys = Object.keys(shape);
  const hints: Record<string, string> = {};
  const valueHints: Record<string, Record<string, string>> = {};

  for (const key of keys) {
    const child = shape[key] as AnySchema;
    for (const [path, hint] of Object.entries(child.hints ?? {})) {
      hints[joinPath(key, path)] = hint;
    }
    // Grouped by field, because a container's keys are unknown at declaration
    // time and the lookup needs to know which field a path belongs to.
    const childValues = { ...(child.valueHints ?? {}), ...(child.hints ?? {}) };
    if (Object.keys(childValues).length > 0) valueHints[key] = childValues;
  }
  if (opts.hint) hints[""] = opts.hint;

  return {
    hints,
    ...(Object.keys(valueHints).length > 0
      ? { valueHintsByField: valueHints }
      : {}),
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown) => {
        if (
          typeof value !== "object" || value === null || Array.isArray(value)
        ) {
          return fail("expected an object");
        }
        const input = value as Record<string, unknown>;
        const unexpected = Object.keys(input).filter((k) => !keys.includes(k));
        if (unexpected.length > 0) {
          return {
            issues: unexpected.map((key) => ({
              message: "unexpected property",
              path: [key],
            })),
          };
        }
        return mapResults(
          keys.map((key) => shape[key]["~standard"].validate(input[key])),
          (results) => {
            const out: Record<string, unknown> = {};
            const issues: StandardSchemaIssue[] = [];
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i];
              const result = results[i];
              if (result.issues) {
                for (const issue of result.issues) {
                  issues.push({ ...issue, path: [key, ...(issue.path ?? [])] });
                }
                continue;
              }
              out[key] = result.value;
            }
            if (issues.length > 0) return { issues };
            return { value: out as InferShape<S> };
          },
        );
      },
    },
  } as HintedSchema<StandardSchemaV1<unknown, InferShape<S>>>;
};

/**
 * Normalises a vendor schema into an inference boundary, for use with
 * `createServerFunction`.
 *
 * **It validates nothing and converts nothing** — the same object comes back,
 * and every decision about what counts as valid still belongs to the library.
 * What it changes is where TypeScript does the work.
 *
 * `createServerFunction` infers a handler's parameter and a client stub's
 * argument with `InferOutput<TSchema>` / `InferInput<TSchema>`, which are
 * *structural* matches against the schema's own type. For a heavy vendor type
 * that graph can exceed the instantiation budget an older compiler allows, and
 * the call fails with TS2589 — "Type instantiation is excessively deep and
 * possibly infinite" — on code that is perfectly correct and that a newer
 * compiler accepts. Measured with arktype's `.narrow()`, whose morph-bearing
 * `Type` is the worst case found:
 *
 * ```ts
 * const s = schema.from(type("string <= 64").narrow(nonEmpty));
 * createServerFunction("f", handler, { schema: s }); // TS 5.9: clean
 * createServerFunction("f", handler, { schema: narrow }); // TS 5.9: TS2589
 * ```
 *
 * The budget is per inference site, so this splits one expensive inference into
 * two cheap ones: the deep match happens here, and `createServerFunction` only
 * ever sees the small `StandardSchemaV1<I, O>`. It is also why doing the same
 * narrowing *inside* `createServerFunction` cannot help — that inference happens
 * at the call site, before the body runs.
 *
 * It is a boundary, not a guarantee: a pathological type could still exhaust
 * the budget *here*. For that case annotate explicitly instead —
 * `const s: StandardSchemaV1<string, string> = narrow` — which costs nothing at
 * runtime and pins the types.
 *
 * Use it for any vendor schema; you do not need it for rpc's own builder, whose
 * types are already small.
 * @param vendor - Any Standard Schema — zod, valibot, arktype, effect, or ours
 * @returns The same object, typed as the plain spec interface
 */
const from = <I, O>(vendor: StandardSchemaV1<I, O>): StandardSchemaV1<I, O> =>
  vendor;

/**
 * Build a schema from rpc's own primitives, or normalise a vendor one with
 * `schema.from(...)`.
 *
 * ```ts
 * // no dependency
 * schema({ email: field.string(), name: optional(field.string()) })
 *
 * // any Standard Schema, across an inference boundary
 * schema.from(z.object({ email: z.string() }))
 * ```
 * @param shape - The field map
 * @param opts - Schema-wide options
 * @returns A Standard Schema whose output type is the inferred shape
 */
export const schema:
  & (<
    S extends Record<string, StandardSchemaV1<unknown, unknown>>,
  >(
    shape: S,
    opts?: BuildOptions,
  ) => HintedSchema<StandardSchemaV1<unknown, InferShape<S>>>)
  & {
    /**
     * Normalise a vendor schema across an inference boundary. See the
     * documentation on this function — it is transparent, and exists purely so
     * TypeScript does not have to walk a heavy vendor type at the
     * `createServerFunction` call.
     */
    from: typeof from;
  } = Object.assign(buildSchema, { from });

/** Options for {@link runValidation}. */
export interface RunValidationOptions {
  /** Per-path hints, merged over any the schema itself carries. */
  hints?: Record<string, string>;
  /** Vendor-specific parameters forwarded to the validator's `validate`. */
  libraryOptions?: Record<string, unknown>;
  /**
   * Hints about a field's *value*, grouped by that field's key and keyed
   * relative to the value. Supplied here for validators from other libraries,
   * which cannot carry hints on the schema itself.
   */
  valueHints?: Record<string, Record<string, string>>;
  /** A function-wide hint appended to the error. */
  hint?: string;
}

/**
 * Runs a Standard Schema and converts the result into either a validated value
 * or a {@link ValidationError} to throw.
 *
 * Hints resolve per issue path: an exact match first, then the path's leaf name.
 * That ordering lets a single `hints: { email: "..." }` cover both a top-level
 * `email` and a nested `profile.email`, and lets a hint written for a field inside
 * an array apply to every index.
 * @param schema - The schema to validate against
 * @param value - The untrusted input
 * @param options - Per-path hints and a function-wide hint
 * @returns The validated value, or a `ValidationError` to throw
 */
export const runValidation = async <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: unknown,
  options: RunValidationOptions = {},
): Promise<
  { ok: true; value: Output } | { ok: false; error: ValidationError }
> => {
  // **A validated payload must be an object, not an array.** `schema` validates
  // `args[0]` and nothing else, so a tuple-root schema is never given the tuple
  // it describes: `add(1, 2)` hands the tuple schema the number `1`, and it
  // rejects with "expected array, received number" — a wiring mistake reported
  // as a data error, which is the worst way to find out. Rejecting the array here
  // names the real problem, in one place both call paths share, and cannot be
  // bypassed by registering the function through a different route.
  //
  // This forecloses `schema: z.array(...)` as the *root*, deliberately. A form is
  // one object, and validation errors have to map to named inputs for
  // `fieldErrors`, the no-JS flash, and a client resolver to work at all — none of
  // which a position in an array can label. Wrap it if you need one:
  // `schema({ items: field.custom(z.array(Item)) })`.
  if (Array.isArray(value)) {
    throw httpError(
      400,
      "rpc: `schema` validates a single object argument, so an array payload is " +
        "not supported. Send one object — `fn({ a: 1, b: 2 })` — and describe " +
        "any nested array with `field.custom(z.array(...))`.",
    );
  }

  const impl = schema?.["~standard"];
  if (!impl || typeof impl.validate !== "function") {
    throw new TypeError(
      "schema must implement the Standard Schema interface (~standard.validate)",
    );
  }
  // Version-pin rather than guess. Honouring an interface we do not understand
  // is precisely what would make "bring any Standard Schema validator" false.
  if (impl.version !== 1) {
    throw new TypeError(
      `Unsupported Standard Schema version ${String(impl.version)}; expected 1`,
    );
  }

  // The spec permits a Promise here and rpc **must** await it. Treating the
  // result synchronously reads `undefined` for `issues` on a Promise object,
  // concludes the input was valid, and hands the handler the Promise — silently
  // skipping validation for every async validator.
  const result = await impl.validate(
    value,
    options.libraryOptions !== undefined
      ? { libraryOptions: options.libraryOptions }
      : undefined,
  );
  // The spec calls `issues` falsy the success signal, so test falsiness rather
  // than strict undefined.
  if (!result.issues) return { ok: true, value: result.value };

  const schemaHints = (schema as AnySchema).hints;
  const lookup = (path: string): string | undefined => {
    const direct = options.hints?.[path] ?? schemaHints?.[path];
    if (direct) return direct;
    // A top-level field must match exactly. Without this guard a value hint
    // leaks onto its container: `tags: expected an array` would carry "one tag
    // per entry", because `tags[1]` and `tags` reduce to the same leaf.
    if (!path.includes(".") && !path.includes("[")) return undefined;

    // Suffixes of the index-stripped path, longest first, so a hint written for
    // the exact shape wins over a broader one and one hint still covers a leaf
    // at any depth: `rows[0].a` -> ["rows.a", "a"].
    const parts = path
      .split(".")
      .map((part) => part.replace(/\[\d+\]/g, ""))
      .filter((part) => part !== "");
    const candidates: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      candidates.push(parts.slice(i).join("."));
    }

    for (const candidate of candidates) {
      const hit = options.hints?.[candidate] ?? schemaHints?.[candidate];
      if (hit) return hit;
    }

    // Value hints are grouped per field, and matched against the path *after*
    // that field's own key — because a container's keys are not knowable ahead
    // of time. `map.k.b` looks up the `map` group, then the tail `k.b`, whose
    // suffixes `["k.b", "b", ""]` include the `""` that names the value itself.
    const schemaValues = (schema as AnySchema).valueHintsByField;
    if (!schemaValues) return undefined;
    const field = parts[0];
    const group: Record<string, string> | undefined =
      options.valueHints?.[field] ??
        schemaValues[field];
    if (!group) return undefined;
    const tail = parts.slice(1);
    const tailCandidates: string[] = [""];
    for (let i = 0; i < tail.length; i++) {
      tailCandidates.push(tail.slice(i).join("."));
    }
    for (const candidate of tailCandidates) {
      const hit = group[candidate];
      if (hit) return hit;
    }
    return undefined;
  };

  const issues: ValidationIssue[] = result.issues.map((issue) => {
    const path = renderPath(issue.path);
    const hint = lookup(path);
    return hint
      ? { path, message: issue.message, hint }
      : { path, message: issue.message };
  });

  return { ok: false, error: new ValidationError(issues, options.hint) };
};
