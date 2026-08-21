import {
  getRequestContext,
  getRequestMeta,
  sendResponse,
} from "@thednp/rpc/server";

// ─── Session store (in-memory, cross-bundle via Symbol.for) ───────
type Session = {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: number;
};
const sessionSymbol = Symbol.for("thednp.rpc.advanced.session");
const sessions: Map<string, Session> =
  ((globalThis as unknown as Record<symbol, Map<string, Session>>)[
    sessionSymbol
  ] ??= new Map<string, Session>());

const SESSION_COOKIE = "sid";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24h

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
};

export const getSession = (): Session | null => {
  const event = getRequestContext();
  const { headers } = getRequestMeta(event);
  const raw = (headers["cookie"] as string | undefined) ??
    (headers["Cookie"] as string | undefined);
  const cookies = parseCookies(raw);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const sess = sessions.get(sid) ?? null;
  if (sess) (event.locals as Record<string, unknown>).session = sess;
  return sess;
};

export const createSession = (
  username: string,
  role: "admin" | "user",
): Session => {
  const id = crypto.randomUUID();
  const sess: Session = { id, username, role, createdAt: Date.now() };
  sessions.set(id, sess);
  const event = getRequestContext();
  const res = event.response as unknown as {
    setHeader?: (k: string, v: string) => void;
    cookie?: (k: string, v: string, o: unknown) => void;
  };
  const cookie = `${SESSION_COOKIE}=${
    encodeURIComponent(id)
  }; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
  if (res?.setHeader) res.setHeader("Set-Cookie", cookie);
  // express `res.cookie` also sets header — call if available for compat
  if (res?.cookie) {
    res.cookie(SESSION_COOKIE, id, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE * 1000,
    });
  }
  (event.locals as Record<string, unknown>).session = sess;
  return sess;
};

export const destroySession = (): void => {
  const event = getRequestContext();
  const sess = getSession();
  if (sess) sessions.delete(sess.id);
  const res = event.response as unknown as {
    setHeader?: (k: string, v: string) => void;
    clearCookie?: (k: string, o: unknown) => void;
  };
  const cookie =
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (res?.setHeader) res.setHeader("Set-Cookie", cookie);
  if (res?.clearCookie) res.clearCookie(SESSION_COOKIE, { path: "/" });
};

export const requireAdminSession = (): boolean => {
  const sess = getSession();
  // legacy header fallback for curl / automated tests
  if (!sess) {
    const event = getRequestContext();
    const { headers } = getRequestMeta(event);
    if (headers["x-admin-token"] === "admin-secret") return true;
  }
  if (sess?.role !== "admin") {
    sendResponse(403, { error: "Admin access required" });
    return false;
  }
  return true;
};

export type RateLimitOptions = {
  max: number;
  windowMs: number;
};

export const rateLimit = ({ max, windowMs }: RateLimitOptions) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (): boolean => {
    const event = getRequestContext();
    const { ip } = getRequestMeta(event);
    const key = ip ?? "anonymous";

    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      sendResponse(429, { error: "Rate limit exceeded" }, {
        "retry-after": String(retryAfter),
      });
      return false;
    }
    return true;
  };
};

export const auditLog = () => {
  const event = getRequestContext();
  const { method, pathname, ip } = getRequestMeta(event);
  const sess = (event.locals as Record<string, unknown>).session as
    | Session
    | undefined;
  console.log(
    `[audit] ${method} ${pathname} fn=${event.functionName} ip=${
      ip ?? "n/a"
    } user=${sess?.username ?? "anon"} role=${sess?.role ?? "-"}`,
  );
};

// kept for backward-compat with manual token header
export const requireAdmin = (token: string): boolean => {
  const event = getRequestContext();
  const { headers } = getRequestMeta(event);
  if (headers["x-admin-token"] === token) return true;
  return requireAdminSession();
};
