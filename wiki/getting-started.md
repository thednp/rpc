# Getting Started

## Installation

```bash
// pnpm + jsr registry
pnpx jsr add @thednp/rpc
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

## Quick Start

For a quick understanding of a project setup check the [dedicated wiki section](./setup.md).

### 1. Configure system wide configuration `rpc.config.ts`

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  rpcPrefix: "__server",
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
cancel('user cancelled');
```

That's it — the plugin auto-scans `src/api/server.ts`, maps exports to client functions, and replaces `./api` imports with fetch-based client modules during the Vite transform.

For a more detailed guide on client-side usage, check the [dedicated wiki section](./client-usage.md).

Next you need to [connect the adapter](./adapters.md) with your server of choice.
