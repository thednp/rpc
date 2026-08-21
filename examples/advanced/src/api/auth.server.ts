import { createServerFunction } from "@thednp/rpc/server";
import {
  auditLog,
  createSession,
  destroySession,
  getSession,
} from "./middleware";

// demo users — in production verify against DB + hash
const USERS: Record<string, { password: string; role: "admin" | "user" }> = {
  admin: { password: "admin-secret", role: "admin" },
  user: { password: "user-secret", role: "user" },
};

export const login = createServerFunction(
  "login",
  async (_signal, username: string, password: string) => {
    auditLog();
    const entry = USERS[username];
    if (!entry || entry.password !== password) {
      return { ok: false as const, error: "Invalid credentials" };
    }
    const sess = createSession(username, entry.role);
    return { ok: true as const, user: { username, role: sess.role } };
  },
  { rpcPrefix: "public:rpc" },
);

export const logout = createServerFunction(
  "logout",
  async () => {
    auditLog();
    destroySession();
    return { ok: true as const };
  },
  { rpcPrefix: "public:rpc" },
);

export const me = createServerFunction(
  "me",
  async () => {
    const sess = getSession();
    if (!sess) return { user: null as unknown as null };
    return { user: { username: sess.username, role: sess.role } };
  },
  { rpcPrefix: "public:rpc" },
);
