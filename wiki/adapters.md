# Adapters

`@thednp/rpc` provides adapters for ExpressJS, Fastify, Hono, and Koa. Each adapter exports `attachRPC` for production and `attachVite` for development. Every adapter also exports `redirect` (typed for its native response object) for Post/Redirect/Get flows — see [Redirects](./server-functions.md#redirects-redirect).

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

> **Next:** [Security](./security.md) — the threats the framework handles for you and what it expects you to own.

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

Use your reverse proxy or a custom middleware to cap body size. h3's `readBody` reads the stream without a built-in limit — see [Best Practices](./best-practices.md).

---

> **Next:** [Security](./security.md) — the threats the framework handles for you and what it expects you to own.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
