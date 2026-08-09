# Configuration

Every option in `rpc.config.ts`, the Vite plugin options (development overrides), and how the plugin discovers your config file.

## `rpc.config.ts`

Create `rpc.config.ts` in your project root for system-wide configuration:

```ts
import { defineConfig } from '@thednp/rpc';

export default defineConfig({
  rpcPrefix: '__rpc',
  adapter: 'express',
});
```

## `vite.config.ts`

Update your `vite.config.ts` in your project root and set additional development options:

```ts
import { defineConfig } from 'vite';
import rpc from '@thednp/rpc';

export default defineConfig({
  plugins: [rpc(/* development options */)]
});

```

> **NOTE** these plugin options only apply to **development** and override the options in `rpc.config.ts`.

### Options

| Option       | Type     | Default     | Description                                                  |
| --------------| ----------| -------------| --------------------------------------------------------------|
| `rpcPrefix` | `string` | `'__rpc'`   | RPC endpoint prefix used in URL routing                      |
| `adapter`    | `string` | `'express'` | Target adapter (`'express'`, `'fastify'`, `'hono'`, `'koa'`) |
| `serverFiles` | `'exact'` \| `'glob'` | `'exact'` | Server file matching mode: `'exact'` for the classic `server.ts\|js\|mjs\|mts` names, `'glob'` to recursively match `*.server.{ts,js,mjs,mts}` under the scan root |
| `scanRoot` | `string` | `undefined` | Directory to scan for server files, relative to the project root. Defaults to `<root>/src/api`. Useful in monorepos where server files live in a shared package |

## Config File Discovery

The plugin searches for config files in this order:

1. `rpc.config.ts`
2. `rpc.config.js`
3. `rpc.config.mjs`
4. `rpc.config.mts`
5. `.rpcrc.ts`
6. `.rpcrc.js`

The first file found is used. If none is found, defaults are applied.

## Utilities

### `defineConfig`

Type-safe helper for creating the config object. Provides autocomplete and type checking for all options.

```ts
import { defineConfig } from '@thednp/rpc';

export default defineConfig({
  rpcPrefix: '__rpc',
});
```

### `loadRPCConfig`

Programmatically load the RPC config, useful in custom server setups:

```ts
import { loadRPCConfig } from '@thednp/rpc';

const config = await loadRPCConfig();
console.log(config.rpcPrefix); // '__rpc'
console.log(config.adapter);    // 'express'
```

> **Next:** [Server Functions](./server-functions.md) — creating the functions the whole library is built around.

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
