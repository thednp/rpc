# @thednp/rpc

[![Coverage Status](https://coveralls.io/repos/github/thednp/rpc/badge.svg)](https://coveralls.io/github/thednp/rpc)
[![ci](https://github.com/thednp/rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/thednp/rpc/actions/workflows/ci.yml)
[![NPM Version](https://img.shields.io/npm/v/@thednp/rpc.svg)](https://www.npmjs.com/package/@thednp/rpc)
[![NPM Downloads](https://img.shields.io/npm/dm/@thednp/rpc.svg)](http://npm-stat.com/charts.html?package=@thednp/rpc)

An isomorphic Vite plugin for automatic RPC generation — simple, framework agnostic, and easy to use.

Server functions defined in `src/api/server.ts` run exclusively on the server. The plugin transforms their imports into client-side fetch stubs, so calling a server function from the client looks and feels like a local call — but the execution stays on the server.

The name stands for RPC via Vite, because that's exactly what it is. No more, no less.

## Why this exists

Most RPC solutions ask you to adopt a new way of thinking. You learn a complex API, you organize your code into a specific structure, for sure they are powerful, they work well and provide excelent DX, but complexity comes with its own drawbacks.

`@thednp/rpc` takes the opposite bet: your **server functions should just be functions**. You define them in a file, import and call them where you need them. The plugin handles everything in between — system wide configuration, scanning, type inference, client stub generation, middleware registration, request cancellation — without asking you to restructure your codebase or learn a new DSL (Domain-Specific Language).

### The Mental model
* **Query Engine** — The Brain (something like `@tanstack/react-query` that handles caching, lifecycles, deduplication).
* **@thednp/rpc** — The Nervous System (isomorphic transport, serialization, client/server bridge, request cancellation).
* **UI Framework** — The Muscle (Reactive DOM updates).

## Features

- Framework-agnostic core with adapters for **Express**, **Fastify**, **Hono**, and **Koa**
- Automatic RPC generation — server functions are auto-scanned; client `fetch` based modules are generated at build time
- File-level server code isolation (no `'use server'` directives required)
- System-wide configuration via `rpc.config.ts`
- `AbortController` based request cancellation (via `.cancel()` on the returned handle)
- TypeScript support with generic type inference

## Demos

| Example         | Source Code                                                                    | Try online                                                                               |
| -----------------| --------------------------------------------------------------------------------| ------------------------------------------------------------------------------------------|
| SPA - node:http | [examples/spa](https://github.com/thednp/rpc/tree/master/examples/spa)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/spa)     |
| SSR - node:http | [examples/ssr](https://github.com/thednp/rpc/tree/master/examples/ssr)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/ssr)     |
| Express         | [examples/express](https://github.com/thednp/rpc/tree/master/examples/express) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/express) |
| Fastify         | [examples/fastify](https://github.com/thednp/rpc/tree/master/examples/fastify) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/fastify) |
| Hono            | [examples/hono](https://github.com/thednp/rpc/tree/master/examples/hono)       | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/hono)    |
| Koa             | [examples/koa](https://github.com/thednp/rpc/tree/master/examples/koa)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/koa)     |


## Examples

| Example | Adapter                                       | Type | Run Command        | RPC Approach                              |
| ---------| -----------------------------------------------| ------| --------------------| -------------------------------------------|
| spa     | Vite dev server (Connect, Express-compatible) | SPA  | `pnpm dev`         | Client stubs only                         |
| express | Express                                       | SSR  | `pnpm dev:express` | Direct import (SSR) + client stubs        |
| fastify | Fastify                                       | SSR  | `pnpm dev:fastify` | Direct import (SSR) + client stubs        |
| hono    | Hono                                          | SSR  | `pnpm dev:hono`    | Direct import (SSR) + client stubs        |
| koa     | Koa                                           | SSR  | `pnpm dev:koa`     | Direct import (SSR) + client stubs        |
| ssr     | Custom `node:http` (Express-compatible)       | SSR  | `pnpm dev:ssr`     | Direct import (SSR) + client stubs        |

SSR examples demonstrate isomorphic usage: server functions are imported directly during server-side rendering (`entry-server.ts`) and also called from the client via auto-generated fetch stubs. The SPA example uses only the client-side stubs.

## Quick Start

### 1. Installation

```bash
pnpm add @thednp/rpc@latest
```

### 2. Configuration

Create `rpc.config.ts` at your project root:

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  adapter: "express",
  rpcPreffix: "__rpc",
});
```

Update `vite.config.ts` at your project root:

```ts
import { defineConfig } from 'vite';
import rpc from '@thednp/rpc';

export default defineConfig({
  plugins: [rpc(/* development options */)]
});

```

### 3. Define a server function

Create `src/api/server.ts`:

```ts
import { createServerFunction } from "@thednp/rpc/server";

export const greet = createServerFunction("greet", (signal, name: string) => {
  // access AbortSignal
  signal.throwIfAborted();

  // add validation and other server ONLY functionality

  // return the result of processing
  return `Hello, ${name}!`;
});
```

Create `src/api/index.ts`:

```ts
export * from "./server";
```

### 4. Call it from the client

Import the generated client module in any client-side file:

```ts
// src/app.ts
import { greet } from "./api";

const { data, cancel } = greet("World");
const result = await data; // "Hello, World!"
cancel(); // AbortController-based cancellation
```

### 5. Register the RPC middleware on the server

Import and use the middleware from your chosen adapter package. See the [Adapters guide](./wiki/adapters.md) for full snippets for each framework.

## Testing

### Unit Testing

```bash
pnpm test         # Run tests with coverage
pnpm test-ui      # Run tests with UI
pnpm test --run   # Single run
```

Tests use **Vitest** with **Istanbul** coverage. There are 6 test files covering all adapters plus the plugin.

### Live Testing

```bash
pnpm test-dev     # Runs all examples/<example> in DEV mode and reports their status in a table
pnpm test-prod    # Runs all examples/<example> in PRODUCTION mode and reports their status in a table
```

These tests check the following:
* check if the server runs and doesn't crash
* check if there is any issue generating the HTML
* check if server functions work properly

## Security

- Prefix boundary check via anchored regex — prevents `/__rpc-evil/foo` bypass
- Body size limit: `readBody` caps raw text/plain streams at 1 MiB by default
- Code injection prevention: all interpolated identifiers are validated before client module generation
- Generic error responses — no stack traces or internal details exposed to the client

See [Security](./wiki/security.md) for full details.

## Documentation

- [Getting Started](./wiki/getting-started.md)
- [Setup Guide](./wiki/setup.md)
- [Configuration](./wiki/configuration.md)
- [Server Functions](./wiki/server-functions.md)
- [Client Usage](./wiki/client-usage.md)
- [Adapters](./wiki/adapters.md)
- [Best Practices](./wiki/best-practices.md)
- [Security](./wiki/security.md)

## License

Released under [MIT](LICENSE).
