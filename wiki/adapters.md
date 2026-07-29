# Adapters

`@thednp/rpc` provides adapters for ExpressJS, Fastify, Hono, and Koa. Each adapter exports `attachRPC` for production and `attachVite` for development.

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
pnpm add @thednp/rpc express
```

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

## Fastify

### Installation

```bash
pnpm add @thednp/rpc fastify
```

### Usage

```ts
// server.ts
import Fastify from 'fastify';
import { attachRPC, attachVite } from '@thednp/rpc/fastify';
import { createServer } from 'vite';

const fastify = Fastify({ logger: true });
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(fastify, vite);
} else {
  await attachRPC(fastify);
  fastify.register(require('@fastify/static'), { root: 'dist' });
}

fastify.listen({ port: 3000 });
```

## Hono

### Installation

```bash
pnpm add @thednp/rpc hono
```

### Usage

```ts
// server.ts
import { Hono } from 'hono';
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

## Koa

### Installation

```bash
pnpm add @thednp/rpc koa koa-body
```

### Usage

Body parser must be registered before the RPC middleware:

```ts
// server.ts
import Koa from 'koa';
import { koaBody } from 'koa-body';
import { attachRPC, attachVite } from '@thednp/rpc/koa';
import { createServer } from 'vite';

const app = new Koa();
const isDev = process.env.NODE_ENV !== 'production';

// Body parser must come before RPC middleware
app.use(koaBody({ jsonLimit: 1024 * 1024 }));

if (isDev) {
  const vite = await createServer({ server: { middlewareMode: true } });
  attachVite(app, vite);
} else {
  await attachRPC(app);
  app.use(require('koa-static')('dist'));
}

app.listen(3000);
```
