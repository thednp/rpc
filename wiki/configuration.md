# Configuration

Every option in `rpc.config.ts`, the Vite plugin options (development overrides), and how the plugin discovers your config file.

## `rpc.config.ts`

Create `rpc.config.ts` in your project root for system-wide configuration:

```ts
import { defineConfig } from "@thednp/rpc/config";

export default defineConfig({
  rpcPrefix: '__rpc',
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

> **NOTE** these plugin options apply to **both** `vite dev` and `vite build` — `configResolved` merges them for either command, and the production scan (`buildStart`) and the client-module generation (`transform`) both read them. They override the values in `rpc.config.ts`.

### Options

| Option       | Type     | Default     | Description                                                  |
| --------------| ----------| -------------| --------------------------------------------------------------|
| `rpcPrefix` | `string` | `'__rpc'`   | RPC endpoint prefix used in URL routing. Functions can override this per-call via `createServerFunction(..., { rpcPrefix })` — see [Multi-Prefix Support](./multi-prefix-guide.md) |
| `serverFiles` | `'exact'` \| `'glob'` | `'exact'` | Server file matching mode: `'exact'` for the classic `server.ts\|js\|mjs\|mts` names, `'glob'` to recursively match `*.server.{ts,js,mjs,mts}` under the scan root |
| `scanRoot` | `string` | `undefined` | Directory to scan for server files, relative to the project root. Defaults to `<root>/src/api`. Useful in monorepos where server files live in a shared package |
| `silent` | `boolean` | `false` | Suppress the `NO_CONFIG_FOUND` warning when no config file is found. Useful for wrapper plugins that define server functions directly without a config file |

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

Type-safe helper for creating the config object. Provides autocomplete and type checking for all options. Imported from **`@thednp/rpc/config`** — a Vite-free subpath so config files never drag the plugin (and Vite) into server-side bundles:

```ts
import { defineConfig } from "@thednp/rpc/config";

export default defineConfig({
  rpcPrefix: '__rpc',
});
```

> **Why not from the main entry?** `@thednp/rpc` is a Vite plugin and statically imports Vite. Any server-side file that imports it — including a serverless function bundle that merely reads your config — would require `vite` at runtime and crash where Vite isn't installed. The `/config` subpath has zero dependencies.

### `loadRPCConfig`

Programmatically load the RPC config, useful in custom server setups:

```ts
import { loadRPCConfig } from '@thednp/rpc';

const config = await loadRPCConfig();
console.log(config.rpcPrefix);  // '__rpc'
```

Pass the loaded config straight to the middleware — that is the recommended bootstrap step for regular SSR servers (Express, Fastify, Hono, Koa, h3):

```ts
import { loadRPCConfig } from '@thednp/rpc';
import { createRPCMiddleware } from '@thednp/rpc/express';

const config = await loadRPCConfig();
app.use(createRPCMiddleware({ rpcPrefix: config.rpcPrefix }));
```

`loadRPCConfig` also publishes the prefix globally via `setGlobalPrefix`, so any `createServerFunction` call that follows registers under it. Both sides resolve the prefix the same way — explicit argument first, then the global prefix, then the default — so passing it explicitly is still recommended, but the two can no longer disagree.

If your server functions are registered by direct import rather than by the plugin's scan (serverless, custom hosts), set the prefix in the server module itself before any `createServerFunction` call — see [Adapters — Serverless](./adapters.md#serverless).

Pass `{ silent: true }` to suppress the `NO_CONFIG_FOUND` warning when no config file is found — useful for wrapper plugins that define server functions directly without a config file:

```ts
const config = await loadRPCConfig({ silent: true });
```

Both call forms are accepted: `loadRPCConfig(undefined, { silent: true })` and `loadRPCConfig({ silent: true })` behave identically. A config file that fails to load falls back to the defaults, with a `Failed to load RPC config` warning.

> **Note for serverless environments:** In serverless (Netlify, Vercel, etc.), call `setGlobalPrefix` directly before importing your server files or before defining your server functions — see [Adapters — Serverless](./adapters.md#serverless).

> **Next:** [Server Functions](./server-functions.md) — creating the functions the whole library is built around.

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
- [Comparison](./comparison.md) — How the cross-origin boundary compares to Next.js, TanStack Start, and tRPC
- [Best Practices](./best-practices.md) — Tips and best practices
