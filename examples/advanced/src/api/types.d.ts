import type { JsonObject } from "@thednp/rpc";

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

/* ─── Validator demo ───────────────────────────────────────────────────────
 * These live here rather than beside the schemas because `types.d.ts` is the one
 * module both sides already import. The schemas cannot: they value-import
 * `schema` from `@thednp/rpc/server`, which reaches `scanForServerFiles` and its
 * `node:fs/promises` — and a *value* import of anything from that module drags
 * the whole server entry into the browser bundle. A type-only import is erased
 * and is always safe; a value import from a server module is not.
 */

/**
 * Which validator to use, derived from the runtime list in
 * `./validator-info.ts`. Imported as a *type* so this module stays free of
 * runtime values — a `.d.ts` cannot export one, and a value import here would
 * create a cycle with the module that defines the list.
 */
export type ValidatorName = "valibot" | "zod" | "arktype" | "effect";

/**
 * What a **handler** receives, after the schema has run: `age` is a `number`
 * because three of the four schemas coerce, and the one that does not rejects
 * rather than passing a string through.
 */
export type Profile = {
  name: string;
  age: number;
  tags: string[];
  address: { city: string; zip?: string };
};

/**
 * What a **client** may send, which Standard Schema keeps deliberately distinct
 * from the output. The only difference is `age`, and that is the point: naming
 * both shows why the spec splits them.
 *
 * Both are `type` aliases rather than interfaces on purpose — only an alias
 * gets an implicit index signature, and the stub's argument type is intersected
 * with `JsonObject` at the wire boundary. As an `interface` the same shape fails
 * with "Index signature for type 'string' is missing".
 */
export type ProfileInput = {
  name: string;
  age: string | number;
  tags: string[];
  address: { city: string; zip?: string };
};
