# Best Practices

Production patterns for authentication, validation, body limits, rate limiting, and CSRF protection — and what `@thednp/rpc` deliberately leaves to you.

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

The full `@tanstack/react-query` integration example (including wiring `cancel()` to the query signal) lives in [Client Usage — @tanstack/react-query Integration](./client-usage.md).

## AbortSignal Best Practices

Always check `signal.aborted` or call `signal.throwIfAborted()` in long-running server functions — especially inside loops, where a step may take a while and the client may have already cancelled. The full pattern is in [Server Functions — AbortSignal](./server-functions.md#abortsignal).

## Input Validation

Client-provided data is untrusted — always validate before use. Return expected problems (validation failures, business rules) as structured data so the client can type-narrow on the result; **throw** `RPCError` only for server-side failures:

- Return `{ error: ... }` → arrives as resolved `data` (no rejection) — [Server Functions — Input Validation](./server-functions.md#input-validation) shows both zod and valibot patterns
- Throw `new RPCError(msg, code, data)` → client's `data` promise rejects with the message — [Server Functions — Typed Errors](./server-functions.md#typed-errors-rpcerror)

## Authentication

> Never add auth hooks inside server functions.

Use authentication middleware **before** `createRPCMiddleware()`.

```ts
app.use(authMiddleware);
app.use(createRPCMiddleware());
```

> To read what auth middleware populated from inside a server function — on **any** adapter — see [Middleware — The `locals` Bridge](./middleware.md#the-locals-bridge). The request context maps framework storage (`res.locals`, `ctx.state`, `event.context`) onto `event.locals` automatically.

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

```ts
// h3
import { H3, assertBodySize } from "h3";

const app = new H3();

// Cap the body with h3's native stream limit — it swaps `event.req` for a
// bounded stream, so the cap is enforced *while* the body streams (never
// buffered in full) and the RPC `readBody` can still consume it afterwards.
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

app.use(async (event, next) => {
  try {
    assertBodySize(event, MAX_BODY_SIZE);
  } catch {
    event.res.status = 413;
    return { error: "Payload Too Large" };
  }
  return next();
});

app.use(createRPCMiddleware(options));
```

> A complete, extracted implementation lives in the [h3 example](../examples/h3/middleware/bodyLimit.js) (`middleware/bodyLimit.js`). Do **not** iterate `for await over event.req` to count bytes before forwarding — that consumes the request stream and the RPC `readBody` will then fail with `Body is unusable`.

In other cases, your custom [server app](../examples/ssr/http-express.ts) can use something like this. Enforce the cap **while the stream is being read** — reading the whole body with `readBody` first and then checking the size still buffers an oversized body in memory, which is exactly what a body limit should prevent:
```ts
// SSR (custom node:http server with Vite middleware mode)
import { createMiddleware } from "@thednp/rpc/express";
import { loadRPCConfig } from "@thednp/rpc";

const config = await loadRPCConfig();
const MAX_BODY_SIZE = 1024 * 1024;

app.use(createMiddleware({
  rpcPrefix: config.rpcPrefix,
  handler: (req, res, next) => {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }
    let size = 0;
    let capped = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (capped) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        capped = true;
        chunks.length = 0;
        req.removeAllListeners("data");
        res.statusCode = 413;
        res.end("Payload Too Large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (capped) return;
      const body = Buffer.concat(chunks).toString();
      const contentType = req.headers["content-type"]?.toLowerCase() || "";
      const isUrlEncoded = contentType.includes("urlencoded");
      req.body = isUrlEncoded
        ? Object.fromEntries(new URLSearchParams(body))
        : body;
      next();
    });
  },
}));
```

For SPA you can make use of the vite runtime [proxy](../examples/spa/vite.config.ts)
```ts
// SPA (dedicated RPC proxy server)
const MAX_BODY_SIZE = 1024 * 1024;

const bodyLimit = (req, res, next) => {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    res.statusCode = 413;
    res.end("Payload Too Large");
    return;
  }
  let size = 0;
  let capped = false;
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => {
    if (capped) return;
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      capped = true;
      chunks.length = 0;
      req.removeAllListeners("data");
      res.statusCode = 413;
      res.end("Payload Too Large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (capped) return;
    const body = Buffer.concat(chunks).toString();
    const contentType = req.headers["content-type"]?.toLowerCase() || "";
    const isUrlEncoded = contentType.includes("urlencoded");
    req.body = isUrlEncoded
      ? Object.fromEntries(new URLSearchParams(body))
      : body;
    next();
  });
};
```

## Rate Limiting

Throttle RPC endpoints like any other route — rate limiting is the host's responsibility:

> For **per-function** rules (e.g. tighter limits on expensive endpoints) that work identically on all adapters, write a universal middleware against the request context — it can read `event.functionName`, `getRequestMeta(event).ip`, and `event.locals.user` to key the bucket. See [Middleware](./middleware.md#universal-middleware-in-action).

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

## SSR vs SPA

The plugin resolves server functions differently between the server and client bundles — see [Getting Started — SSR vs SPA](./getting-started.md#ssr-vs-spa) for how both projects look. The same import works in both; on the client it's swapped for a `fetch`-based module at build time.

## File Naming

Only files matching `server.ts`, `server.js`, `server.mjs`, `server.mts` in `src/api/` are scanned (see [Getting Started — Project Structure](./getting-started.md#required-project-structure)). Export functions individually for proper client module mapping:

```ts
// ✅ Good — individual exports
export const sayHi = createServerFunction('say-hi', fn);
export const add = createServerFunction('add-numbers', fn);

// ❌ Avoid — default export or bundled objects
export default { sayHi, add };
```

> End of the guide. Each page in the [Table of Contents](#table-of-contents) below is self-contained — jump in anywhere or revisit the [Quick Start](./quickstart.md) to see everything wired together.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Middleware](./middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
