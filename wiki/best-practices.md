# Best Practices

## @thednp/rpc is a Transport Pipe

`@thednp/rpc` handles serialization and **transport only**. It does not provide:

- Caching
- Authentication
- Validation
- State management
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

Return validation errors as structured data — the client's `handleResponse` will surface them as an `Error`.

## Authentication

Use middleware before `createRPCMiddleware()`:

```ts
// Express
app.use(authMiddleware);
app.use(createRPCMiddleware());
```

> Never add auth hooks inside the plugin.

## Body Limits

In most cases you can rely on your framework's body-parser middleware:

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
// SSR (custom http server with Vite middleware mode)
import { createMiddleware, readBody } from "@thednp/rpc/express";
import { loadRPCConfig } from "@thednp/rpc";

const config = await loadRPCConfig();
const MAX_BODY_SIZE = 1024 * 1024;

app.use(createMiddleware({
  rpcPreffix: config.rpcPreffix,
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

## SSR Guidance

- On the **server**, `createServerFunction` runs directly (not Vite-transformed).
- On the **client**, the plugin replaces server function calls with `fetch`-based client modules.
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
