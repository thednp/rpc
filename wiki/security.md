# Security

## Prefix Boundary Check

All adapters use `new RegExp(\`^/${escapeRegExp(rpcPrefix)}/\`)` instead of `startsWith` to match the RPC endpoint path. The prefix is escaped with `escapeRegExp()` before being embedded in the boundary regex, preventing ReDoS or unintended matching from metacharacters in the prefix. This prevents path-segment bypass attacks:

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

## HTTP Method Enforcement

Server functions default to `POST`, and the middleware rejects any request whose HTTP method does not match the function's configured method with `405 Method Not Allowed`:

```
GET  /__rpc/do-stuff  →  405  (function defaults to POST)
POST /__rpc/do-stuff  →  200
```

This blocks the simplest CSRF vector: an attacker page embedding `<img src="/__rpc/do-stuff">` or a form `GET` that would otherwise trigger side effects. Functions that opt into `method: "GET"` (via `createServerFunction(name, handler, { method: 'GET' })`) receive their arguments as an `?args=` JSON query parameter. Reserve `GET` for side-effect-free functions only. See [Server Functions Guide](./server-functions.md) for details.

## Origin Validation

`@thednp/rpc` performs no origin validation by default, but `createRPCMiddleware()` accepts an `origin` option:

```ts
app.use(createRPCMiddleware({ origin: 'https://app.example.com' }));
```

When set, any request carrying an `Origin` header that does not match the configured origin is rejected with `403 Forbidden`. Requests **without** an `Origin` header (curl, native clients) pass through — the check only rejects when the browser-provided header disagrees. This closes the "sibling subdomain" CSRF gap that `SameSite=Lax` cookies alone cannot cover. See [Best Practices Guide](./best-practices.md) for custom middleware alternatives.

## Authentication via Middleware

Authentication is handled by middleware registered **before** `createRPCMiddleware()`. The middleware chain composes naturally:

```ts
// Express example
app.use(authMiddleware);             // auth first
app.use(createRPCMiddleware());      // RPC second
```

Do not add auth hooks inside the plugin. Use your framework's standard middleware pattern. Check [Best Practices Guide](./best-practices.md) for more detailed examples.

## Body Size Limits

JSON body size limits are handled by your framework's body-parser middleware:

- **Express**: `express.json({ limit: '1mb' })` (default **100kb**)
- **Fastify**: `bodyLimit` option in Fastify config (default **1 MiB**)
- **Koa**: The official `koa-body` library comes with the body size limiting middleware
- **Hono**: Built-in `bodyLimit` from `hono/body-limit` provides body size limiting middleware

The `readBody` utility of each adapter reads the raw request stream and does **not** impose a built-in size limit — always register your framework's body-parser middleware (or a custom limit handler) before `createRPCMiddleware()`. Check [Best Practices Guide](./best-practices.md) for body-limit examples.

## Input Validation
Server functions receive raw, untrusted client data. Always validate before use. Check [Server Functions Guide](./server-functions.md) for more detailed examples.
