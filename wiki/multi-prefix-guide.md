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

Endpoints:
- `POST /api/v1/v1:rpc/login`
- `POST /api/v2/v2:rpc/login`

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

// v1 API
app.use(
  "/api/v1",
  createRPCMiddleware({
    rpcPrefix: "v1:rpc",
    path: /^\/api\/v1/,
  }),
);

// v2 API
app.use(
  "/api/v2",
  createRPCMiddleware({
    rpcPrefix: "v2:rpc",
    path: /^\/api\/v2/,
  }),
);
```

### 3. Client Usage (Unchanged)

The plugin still generates client modules automatically. Each `rpcPrefix` generates stubs that call the correct endpoint:

```typescript
// src/api/v1/index.ts
export * from "./auth.server";

// Client code
import { login } from "./api/v1";

const { data } = login("user@example.com", "password");
const result = await data; // → POST /api/v1/v1:rpc/login
```

```typescript
// src/api/v2/index.ts
export * from "./auth.server";

// Client code
import { login } from "./api/v2";

const { data } = login({ email: "user@example.com", password: "pass", mfa: "123456" });
const result = await data; // → POST /api/v2/v2:rpc/login
```

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

### Origin Validation per Instance

```typescript
app.use(
  "/api/v1",
  createRPCMiddleware({
    rpcPrefix: "v1:rpc",
    origin: "https://legacy-app.example.com",
  }),
);

app.use(
  "/api/v2",
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
app.use(
  "/api/public",
  createRPCMiddleware({ rpcPrefix: "public:rpc" }),
);

app.use(
  "/api/admin",
  createRPCMiddleware({
    rpcPrefix: "admin:rpc",
    // Could add auth middleware here
  }),
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
// server.ts
app.use(
  "/api/orders/stable",
  createRPCMiddleware({ rpcPrefix: "orders:stable" }),
);

app.use(
  "/api/orders/canary",
  createRPCMiddleware({ rpcPrefix: "orders:canary" }),
);
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

## Security: Do Not Trust the Prefix

The prefix is a routing segment, not a secret. `getClientModules` only emits the config prefix's stubs (so `admin:rpc` never appears in a `public:rpc` client bundle), but an attacker can still `POST /admin:rpc/get-user` directly. Every privileged prefix **must** call auth inside the handler (e.g. `requireAdmin` via `sendResponse(403)` in `examples/advanced/src/api/middleware.ts:46`) — never rely on hiding the prefix string.

## Limitations

- Each prefix requires its own `createRPCMiddleware` instance.
- Functions must explicitly declare their `rpcPrefix` — there's no auto-grouping by directory.
- The plugin still performs a single scan (by default `src/api/`) for all prefixes; organize functions by file to make intent clear.
- `transform` replaces each `*.server.ts` in-memory with the same virtual module for the config prefix — no files are written to disk and no `admin` stubs leak into the `public` bundle.

> **Next:** [Middleware](./middleware.md) — write universal, adapter-agnostic middleware against the request context.
