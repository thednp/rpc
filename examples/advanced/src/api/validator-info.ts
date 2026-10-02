/**
 * Client-safe data for the five-validator demo.
 *
 * This module exists because of a bundling rule that is easy to get wrong and
 * expensive to debug: **the schemas cannot be imported from client code.**
 *
 * `./validators.ts` value-imports `schema` from `@thednp/rpc/server`, and that
 * entry re-exports `scanForServerFiles`, which imports `node:fs/promises`. A
 * single *value* import of anything from it therefore pulls `node:fs` into the
 * browser bundle and the page dies with:
 *
 * > Module "node:fs/promises" has been externalized for browser compatibility.
 *
 * A `import type` is erased and always safe; a value import from a server module
 * is not. So the names and the prose — which the page genuinely needs — live
 * here, with no path to the server entry, and the schemas stay server-side.
 */
import type { ValidatorName } from "./types.d.ts";

/** The five validators the page can switch between. */
export const VALIDATORS = [
  "valibot",
  "zod",
  "arktype",
  "effect",
  "builder",
] as const;

/**
 * What each library does differently, shown under the result so a difference
 * reads as a finding rather than a bug report.
 *
 * Every claim here is measured, not paraphrased from documentation — these were
 * established by sending identical input through all five and recording what
 * came back.
 */
export const VALIDATOR_NOTES: Record<ValidatorName, string> = {
  valibot:
    "Value-first. Coerces a string age to a number through a pipe. Ignores unknown keys.",
  zod:
    "Builder chain. Coerces a string age through transform+pipe. Strips unknown keys.",
  arktype:
    "Type-first and the tersest of the four, but coercion takes a function pipe and needs a second pipe to restore the integer rule — the only one of the four that does not fold it into one expression.",
  effect:
    "Effect Schema via `Schema.toStandardSchemaV1`. Coerces a string age. Richest issue messages.",
  builder:
    "Zero dependencies — `schema()`/`field` from `@thednp/rpc/server` itself. No coercion and no ranges: the form sends Age as text, which the vendors convert and the builder rejects. The strict one: an unknown key is a 422 here and ignored everywhere else. Hints work identically.",
};

/**
 * Unknown-key behaviour, measured on identical input: the four vendor
 * libraries accept an unexpected field. rpc's own `schema()` builder is the
 * strict one, so the choice belongs to the library rather than to the `schema`
 * option.
 */
export const UNKNOWN_KEY_NOTE =
  "The four vendor libraries ignore an unknown key. rpc's own `schema()` builder is the strict one — it rejects — so the library, not the option, decides this.";
