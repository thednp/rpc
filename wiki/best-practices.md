# Best Practices

## @thednp/rpc is a Transport Pipe

The best thing to do **first** is to understand `@thednp/rpc` is that it only handles **transport** and **serialization**.

It does not provide:
- Caching
- Authentication
- Validation
- State management
- Request limits
- Retry logic

Use dedicated tools for these concerns.

## Client-Side Caching

All major frameworks have a `@tanstack/<framework>-query` made by [Tanstack](https://tanstack.com/) to cover all needs except validation and authentication.

For instance the `@tanstack/react-query` is the recommended layer for React apps client-side caching, invalidation, and stale-while-revalidate:

```ts
// src/components/GreetUser.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sayHi } from '../api';

function GreetUser({ name }: { name: string }) {
  const { data } = useQuery({
    queryKey: ['say-hi', name],
    queryFn: ({ signal }) => {
      const result = sayHi(name);
      signal.addEventListener('abort', () => result.cancel('query cancelled'));
      return result.data;
    },
  });
  return <div>{data ?? 'Loading...'}</div>;
}
```

## AbortSignal Best Practices

Always check `signal.aborted` or call `signal.throwIfAborted()` in long-running server functions:

```ts
export const processBatch = createServerFunction(
  'process-batch',
  async (signal: AbortSignal, items: string[]) => {
    const results = [];
    const errors = [];
    for (const item of items) {
      signal.throwIfAborted();
      const result = await heavyWork(item);
      results.push(result);
      // handle errors properly
    }
    return results;
  },
);
```

## Input Validation

Always validate client-provided data before using it in server functions. Use libraries like **zod** or **valibot** to parse and validate inputs:

```ts
// src/api/server.ts
import { z } from 'zod';
import { createServerFunction } from '@thednp/rpc/server';

const ProfileSchema = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().positive(),
});

export const updateProfile = createServerFunction(
  'update-profile',
  async (signal, raw) => {
    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errors: parsed.error.flatten().fieldErrors };
    }
    // parsed.data is fully typed
    await saveToDb(parsed.data);
    return { ok: true };
  },
);
```

Return validation errors as structured data — the client's `handleResponse` will surface them as an `Error`. Check [Server Functions Guide](./server-functions.md) for more detailed examples.

## Authentication

> Never add auth hooks inside server functions.

Use authentication middleware **before** `createRPCMiddleware()`.

```ts
app.use(authMiddleware);
app.use(createRPCMiddleware());
```


### Basic Authorization

A typical auth middleware reads credentials from the request, validates them, and sets `req.user`:

```ts
// Express
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    req.user = verifyToken(token); // { id, role, ... }
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
};
```

> In your production apps, **use best solutions** provided by server of your choice. The above code is only to showcase how to wire pieces together.

### Per-Function Authorization

When some server functions should be public and others require authentication, use `createMiddleware` with a handler that inspects the function name:

```ts
import type { Request } from "express";
import { createMiddleware } from "@thednp/rpc/express";
import { loadRPCConfig } from "@thednp/rpc";

const publicFns = new Set(["login", "register", "publicData"]);
const config = await loadRPCConfig();

// use a type to better describe your requests
type UserRequest = Request & {
  user: YourUserType
}

const rpcAuthz = createMiddleware({
  rpcPrefix: config.rpcPrefix,
  handler: async (req: UserRequest, res, next) => {
    const url = new URL(req.url, "http://localhost").pathname;
    const fnName = url.replace(config.rpcPrefix, "");
    const user = req.user; // set by earlier auth middleware

    // Allow public functions through
    if (publicFns.has(fnName)) return next();

    // Reject unauthenticated
    if (!user) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    next();
  },
});
```

Wire it between auth and the RPC handler:

```ts
app.use(authMiddleware);      // sets req.user
app.use(rpcAuthz);            // per-function guard
app.use(createRPCMiddleware());
```

For role-based access, extend with a map:

```ts
const roleAccess: Record<string, string[]> = {
  deleteUser: ["admin"],
  updateProfile: ["user", "admin"],
};

if (!user || !roleAccess[fnName]?.includes(user.role)) {
  // 401 or 403
}
```

## Body Limits

In most cases you should rely on your framework's body-parser middleware:

```ts
// Express
import express from "express";
const app = express();
app.use(express.json({ limit: 1024 * 1024 })); // or "1mb"
app.use(createRPCMiddleware());
```

```ts
// Fastify
import Fastify from "fastify";

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 }); // "1MB"
```

```ts
// Hono
import { Hono } from "hono";
import { bodyLimit } from 'hono/body-limit';

const app = new Hono();
app.use('*', bodyLimit({ maxSize: 1024 * 1024 })) // 1MB
```

```ts
// Koa
import Koa from "koa";
import { koaBody } from 'koa-body';

const app = new Koa();
app.use(koaBody({ jsonLimit: 1024 * 1024 })); // 1MB
```

In other cases, your custom [server app](../examples/ssr/http-express.ts) can use something like this:
```ts
// SSR (custom node:http server with Vite middleware mode)
import { createMiddleware, readBody } from "@thednp/rpc/express";
import { loadRPCConfig } from "@thednp/rpc";

const config = await loadRPCConfig();
const MAX_BODY_SIZE = 1024 * 1024;

app.use(createMiddleware({
  rpcPrefix: config.rpcPrefix,
  handler: async (req, res, next) => {
    const { data } = await readBody(req);
    if (Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data)) > MAX_BODY_SIZE) {
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }
    req.body = data;
    next();
  },
}));
```

For SPA you can make use of the vite runtime [proxy](../examples/spa/vite.config.ts)
```ts
// SPA (dedicated RPC proxy server)
import { readBody } from "@thednp/rpc/express";

const MAX_BODY_SIZE = 1024 * 1024;

const bodyLimit = async (req, res, next) => {
  const { data } = await readBody(req);
  if (Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data)) > MAX_BODY_SIZE) {
    res.statusCode = 413;
    res.end("Payload Too Large");
    return;
  }
  req.body = data;
  next();
};
```

## Rate Limiting

Throttle RPC endpoints like any other route — rate limiting is the host's responsibility:

```ts
// Express
import { rateLimit } from 'express-rate-limit';

app.use('/__rpc', rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60, // 60 requests per window
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));
app.use(createRPCMiddleware());
```

```ts
// Fastify
import rateLimit from '@fastify/rate-limit';

await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
```

```ts
// Hono
import { rateLimiter } from 'hono-rate-limiter';

app.use('/__rpc/*', rateLimiter({ windowMs: 60_000, limit: 60 }));
```

```ts
// Koa
import { rateLimit } from 'koa2-ratelimit';

app.use(rateLimit.middleware({ interval: { min: 1 }, max: 60 }));
```

## Origin / CSRF Protection

`@thednp/rpc` performs **no origin validation by default** — like authentication, it is opt-in so the host decides.

### Option A: `origin` middleware option

When your RPC endpoints sit behind a reverse proxy with multiple public origins (e.g. a sibling subdomain), pass the allowed origin to `createRPCMiddleware()`:

```ts
app.use(createRPCMiddleware({
  origin: 'https://app.example.com',
}));
```

Requests carrying an `Origin` header that does not match are rejected with `403 Forbidden`. Requests without an `Origin` header (curl, native apps) pass through unchecked.

> `SameSite=Lax` cookies already block cross-site `POST` from HTML forms; the `origin` option closes the remaining "sibling subdomain" case.

### Option B: custom middleware

Check `Sec-Fetch-Site` (Fetch Metadata) or `Origin` yourself before the RPC middleware:

```ts
// Express
app.use((req, res, next) => {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
});
app.use(createRPCMiddleware());
```

Note that strict checks rejecting requests *without* these headers (TanStack Start style) will break curl and native clients — only enforce when the header is present, or provide an opt-out.

## SSR Guidance

- On the **server**, `createServerFunction` runs directly (not Vite-transformed).
- On the **client**, the plugin replaces server function calls with `fetch` based client modules.
- Keep `src/entry-client.ts` and `src/entry-server.ts` separate for proper hydration.

## File Naming

Only files matching `server.ts`, `server.js`, `server.mjs`, `server.mts` in `src/api/` are scanned. Export functions individually for proper client module mapping:

```ts
// ✅ Good — individual exports
export const sayHi = createServerFunction('say-hi', fn);
export const add = createServerFunction('add-numbers', fn);

// ❌ Avoid — default export or bundled objects
export default { sayHi, add };
```

## Cache is Not @thednp/rpc's Job

Use `react-query`, `SWR`, or your framework's data hooks for caching. `@thednp/rpc` is the **transport layer only**.
