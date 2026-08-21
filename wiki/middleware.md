# Middleware

Write **one** middleware function that works on every adapter (Express, Fastify, Koa, Hono, h3). Because `@thednp/rpc` runs each server-function dispatch inside a per-request context ([`RequestEvent`](./server-functions.md#the-requestevent-shape)), middleware written against `getRequestContext()` behaves identically regardless of the host framework — no per-framework rewrites.

## The Two Flavors

There are two places you can put logic, and they serve different purposes:

| | Framework middleware (before `createRPCMiddleware()`) | Universal middleware (inside a server function) |
|---|---|---|
| **Where it runs** | In the framework's own middleware chain, before the RPC endpoint | Inside the request context, at the top of your server function |
| **What it can do** | Read/modify the native request, short-circuit the whole route | Read the normalized request, short-circuit the RPC response |
| **Who it talks to** | Native framework APIs (`res.locals`, `ctx.state`, `c.set`, ...) | `getRequestContext()`, `getRequestMeta()`, `sendResponse()` |
| **Write once for all adapters?** | No — each framework has its own API | **Yes** — the context API is identical everywhere |
| **Best for** | Auth, sessions, body parsing, CSRF — the heavy official middleware | Cross-cutting RPC rules: per-function rate limiting, audit logging, feature flags |

**Recommended approach:** use your framework's **official** middleware for the heavy lifting (it's battle-tested and framework-idiomatic), then **wrap it** with a small universal adapter so your server functions can read the result from `locals` and short-circuit cleanly. `@thednp/rpc` gives you the structure (`locals`, `send`, `functionName`, `getRequestMeta`) and the docs to do this in ~10 lines per middleware.

> This page assumes you're familiar with the [request context](./server-functions.md#request-context-provideRequestcontext-getrequestcontext).

## The `locals` Bridge

Every adapter maps your framework's per-request storage onto `event.locals`, so data written by official framework middleware is automatically visible inside server functions:

| Adapter | `locals` source | Framework middleware writes to | Example |
|---|---|---|---|
| Express | `res.locals` | `res.locals.*` | `express-session` → `res.locals.user` |
| Koa | `ctx.state` | `ctx.state.*` | `koa-session` → `ctx.state.user` |
| h3 | `event.context` | `event.context.*` | `defineEventHandler` + `event.context.user` |
| Fastify | `{}` (see below) | `request.*` (via `decorateRequest`) | `@fastify/auth` → `request.user` |
| Hono | `{}` (see below) | `c.set(...)` / `c.get(...)` | Hono `c.set("user", ...)` |

> **Fastify & Hono**: these frameworks don't expose a framework-level "locals" object that `@thednp/rpc` can bridge directly, so `event.locals` starts empty for them. Read the values your middleware wrote through the native objects instead: Fastify `event.request.user` (see [types](./adapters.md#fastify)), Hono `(event.nativeEvent as import('hono').Context).get('user')`. Both adapters still expose the full native request via `event.request`/`event.nativeEvent`, so nothing is lost.

## Universal Middleware in Action

A typical universal middleware:

1. Reads the normalized request via `getRequestMeta(event)`.
2. Optionally branches on `event.functionName`.
3. Short-circuits with `sendResponse(status, body, headers)` when it needs to reject.
4. Otherwise stores data on `event.locals` for the rest of the dispatch to consume.

```ts
import {
  createServerFunction,
  getRequestContext,
  getRequestMeta,
  sendResponse,
} from '@thednp/rpc/server';

// A single rate-limit middleware — identical on all 5 adapters
export const rateLimit = (opts: { max: number; windowMs: number }) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return () => {
    const event = getRequestContext();
    const { ip } = getRequestMeta(event);

    // Per-function keys: distinguish authorized vs anonymous via locals
    const key = event.locals.user?.id ?? ip ?? 'anonymous';

    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return; // allow
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      // Real status code + header, on every adapter
      sendResponse(429, { error: 'Rate limit exceeded' }, {
        'retry-after': String(retryAfter),
      });
    }
  };
};

const limit = rateLimit({ max: 60, windowMs: 60_000 });

export const getProfile = createServerFunction('get-profile', async (signal, userId) => {
  limit(); // runs inside the request context
  // ... fetch the profile
});
```

### Short-Circuiting with `sendResponse`

The middleware returns the response **directly** with the given status, body, and headers — no `{ data }` wrapper, no 200. This works on every adapter:

| Adapter | `sendResponse(429, { error: '...' }, { 'retry-after': '30' })` becomes |
|---|---|
| Express | `res.status(429).header('retry-after','30').send('{"error":"..."}')` |
| Fastify | `reply.header('retry-after','30').status(429).send({ error: '...' })` |
| Koa | `ctx.set('retry-after','30'); ctx.status = 429; ctx.body = { error: '...' }` |
| Hono | `return c.body(JSON.stringify({ error: '...' }), 429, { 'content-type':'application/json', 'retry-after':'30' })` |
| h3 | `event.res.status = 429; event.res.headers.set('retry-after','30'); return { error: '...' }` |

After a `sendResponse`, the adapter skips its normal `{ data }` JSON send (same mechanism as `redirect`). Call it at most once per request.

## The Request Context API

### `getRequestContext()`

Returns the current [`RequestEvent`](./server-functions.md#the-requestevent-shape). Throws outside a request.

### `getRequestMeta(event)`

A normalized, adapter-agnostic view of the request — feature-detects the request shape (`originalUrl`/`url`/`path`, plain header map vs `Headers`-like) so you don't branch per framework:

```ts
const meta = getRequestMeta(getRequestContext());

meta.method;           // "POST" (upper-cased)
meta.pathname;         // "/__rpc/get-profile"
meta.search;           // "?x=1" or ""
meta.searchParams;     // URLSearchParams
meta.headers;          // { host: '...', authorization: '...', ... } (lower-cased)
meta.host;             // "localhost:5173"
meta.ip;               // client IP when the framework exposes it
meta.protocol;         // "http" | "https"
```

### `event.functionName`

The matched RPC function name for the request (e.g. `"get-profile"`). Handy for per-function rules — rate-limit buckets, audit logs, feature toggles — without parsing the URL yourself.

### `sendResponse(status, body, headers?)`

Context-level helper (import from `@thednp/rpc/server`) equivalent to `getRequestContext().send(status, body, headers)`. See [Short-Circuiting](#short-circuiting-with-sendresponse).

## Wrapping Official Framework Middleware

### Express — session → `locals`

```ts
import session from 'express-session';
import { createRPCMiddleware } from '@thednp/rpc/express';

app.use(session({ secret: '...' }));
// express-session writes req.session; copy it to res.locals so server
// functions can read it from event.locals without touching req
app.use((req, res, next) => {
  res.locals.user = req.session?.user;
  next();
});
app.use(createRPCMiddleware());
```

```ts
// server function — reads what the middleware populated
const { locals } = getRequestContext();
if (!locals.user) sendResponse(401, { error: 'Unauthorized' });
```

### Koa — `ctx.state`

```ts
import { createRPCMiddleware } from '@thednp/rpc/koa';

app.use(async (ctx, next) => {
  ctx.state.user = ctx.session?.user; // koa-session
  await next();
});
app.use(createRPCMiddleware());
```

### h3 — `event.context`

```ts
import { createRPCMiddleware } from '@thednp/rpc/h3';
import { defineEventHandler } from 'h3';

app.use((event, next) => {
  event.context.user = event.context.session?.user;
  return next();
});
app.use(createRPCMiddleware());
```

### Fastify — `decorateRequest` (no `locals` bridge)

```ts
import { createRPCMiddleware } from '@thednp/rpc/fastify';

app.decorateRequest('user', null);
app.addHook('preHandler', (request, _reply, done) => {
  request.user = request.session?.user; // @fastify/session
  done();
});
app.addHook('preHandler', createRPCMiddleware() as never);
```

```ts
// server function — Fastify keeps `locals` empty; read via native request
const event = getRequestContext();
const user = (event.request as { user?: unknown }).user;
```

### Hono — `c.set` / `c.get` (no `locals` bridge)

```ts
import { createMiddleware } from 'hono/factory';
import { createRPCMiddleware } from '@thednp/rpc/hono';

app.use('*', createMiddleware(async (c, next) => {
  c.set('user', c.req.header('x-user'));
  await next();
}));
app.use('*', createRPCMiddleware() as never);
```

```ts
// server function — read via the native Hono Context
const { nativeEvent } = getRequestContext();
const user = (nativeEvent as import('hono').Context).get('user');
```

## Combinators

Since universal middleware is just a function that reads the context, composing several is plain function composition:

```ts
export const compose = (...middlewares: (() => void)[]) => () => {
  for (const mw of middlewares) mw();
};
```

Chain order matters: run **auth** before **rate limiting** so the rate limiter can key on `locals.user?.id` instead of falling back to IP.

## What NOT to Build

- **Body parsing / body limits** — the RPC middleware already reads the body before your function runs. Enforce limits with your framework's body parsers (`express.json({ limit })`, Fastify `bodyLimit`, `assertBodySize` in h3, Hono `body-limit`). See [Best Practices — Body Limits](./best-practices.md#body-limits).
- **Cookie parsing, `x-forwarded-for` expansion, full auth frameworks** — your framework's official middleware already does this better; wrap it as shown above.
- **Pre-dispatch HTTP middleware** (reject before the body is read) — not part of the core. If you need it, register framework middleware before `createRPCMiddleware()`.

> **Next:** [Native Form Fallback](./nojs-fallback.md) — making an RPC endpoint work as a no-JS `<form>` action (progressive enhancement).

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
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
