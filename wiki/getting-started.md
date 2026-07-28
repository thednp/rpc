# Getting Started

## Installation

```bash
pnpm add @thednp/rpc@latest
```

```bash
npm install @thednp/rpc@latest
```

```bash
bun add @thednp/rpc@latest
```

```bash
deno add npm:@thednp/rpc@latest
```

## Quick Start

### 1. Configure system wide configuration `rpc.config.ts`

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  rpcPreffix: "__server",
  adapter: "express",
});
```

Currently `@thednp/rpc` supports `'express'`, `'fastify'`, `'hono'` and `'koa'`. Check [adapters](./adapters.md) for more guides.
Also check [configuration](./configuration.md) for more guides.


### 2. Add the plugin to `vite.config.ts`

```ts
import rpc from '@thednp/rpc';

export default {
  plugins: [rpc()],
};
```

Check [configuration](./configuration.md) for more guides.


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

### 4. Use it on the client

```ts
import { sayHi } from './api';

const { data, cancel } = sayHi('World');
const result = await data; // "Hello World!"
cancel('user cancelled');
```

That's it — the plugin auto-scans `src/api/server.ts`, maps exports to client functions, and replaces `./api` imports with fetch-based client modules during the Vite transform.
