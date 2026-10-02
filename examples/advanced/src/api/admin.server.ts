import type { UserFull } from "./types.d.ts";
import { createServerFunction } from "@thednp/rpc/server";
import { auditLog, rateLimit, requireAdminSession } from "./middleware.ts";
import * as z from "zod";

/**
 * The input contract for {@link adminGetUser}.
 *
 * A bare `z.string()` would validate almost nothing, and this endpoint builds an
 * email address straight from the id — an empty one yields `user@example.com`.
 * The trim/min/max below is the part that earns its place.
 *
 * Note the shape: this function's first argument is a **scalar**, so the schema
 * is a scalar schema. `schema({...})` is for an object argument.
 */
const idSchema = z
  .string()
  .trim()
  .min(1, "an id is required")
  .max(64, "keep the id under 64 characters");

const adminUserLimit = rateLimit({ max: 20, windowMs: 10_000 });

// Same function name as the public prefix, but requires an admin session
// (HttpOnly cookie) — showcases multi-prefix coexistence + real auth.
export const adminGetUser = createServerFunction(
  "get-user",
  // No annotation: `id` is inferred from `idSchema`, and annotating it with
  // anything the schema does not produce is a type error.
  async (_signal, id) => {
    auditLog();
    if (!requireAdminSession()) return;
    adminUserLimit();
    return await Promise.resolve(
      {
        id,
        name: `User ${id}`,
        email: `user${id}@example.com`,
        role: "admin",
        ssn: "123-45-6789",
      } satisfies UserFull,
    );
  },
  {
    rpcPrefix: "admin:rpc",
    // zod implements Standard Schema, so this is the same `schema` option the
    // public prefix uses with valibot — no adapter, no per-library branch.
    schema: idSchema,
    hint: "the user id, as shown in the admin table",
  },
);
