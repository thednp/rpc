# Configuration

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

## Config File Discovery

When `configFile` is not specified, the plugin searches for config files in this order:

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
