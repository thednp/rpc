import { createServerFunction } from "@thednp/rpc/server";
import { auditLog, rateLimit, requireAdminSession } from "./middleware";
import type { UserFull } from "./types";

const adminUserLimit = rateLimit({ max: 20, windowMs: 10_000 });

// Same function name as the public prefix, but requires an admin session
// (HttpOnly cookie) — showcases multi-prefix coexistence + real auth.
export const adminGetUser = createServerFunction(
  "get-user",
  async (_signal, id: string) => {
    auditLog();
    if (!requireAdminSession()) return;
    adminUserLimit();
    return {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`,
      role: "admin",
      ssn: "123-45-6789",
    } satisfies UserFull;
  },
  { rpcPrefix: "admin:rpc" },
);
