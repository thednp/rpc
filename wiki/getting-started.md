# Getting Started

> Want a full scaffold from an empty project in under a minute? See the [Quick Start](./quickstart.md) guide instead. This page covers the manual setup from scratch — where files go, how auto-scanning works, and your first server function.

## Installation

```bash
// pnpm + jsr registry
pnpm add jsr:@thednp/rpc
```

```bash
// pnpm + npmjs registry
pnpm add @thednp/rpc
```

```bash
// npm + npmjs registry
npm install @thednp/rpc
```

```bash
// bun + npmjs registry
bun add @thednp/rpc
```

```bash
// deno + npmjs registry
deno add npm:@thednp/rpc
```

```bash
// deno + jsr registry
deno add jsr:@thednp/rpc
```

## Required Project Structure

```
project/
├── src/
│   ├── api/
│   │   ├── index.ts          # All server function exports
│   │   └── server.ts         # Auto-scanned server functions
│   ├── entry-client.ts       # Client entry (SSR projects)
│   └── entry-server.ts       # Server entry (SSR projects)
├── vite.config.ts            # Add rpc() plugin here
├── rpc.config.ts             # Optional config
├── package.json              # The project npm configuration
└── server.js                 # Your Express/Hono/Fastify/Koa server
```

> Various frameworks like `@tanstack-start` or `@sveltejs/kit` prefer a more specific structure, so be sure to check their documentation; most frameworks have their own data transport layer.

## Server Files

The plugin looks in `src/api/` for files with these **exact** names (matching is case-sensitive and non-partial, so `server.tsx`, `my-server.ts`, or `server.txt` are ignored):

- `server.ts`
- `server.js`
- `server.mjs`
- `server.mts`

Each matched file is loaded with `vite.ssrLoadModule`, and all named exports are mapped to client functions. Export each function individually for proper mapping.

> **Alternative: glob mode.** Set `serverFiles: 'glob'` to recursively match `*.server.{ts,js,mjs,mts}` files anywhere under the scan root — useful for feature-based layouts:
>
> ```ts
> // src/api/users.server.ts
> // src/api/upload.server.mts
> export const getUsers = createServerFunction('get-users', async () => [...]);
> export const uploadFile = createServerFunction('upload-file', async () => [...]);
> ```
>
> **Monorepos:** point `scanRoot` at a shared package directory outside the project root, e.g. `scanRoot: '../shared/rpc'`. See [Configuration](./configuration.md).

## Minimal Setup

### 1. Config system-wide configuration `rpc.config.ts`

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  rpcPrefix: "__rpc",
  adapter: "express",
});
```

Currently `@thednp/rpc` supports `'express'`, `'fastify'`, `'hono'` and `'koa'`. See [Adapters](./adapters.md) for the setup of each, and [Configuration](./configuration.md) for all available options.


### 2. Add the plugin to `vite.config.ts`

```ts
import rpc from '@thednp/rpc';

export default {
  plugins: [rpc()],
};
```

Plugin options only apply in development; see [Configuration](./configuration.md).


### 3. Create a server function in `src/api/server.ts`

```ts
import { createServerFunction } from '@thednp/rpc/server';

export const sayHi = createServerFunction(
  'say-hi',
  async (signal: AbortSignal, name: string) => {
    signal.throwIfAborted();
    await new Promise((res) => setTimeout(res, 1500));
    return `Hello ${name}!`;
  },
);
```

Expose it in `src/api/index.ts`

```ts
export * from "./server"
```

Check the [server functions guide](./server-functions.md) for details.

### 4. Use it in your code

```ts
import { sayHi } from './api';

const { data, cancel } = sayHi('World');
const result = await data; // "Hello World!"
// cancel('user cancelled'); cancel anytimes
```

That's it — the plugin auto-scans `src/api/server.ts`, maps exports to client functions, and replaces `./api` imports with fetch-based client modules during the Vite transform.

For a more detailed guide on client-side usage, check the [dedicated wiki section](./client-usage.md).

## How Auto-Scanning Works

1. During Vite's `resolveId` phase, the plugin intercepts imports from `./api` (or paths under `src/api/`).
2. It scans `src/api/` for the server files listed above and loads them via `vite.ssrLoadModule`.
3. It builds a map of export names to their `createServerFunction` registration names.
4. During `transform`, it replaces the import with generated client modules that use `fetch` under the hood.

## SSR vs SPA

### SSR Projects

Either importing server function from `src/entry-client.ts` or `src/entry-server.ts`, the client and server bundles both import from `./api`. On the client your server function gets transformed by the plugin. On the server, `createServerFunction` runs directly (not transformed).

### SPA Projects

Import directly from `./api` in your client code. No server entry is needed.

## Server Setup (Dev & Production)

Use the adapter for your framework to mount the RPC middleware on the front of your server, and attach Vite's dev middleware in development:

```ts
import { attachRPC, attachVite } from '@thednp/rpc/express';
attachVite(app, vite); // development — Vite serves the app and the RPC routes
await attachRPC(app);  // production — mounts createRPCMiddleware() with the rpc.config.ts options
```

`attachRPC`/`attachVite` exist on every adapter — swap the import for your framework. See [Adapters](./adapters.md) for the full server setup of each framework (Express, Fastify, Hono, Koa).

> **Next:** [Configuration](./configuration.md) — all options in `rpc.config.ts` and the Vite plugin.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation, project structure, and your first function
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices