# Security

## Prefix Boundary Check

All adapters use `new RegExp(\`^/${rpcPrefix}/\`)` instead of `startsWith` to match the RPC endpoint path. This prevents path-segment bypass attacks:

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
- **Koa**: `koa-body({ formLimit: '1mb' })`
- **Hono**: Built-in body size limiting

Since the RPC framework's `readBody` also accepts `text/plain` requests (not parsed by the JSON body parser), the raw stream path in the Express and Koa adapters has a built-in safety net — a `maxBodySize` parameter that defaults to **1 MiB**. Pass a custom value to `readBody(req, signal, myLimit)` to override.

Register body parsing middleware before `createRPCMiddleware()`.

## Input Validation
Server functions receive raw, untrusted client data. Always validate before use. Check [Server Functions Guide](./server-functions.md) for more detailed examples.
