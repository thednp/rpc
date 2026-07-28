# Setup

## Required Project Structure

```
project/
├── src/
│   ├── api/
│   │   └── server.ts        # Auto-scanned server functions
│   ├── entry-client.ts      # Client entry (SSR projects)
│   └── entry-server.ts      # Server entry (SSR projects)
├── vite.config.ts           # Add rpc() plugin here
├── rpc.config.ts            # Optional config
└── package.json
```

## Server Files

The plugin looks in `src/api/` for files matching these names:

- `server.ts`
- `server.js`
- `server.mjs`
- `server.mts`

Each matched file is loaded with `vite.ssrLoadModule`, and all named exports are mapped to client functions. Export each function individually for proper mapping.

## How Auto-Scanning Works

1. During `resolveId`, the plugin intercepts imports from `./api` (or paths under `src/api/`).
2. It scans `src/api/` for the server files listed above and loads them via `vite.ssrLoadModule`.
3. It builds a map of export names to their `createServerFunction` registration names.
4. During `transform`, it replaces the import with generated client modules that use `fetch` API under the hood.

## SSR vs SPA

### SSR Projects

Create both `src/entry-client.ts` and `src/entry-server.ts`. The client bundle imports from `./api`, which gets transformed by the plugin. On the server, `createServerFunction` runs directly (not transformed).

### SPA Projects

Import directly from `./api` in your client code. No server entry is needed.

## Production Adapters

Use the appropriate adapter for your framework:

```ts
// Express
import { attachRPC, attachVite } from '@thednp/rpc/express';
await attachRPC(app);  // production
attachVite(app, vite); // development
```

```ts
// Fastify
import { attachRPC, attachVite } from '@thednp/rpc/fastify';
await attachRPC(app);  // production
attachVite(app, vite); // development
```

```ts
// Hono
import { attachRPC, attachVite } from '@thednp/rpc/hono';
await attachRPC(app);  // production
attachVite(app, vite); // development
```

```ts
// Koa
import { attachRPC, attachVite } from '@thednp/rpc/koa';
await attachRPC(app);  // production
attachVite(app, vite); // development
```

See [Adapters](adapters.md) for full server setup examples.
