# Adapters

`@thednp/rpc` provides adapters for ExpressJS, Fastify, Hono, Koa, and h3. Each adapter exports `attachRPC` for production and `attachVite` for development. Every adapter also exports `redirect` (typed for its native response object) for Post/Redirect/Get flows — see [Redirects](./server-functions.md#redirects-redirect). To write middleware that runs unchanged on every adapter, see [Middleware](./middleware.md).

All adapters dispatch requests against the **prefix-scoped** function map: `createRPCMiddleware({ rpcPrefix })` looks up functions registered under that prefix only (`getFunctionsForPrefix(rpcPrefix)`). This powers [Multi-Prefix Support](./multi-prefix-guide.md) — register separate middleware instances with different prefixes to route versioned/namespaced APIs.

All adapters have an example each, feel free to explore [examples](../examples).

## Common Pattern

All adapters share the same two-function API:

```ts
import { attachRPC, attachVite } from '@thednp/rpc/<adapter>';

// Production: mount RPC middleware
await attachRPC(app);

// Development: mount RPC + Vite middleware
attachVite(app, vite);
```

## Express

### Installation

```bash
// npmjs registry
pnpm add @thednp/rpc express
```

> See [Getting Started](./getting-started.md) for other package managers and the JSR registry.

### Usage

```ts
// server.ts
import express from 'express';
import { attachRPC, attachVite } from '@thednp/rpc/express';
import { createServer } from 'vite';

const app = express();
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(app, vite);
} else {
  await attachRPC(app);
  app.use(express.static('dist'));
}

app.listen(3000);
```

### Body Size Limits

Register the body parser with a size limit before mounting RPC (see [examples/express/server.js](../examples/express/server.js)):

```ts
app.use(express.json({ limit: 1024 * 1024 })); // 1 MB
```

## Fastify

### Installation

```bash
// npmjs registry
pnpm add @thednp/rpc fastify
```

> See [Getting Started](./getting-started.md) for other package managers and the JSR registry.

### Usage

```ts
// server.ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { attachRPC, attachVite } from '@thednp/rpc/fastify';
import { createServer } from 'vite';

const fastify = Fastify({ logger: true });
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(fastify, vite);
} else {
  await attachRPC(fastify);
  fastify.register(fastifyStatic, { root: 'dist' });
}

fastify.listen({ port: 3000 });
```

### Body Size Limits

Set `bodyLimit` when creating the Fastify instance (see [examples/fastify/server.js](../examples/fastify/server.js)):

```ts
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 }); // 1 MB
```

## Hono

### Installation

```bash
// npmjs registry
pnpm add @thednp/rpc hono
```

> See [Getting Started](./getting-started.md) for other package managers and the JSR registry.

### Usage

```ts
// server.ts
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { attachRPC, attachVite } from '@thednp/rpc/hono';
import { createServer } from 'vite';

const app = new Hono();
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(app, vite);
} else {
  await attachRPC(app);
  app.use('*', serveStatic({ root: './dist' }));
}

export default app;
```

### Body Size Limits

Add the built-in `bodyLimit` middleware from `hono/body-limit` (see [examples/hono/server.js](../examples/hono/server.js)):

```ts
import { bodyLimit } from 'hono/body-limit';

app.use('*', bodyLimit({ maxSize: 1024 * 1024 })); // 1 MB
```

## Koa

### Installation

```bash
// npmjs registry
pnpm add @thednp/rpc koa koa-body
```

> See [Getting Started](./getting-started.md) for other package managers and the JSR registry.

### Usage

Body parser must be registered before the RPC middleware:

```ts
// server.ts
import Koa from 'koa';
import { koaBody } from 'koa-body';
import serve from 'koa-static';
import { attachRPC, attachVite } from '@thednp/rpc/koa';
import { createServer } from 'vite';

const app = new Koa();
const isDev = process.env.NODE_ENV !== 'production';

// Body parser must come before RPC middleware
app.use(koaBody({ jsonLimit: 1024 * 1024 })); // 1 MB

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(app, vite);
} else {
  await attachRPC(app);
  app.use(serve('dist'));
}

app.listen(3000);
```

### Body Size Limits

Set `jsonLimit` on `koa-body` (see [examples/koa/server.js](../examples/koa/server.js)):

```ts
app.use(koaBody({ jsonLimit: 1024 * 1024 })); // 1 MB
```

---

## h3

### Installation

```bash
// npmjs registry
pnpm add @thednp/rpc h3
```

> See [Getting Started](./getting-started.md) for other package managers and the JSR registry.

### Usage

```ts
// server.ts
import { H3 } from 'h3';
import { serveStatic, toNodeListener } from 'h3/node';
import { attachRPC, attachVite } from '@thednp/rpc/h3';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

const app = new H3();
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const vite = await createViteServer({ server: { middlewareMode: true } });
  attachVite(app, vite);
} else {
  await attachRPC(app);

  // Static assets served via h3 serveStatic
  app.use(async (event) => {
    return serveStatic(event, { /* ... */ });
  });
}

// Start HTTP server
createServer(toNodeListener(app)).listen(3000);
```

### Body Size Limits

Cap request bodies with h3's native `bodyLimit`/`assertBodySize`, which swap `event.req` for a bounded stream (never consumed up-front), or use a reverse proxy. See [Best Practices — Body Limits](./best-practices.md#body-limits) for the pattern, and the extracted `middleware/bodyLimit.js` in the [h3 example](../examples/h3/middleware/bodyLimit.js).

### Static Assets

The h3 example serves built assets from `dist/client` with an extracted `middleware/serveStatic.js` (aliases h3's `serveStatic` from `h3/node`, adds `Content-Length`, `Last-Modified` and `Cache-Control: public, max-age=31536000, immutable`), registered **after** `createRPCMiddleware()` so asset requests never reach server functions and missing files fall through to the SSR handler.

### Serverless

Serverless environments (Netlify, Vercel, Cloudflare Workers with Node compat, etc.) work with any adapter via the same `createRPCMiddleware` factory. Two rules keep deployments crash-free:

**1. Import `defineConfig` from `@thednp/rpc/config`, never from the main entry.**

`@thednp/rpc` is a Vite plugin and statically imports Vite. A serverless function bundle that transitively imports the main entry (e.g. via `rpc.config.ts` using `defineConfig`) emits a `require("vite")` at cold start — where Vite isn't installed — and crashes with `Cannot find module 'vite'`. The `/config` subpath has zero dependencies:

```ts
// rpc.config.ts
import { defineConfig } from "@thednp/rpc/config";

export default defineConfig({ rpcPrefix: "@demo" });
```

**2. Set the prefix in `src/api/server.ts`, before any `createServerFunction` call.**

ESM static imports are hoisted — `import "./src/api/server.ts"` in your function file executes before any `await loadRPCConfig()` returns. Setting the prefix at the top of the server module itself guarantees every function registers correctly regardless of import order:

```ts
// src/api/server.ts
import { createServerFunction, setGlobalPrefix } from "@thednp/rpc/server";
import cfg from "../rpc.config.ts";
setGlobalPrefix(cfg.rpcPrefix);

export const sayHi = createServerFunction(
  "say-hi",
  async (signal, prop) => {
    // do your thing
  }
);
```

The function handler then imports the server module and mounts middleware with the same config:

```ts
// netlify/functions/rpc.ts
import serverless from "serverless-http";
import { createRPCMiddleware } from "@thednp/rpc/express";
import "../../src/api/server.ts";
import cfg from "../../rpc.config.ts";

const rpc = createRPCMiddleware({ rpcPrefix: cfg.rpcPrefix });
// ... stack + handler
export const handler = serverless(app);
```

See the working example in [demo/netlify/functions/rpc.ts](../demo/netlify/functions/rpc.ts). For Netlify specifically, `[functions] external_node_modules = ["vite"]` in `netlify.toml` keeps Vite out of the function zip as a size optimization.

> **Next:** [Security](./security.md) — the threats the framework handles for you and what it expects you to own.

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
