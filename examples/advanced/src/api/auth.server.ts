import { createServerFunction } from "@thednp/rpc/server";
import {
  auditLog,
  createSession,
  destroySession,
  getSession,
} from "./middleware.ts";

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
      return await Promise.resolve({
        ok: false,
        error: "Invalid credentials",
      });
    }
    const sess = createSession(username, entry.role);
    return await Promise.resolve({
      ok: true,
      user: { username, role: sess.role },
    });
  },
  { rpcPrefix: "public:rpc" },
);

export const logout = createServerFunction(
  "logout",
  async () => {
    auditLog();
    destroySession();
    return await Promise.resolve({ ok: true });
  },
  { rpcPrefix: "public:rpc" },
);

export const me = createServerFunction(
  "me",
  async () => {
    const sess = getSession();
    if (!sess) return await Promise.resolve({ user: null as unknown as null });
    return await Promise.resolve({
      user: { username: sess.username, role: sess.role },
    });
  },
  { rpcPrefix: "public:rpc" },
);
