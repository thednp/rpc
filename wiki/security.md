# Security

What threats `@thednp/rpc` handles for you, and what it expects you to own — prefix guards, CSRF, authentication, body limits, and origin checks.

## Prefix Boundary Check

All adapters use `RegExp` instead of `startsWith` to match the RPC endpoint path. The prefix is escaped with `escapeRegExp()` before being embedded in the boundary regex, preventing ReDoS or unintended matching from metacharacters in the prefix. This prevents path-segment bypass attacks:

```
rpcPrefix = '__rpc'

# Safe: matches /__rpc/foo
// __rpc/foo  →  /__rpc/

# Not matched: /__rpc-evil/foo or /foo/__rpc/bar
```

Using `startsWith` would incorrectly match paths like `/__rpc-evil/foo`, which could route to unintended handlers. The regex ensures the prefix is a standalone path segment.

## Koa URL Normalization

The Koa adapter parses `ctx.url` through `new URL()` before prefix checking. This strips query strings and normalizes encoding, preventing query-string injection attacks:

```ts
const url = new URL(ctx.url, 'http://localhost');
const pathname = url.pathname; // clean, no query string
```

## Generic 404 Responses

Error responses do not echo the requested function name. This prevents function enumeration — an attacker cannot discover available RPC functions by probing for non-existent endpoints.

## Error Responses: Dev vs Production

Handler errors always produce `500 Internal Server Error`, but the response body depends on the environment:

- **Production** (`NODE_ENV === 'production'`): a generic `{ "error": "Internal Server Error" }` — no message, code, or stack is sent to the client. Internals are logged server-side only.
- **Development**: the error message (and for `RPCError` the `code` and optional `data`) are included so developers can identify issues immediately.

```jsonc
// production (any error)
{ "error": "Internal Server Error" }

// development: plain Error
{ "error": "the underlying message" }

// development: RPCError
{ "error": "validation failed", "code": "VALIDATION", "data": { "field": "email" } }
```

**Never set `NODE_ENV=production` implicitly** in dev tooling — the switch is driven by the environment variable alone, so a misconfigured deployment cannot leak internals accidentally. The client's `handleResponse` rejects on any `{ error }` envelope regardless of environment, so error handling code does not need to branch on `NODE_ENV`.

## Duplicate Function Names

Each server function name must be unique — the registration map is keyed by name. During scanning:

- **Development**: a duplicate name throws immediately, failing the dev server startup so the conflict is fixed fast.
- **Production**: a duplicate name logs a warning and the first registration wins.

## HTTP Method Enforcement

Server functions default to `POST`, and the middleware rejects any request whose HTTP method does not match the function's configured method with `405 Method Not Allowed`:

```
GET  /__rpc/do-stuff  →  405  (function defaults to POST)
POST /__rpc/do-stuff  →  200
```

This blocks the simplest CSRF vector: an attacker page embedding `<img src="/__rpc/do-stuff">` or a form `GET` that would otherwise trigger side effects. Functions that opt into `method: "GET"` (via `createServerFunction(name, handler, { method: 'GET' })`) receive their arguments as an `?args=` JSON query parameter. Reserve `GET` for side-effect-free functions only. See [Server Functions Guide](./server-functions.md) for details, and [Wire Protocol](./wire-protocol.md) for the exact request/response encodings.

## Origin Validation

`@thednp/rpc` performs no origin validation by default, but `createRPCMiddleware()` accepts an `origin` option:

```ts
app.use(createRPCMiddleware({ origin: 'https://app.example.com' }));
```

When set, any request carrying an `Origin` header that does not match the configured origin is rejected with `403 Forbidden`. Requests **without** an `Origin` header (curl, native clients) pass through — the check only rejects when the browser-provided header disagrees. This closes the "sibling subdomain" CSRF gap that `SameSite=Lax` cookies alone cannot cover. See [Best Practices — Origin / CSRF Protection](./best-practices.md#origin--csrf-protection) for the full guide and alternatives.

## Authentication via Middleware

Authentication is handled by middleware registered **before** `createRPCMiddleware()`. The middleware chain composes naturally:

```ts
// Express example
app.use(authMiddleware);             // auth first
app.use(createRPCMiddleware());      // RPC second
```

**Do not add auth hooks inside the plugin.** Use your framework's standard middleware pattern. Check [Best Practices Guide](./best-practices.md) for more detailed examples.

## Body Size Limits

JSON/multipart body size limits come from your framework's parser — `express.json({ limit })`, Fastify's `bodyLimit`, `koa-body`, or Hono's `hono/body-limit` — registered **before** `createRPCMiddleware()`. See [Adapters — Body Size Limits](./adapters.md) for the per-framework setup and [Best Practices — Body Limits](./best-practices.md#body-limits) for custom limit handlers.

The `readBody` utility of each adapter reads the raw request stream and does **not** impose a built-in size limit — always register your framework's body-parser middleware (or a custom limit handler) before `createRPCMiddleware()`.

## Input Validation

Server functions receive raw, untrusted client data. Always validate before use. Check [Server Functions Guide](./server-functions.md) for more detailed examples.

> **Next:** [Best Practices](./best-practices.md) — production patterns for auth, rate limiting, body limits, and CSRF.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
