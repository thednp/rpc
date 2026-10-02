# Multi-Prefix Support

Run multiple RPC instances in parallel with different prefixes. Enables versioned APIs, namespaced endpoints, and API segregation without function name collisions.

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation, project structure, and your first function
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Multi-Prefix Support](./multi-prefix-guide.md) — Parallel RPC instances with versioned/namespaced prefixes
- [Middleware](./middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Comparison](./comparison.md) — How the cross-origin/CSRF boundary compares to Next.js Server Actions, TanStack Start, SvelteKit, and tRPC
- [Best Practices](./best-practices.md) — Tips and best practices

## Problem

Classic single-prefix setup:

```typescript
// src/api/auth.server.ts
export const login = createServerFunction("login", async (signal, email, password) => ({...}));
```

Endpoint: `POST /__rpc/login`

With multiple API versions, you'd need:

```typescript
// Collision! Both try to register "login"
export const loginV1 = createServerFunction("login-v1", ...);
export const loginV2 = createServerFunction("login-v2", ...);
```

**With multi-prefix support**, use identical names under different prefixes:

```typescript
// src/api/v1/auth.server.ts
export const login = createServerFunction("login", async (...) => {...}, { rpcPrefix: "v1:rpc" });

// src/api/v2/auth.server.ts
export const login = createServerFunction("login", async (...) => {...}, { rpcPrefix: "v2:rpc" });
```

Endpoints — the prefix **is** the first path segment, and nothing more is inserted:
- `POST /v1:rpc/login`
- `POST /v2:rpc/login`

> **The prefix is the whole route.** A middleware built with `rpcPrefix: "v1:rpc"` gates on the anchored regex `^/v1:rpc/` and strips that exact segment, so the endpoint is always `/{prefix}/{functionName}` at the mount root. Mounting it under an extra path (`app.use("/api/v1", …)`) does **not** namespace it — the gate is evaluated against the full request path, so `POST /api/v1/v1:rpc/login` falls through to `next()` and 404s. The working example in `examples/advanced` mounts `admin:rpc` and `public:rpc` at the app root for exactly this reason.

## Setup

### 1. Define Server Functions with `rpcPrefix`

```typescript
// src/api/v1/auth.server.ts
import { createServerFunction } from "@thednp/rpc/server";

export const login = createServerFunction(
  "login",
  async (signal, email: string, password: string) => {
    signal.throwIfAborted();
    return { token: "v1-token", user: { email } };
  },
  { rpcPrefix: "v1:rpc" }, // Register under v1:rpc prefix
);

export const logout = createServerFunction(
  "logout",
  async (signal) => {
    return { success: true };
  },
  { rpcPrefix: "v1:rpc" },
);
```

> **Shortcut:** When every function in a file shares the same `rpcPrefix`, call `setGlobalPrefix` once at the top instead of repeating the option per-function. This is the correct pattern for serverless deployments where functions register at import time (see [Adapters — Serverless](./adapters.md#serverless)).

```typescript
// src/api/v2/auth.server.ts
import { createServerFunction } from "@thednp/rpc/server";

export const login = createServerFunction(
  "login", // Same name — no collision with v1:login
  async (signal, credentials: { email: string; password: string; mfa?: string }) => {
    signal.throwIfAborted();
    return { accessToken: "v2-token", user: { email }, expiresIn: 3600 };
  },
  { rpcPrefix: "v2:rpc" }, // Register under v2:rpc prefix
);

export const logout = createServerFunction(
  "logout",
  async (signal) => {
    return { success: true, message: "goodbye" };
  },
  { rpcPrefix: "v2:rpc" },
);
```

### 2. Wire Multiple Middleware Instances

```typescript
// server.ts
import express from "express";
import { createRPCMiddleware } from "@thednp/rpc/express";

const app = express();

// Mount at the app root: the prefix is the first path segment.
app.use(createRPCMiddleware({ rpcPrefix: "v1:rpc" }));
app.use(createRPCMiddleware({ rpcPrefix: "v2:rpc" }));
```

> **If your server files use the `*.server.ts` layout, pass `serverFiles: "glob"` to *each* middleware.** The lazy production scan reads `serverFiles` and `scanRoot` from the *middleware's* options, not from `rpc.config.ts` — so a config file alone is not enough, and without it the scan matches nothing and every endpoint 404s. With the default `"exact"` layout (`server.ts` directly in the scan root) this does not apply.
>
> ```typescript
> app.use(createRPCMiddleware({ rpcPrefix: "v1:rpc", serverFiles: "glob" }));
> ```

### 3. Client Usage

Only the **configured** prefix gets auto-generated stubs. The generated module is built from `getFunctionsForPrefix(config.rpcPrefix)` — a single prefix, decided by `rpc.config.ts` (or the `rpc()` options in `vite.config.ts`). Functions under any *other* prefix are not code-generated, and importing them from the generated module fails to resolve.

So there are two cases:

**The function's prefix matches the configured one** — import it and it works:

```typescript
// src/api/auth.server.ts — registered under the configured prefix
export const login = createServerFunction("login", async (signal, email: string) => ({...}));

// Client code
import { login } from "./api";

const { data } = login("user@example.com");
await data; // → POST /v1:rpc/login
```

**The prefix is not the configured one** — build the stub yourself with `getClientStub` from `@thednp/rpc/helpers`. This is also the right tool for privileged prefixes you deliberately do not want in the public bundle:

```typescript
import { getClientStub } from "@thednp/rpc/helpers";

// Manually wire an endpoint for a prefix the bundle does not generate.
const adminGetUser = getClientStub("admin:rpc", "get-user");
const adminStats = getClientStub("admin:rpc", "stats", { method: "GET" });
```

> A sensible convention: give the public/browser-facing prefix the configured one (so its stubs are generated), and hand-wire anything privileged. That is exactly the split in `examples/advanced`, where `public:rpc` is the config prefix and `admin:rpc` is imported explicitly.

## Best Practices

### Use Semantic Prefix Names

```typescript
// ✅ Clear intent
{ rpcPrefix: "v1:rpc" }
{ rpcPrefix: "admin:rpc" }
{ rpcPrefix: "public:rpc" }

// ❌ Avoid magic numbers
{ rpcPrefix: "rpc-1" }
{ rpcPrefix: "__rpc-2" }
```

### Organize by Prefix

```
src/api/
  v1/
    auth.server.ts       # All exports use { rpcPrefix: "v1:rpc" }
    users.server.ts
    index.ts             # export * from "./auth.server"; etc.
  v2/
    auth.server.ts       # All exports use { rpcPrefix: "v2:rpc" }
    users.server.ts
    index.ts
  admin/
    dashboard.server.ts  # All exports use { rpcPrefix: "admin:rpc" }
    index.ts
```

A nested `*.server.ts` layout is only picked up in **glob** mode. Pass `serverFiles: "glob"` to every middleware that should scan it — the lazy production scan reads that option from the middleware, not from `rpc.config.ts`:

```typescript
app.use(
  createRPCMiddleware({ rpcPrefix: "v1:rpc", serverFiles: "glob" }),
);
```

### Origin Validation per Instance

Each instance carries its own `origin` allowlist, and because the prefix is the first path segment they mount side by side at the root:

```typescript
app.use(
  createRPCMiddleware({
    rpcPrefix: "v1:rpc",
    origin: "https://legacy-app.example.com",
  }),
);

app.use(
  createRPCMiddleware({
    rpcPrefix: "v2:rpc",
    origin: "https://app.example.com",
  }),
);
```

## Examples

### Versioned Public + Admin APIs

```typescript
// src/api/public/users.server.ts
export const getUser = createServerFunction(
  "get-user",
  async (signal, id: string) => {
    const user = await db.users.findById(id);
    return { id: user.id, name: user.name, email: user.email };
  },
  { rpcPrefix: "public:rpc" },
);

// src/api/admin/users.server.ts
export const getUser = createServerFunction(
  "get-user",
  async (signal, id: string) => {
    const user = await db.users.findById(id); // Admin sees all fields
    return user; // Full record
  },
  { rpcPrefix: "admin:rpc" },
);
```

```typescript
// server.ts
app.use(createRPCMiddleware({ rpcPrefix: "public:rpc" }));

app.use(
  authMiddleware, // could sit between the two
  createRPCMiddleware({ rpcPrefix: "admin:rpc" }),
);
```

### Canary Deployment

```typescript
// src/api/stable/orders.server.ts
export const createOrder = createServerFunction(
  "create",
  async (signal, items) => {
    // Stable, battle-tested implementation
    return await stableOrderFlow(items);
  },
  { rpcPrefix: "orders:stable" },
);

// src/api/canary/orders.server.ts
export const createOrder = createServerFunction(
  "create",
  async (signal, items) => {
    // New feature under test
    return await newOrderFlowWithAnalytics(items);
  },
  { rpcPrefix: "orders:canary" },
);
```

```typescript
// server.ts — endpoints are /orders:stable/create and /orders:canary/create
app.use(createRPCMiddleware({ rpcPrefix: "orders:stable" }));
app.use(createRPCMiddleware({ rpcPrefix: "orders:canary" }));
```

## Backward Compatibility

If no `rpcPrefix` is specified, functions default to `"__rpc"`, maintaining full backward compatibility:

```typescript
// Works exactly as before
export const login = createServerFunction(
  "login",
  async (signal, email, password) => ({...}),
  // { rpcPrefix: "__rpc" } — implicit default
);
```

### Only the first scan used to run

`scanForServerFiles` memoizes per scan target — the resolved `(scanRoot, serverFiles, rpcPrefix)` triple — so a second RPC instance on a different prefix is scanned even if another scan already happened. (It used to be a single process-wide flag, so the first scan suppressed every later one and the second instance 404'd.) Each prefix still scans at most once, so this costs nothing at request time.

**A function that declares no `rpcPrefix` of its own** is registered under whichever prefix the scan was configured with — so with two prefixes, pass the prefix on each function (the pattern above), or give the public instance the one in `rpc.config.ts`. A function that *does* declare its prefix is registered correctly by a single scan.

## Security: Do Not Trust the Prefix

The prefix is a routing segment, not a secret. `getClientModules` only emits the config prefix's stubs (so `admin:rpc` never appears in a `public:rpc` client bundle), but an attacker can still `POST /admin:rpc/get-user` directly. Every privileged prefix **must** call auth inside the handler (e.g. `requireAdminSession` via `sendResponse(403)` in `examples/advanced/src/api/middleware.ts:98`) — never rely on hiding the prefix string.

## Limitations

- Each prefix requires its own `createRPCMiddleware` instance.
- Functions must explicitly declare their `rpcPrefix` — there's no auto-grouping by directory.
- The plugin still performs a single scan (by default `src/api/`) for all prefixes; organize functions by file to make intent clear.
- `transform` replaces each `*.server.ts` in-memory with the same virtual module for the config prefix — no files are written to disk and no `admin` stubs leak into the `public` bundle.

> **Next:** [Middleware](./middleware.md) — write universal, adapter-agnostic middleware against the request context.
