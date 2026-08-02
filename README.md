# @thednp/rpc

[![Coverage Status](https://coveralls.io/repos/github/thednp/rpc/badge.svg)](https://coveralls.io/github/thednp/rpc)
[![ci](https://github.com/thednp/rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/thednp/rpc/actions/workflows/ci.yml)
[![NPM Version](https://img.shields.io/npm/v/@thednp/rpc.svg)](https://www.npmjs.com/package/@thednp/rpc)
[![JSR Version](https://img.shields.io/jsr/v/@thednp/rpc.svg)](https://jsr.io/@thednp/rpc)
[![NPM Downloads](https://img.shields.io/npm/dm/@thednp/rpc.svg)](http://npm-stat.com/charts.html?package=@thednp/rpc)

A Vite plugin for automatic RPC generation — simple, framework agnostic, and easy to use.

## Isomorphic Design

Server functions defined in `src/api/server.ts` run exclusively on the server. The plugin transforms their imports into client-side fetch stubs, so calling a server function from the client looks and feels like a local call — but the actual execution stays on the server.

The server functions run **isomorphically** within any Vite powered runtime.

## Why this exists

Most RPC solutions ask you to adopt a new way of thinking, require learning a complex API, some are vendor locked, some even allow you to blend in with your client code (via `"use server"` directive), for sure they are powerful and work well, they provide excellent DX, but complexity always comes with its own drawbacks.

### Simplicity is best

`@thednp/rpc` takes simplicity very seriously:
<details>
<summary><b>Server functions should just be functions</b></summary>

You define them in a file, import and call them where you need them. The plugin handles everything in between — system wide configuration, scanning, type inference, client stub generation, middleware registration, request cancellation — without asking you to restructure your codebase.
</details>

<details>
<summary><b>The architecture is clean and minimal</b></summary>

* `createFunction.ts` — server-side definition (wrapped handler with `AbortController`)
* `getClientModules.ts` — build-time code generation (string template with validation)
* `helpers.ts` — client-side runtime (thin `fetch` based modules)
* `scanForServerFiles.ts` — file discovery
* **Adapters** — thin middleware wrappers
</details>

### Sound mental model

* **Query Engine** — The Brain (something like `@tanstack/react-query` that handles caching, lifecycles, deduplication).
* **@thednp/rpc** — The Nervous System (isomorphic transport, serialization, client/server bridge, request cancellation).
* **UI Framework** — The Muscle (Reactive DOM updates).

## What you get

<details>
<summary><b>File-level server isolation, without directives</b></summary>

Your server code lives in `src/api/server.ts`. The plugin knows it's server code because of where it lives, not because you annotated it. There's no `'use server'` string to forget, no build error when you accidentally leave it out. The boundary is **the file**. That's it.
</details>

<details>
<summary><b>One config file for everything</b></summary>

The plugin options live in `rpc.config.ts` at your project root. Adapter choice, URL prefix, middleware hooks — it's all in one place. You set it up once and then you don't think about it again.

You can access config system wide by calling `loadRPCConfig()` within your project server-side code.
</details>


<details>
<summary><b>Typed client modules, generated at build time</b></summary>

When you import a server function on the client, the plugin generates a stub that matches your function's exact signature. Change an argument type on the server, and the client types update on the next build. There's no separate codegen command to run, no generated files to commit, no drift between your server and client types.
</details>

<details>
<summary><b>Cancellation should be easy</b></summary>

Every server function call returns a handle with a `cancel()` helper. Under the hood, it's an `AbortController` wired into the fetch request. You don't have to create the controller, pass the signal, or clean up listeners. You just call `cancel()` and the request dies. The server function receives the `AbortSignal` as its first argument, so you can bail out of expensive work early if the client has already moved on.
</details>

<details>
<summary><b>Your server framework is your business</b></summary>

The core plugin doesn't care whether you're running Express, Fastify, Hono, or Koa. Adapters for all four are bundled with the package — you import the one you need, register it as middleware, and you're done. If you're building a plain SPA with no server framework at all, the Vite dev server handles RPC requests directly in development. No adapter needed.
</details>

<details>
<summary><b>TypeScript throughout</b></summary>

Generic type inference flows from your server function's arguments and return type all the way to the client stub. You get autocomplete for function names, argument types, and return types without writing a single type annotation on the client side.
</details>

## Demos

| Example         | Source Code                                                                    | Try online                                                                               |
| -----------------| --------------------------------------------------------------------------------| ------------------------------------------------------------------------------------------|
| SPA - node:http | [examples/spa](https://github.com/thednp/rpc/tree/master/examples/spa)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/spa)     |
| SSR - node:http | [examples/ssr](https://github.com/thednp/rpc/tree/master/examples/ssr)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/ssr)     |
| Express         | [examples/express](https://github.com/thednp/rpc/tree/master/examples/express) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/express) |
| Fastify         | [examples/fastify](https://github.com/thednp/rpc/tree/master/examples/fastify) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/fastify) |
| Hono            | [examples/hono](https://github.com/thednp/rpc/tree/master/examples/hono)       | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/hono)    |
| Koa             | [examples/koa](https://github.com/thednp/rpc/tree/master/examples/koa)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/koa)     |

> **NOTE**: Stackblitz is currently working on upgrading their platform. Demos may not work properly. 

## Examples

| Example | Adapter                                       | Type | Run Command        | RPC Approach                       |
| ---------| -----------------------------------------------| ------| --------------------| ------------------------------------|
| spa     | Vite dev server (Connect, Express-compatible) | SPA  | `pnpm dev`         | Client stubs only                  |
| express | Express                                       | SSR  | `pnpm dev:express` | Direct import (SSR) + client stubs |
| fastify | Fastify                                       | SSR  | `pnpm dev:fastify` | Direct import (SSR) + client stubs |
| hono    | Hono                                          | SSR  | `pnpm dev:hono`    | Direct import (SSR) + client stubs |
| koa     | Koa                                           | SSR  | `pnpm dev:koa`     | Direct import (SSR) + client stubs |
| ssr     | Custom `node:http` (Express-compatible)       | SSR  | `pnpm dev:ssr`     | Direct import (SSR) + client stubs |

SSR examples demonstrate isomorphic usage: server functions are imported directly during server-side rendering (`entry-server.ts`) and also called from the client via auto-generated fetch stubs. The SPA example uses only the client-side stubs.

## Quick Start

### 1. Installation

```bash
// npm/pnpm and jsr
pnpm add jsr:@thednp/rpc
// OR
npx jsr add @thednp/rpc
```

```bash
// deno and jsr
deno add jsr:@thednp/rpc
```

```bash
// pnpm/npm/bun from the npm registry
pnpm add @thednp/rpc
```

```bash
// npm
npm i @thednp/rpc
```

```bash
// bun
bun add @thednp/rpc
```

### 2. Configuration

Create `rpc.config.ts` at your project root:

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  adapter: "express",
  rpcPrefix: "__rpc",
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

Check [Configuration Guide](wiki/configuration.md) for details.

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

Check [Server Functions Guide](./wiki/server-functions.md) for details.

### 4. Call it in your code

Import the function in any client-side or server-side file:

```ts
// src/app.ts
import { greet } from "./api";

const { data, cancel } = greet("World");
const result = await data; // "Hello, World!"
cancel("Client aborted"); // AbortController-based cancellation
```

### 5. Register the RPC middleware on the server

Import and use the middleware from your chosen adapter package.

```ts
// Express
import express from "express";
import { createRPCMiddleware } from "@thednp/rpc/express";

const app = express();
app.use(createRPCMiddleware());

app.listen(3000);
```

See the [Adapters guide](./wiki/adapters.md) for full snippets for each framework.

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

## Contributing

Contributions are welcome. This project uses:

- **pnpm** for package management
- **deno** for linting and formatting
- **tsdown** for bundling
- **vitest** with **istanbul** for testing
- **TypeScript** for type checking

### Development

```bash
pnpm lint         # deno lint + tsc -noEmit
pnpm format       # deno fmt src
pnpm test         # Run tests with coverage
pnpm test-ui      # Run tests with interactive UI 
pnpm build        # Bundle with tsdown
```

All changes should pass `pnpm lint && pnpm format && pnpm test` before submitting. See [AGENTS.md](./AGENTS.md) for the full command reference and project conventions.

## Security

RPC endpoints are, by definition, public surface area. Anything reachable over HTTP can be prodded, poked, and abused. We've tried to close the obvious doors:

<details>
<summary><b>Prefix boundary checking</b></summary>

The URL prefix is validated with an anchored regex, not a simple `startsWith` check. This means a request to `/__rpc-evil/foo` won't accidentally match the `/__rpc` prefix and slip through to your server functions. It sounds like a small thing, but prefix bypass bugs are one of the most common mistakes in middleware-based routing, and they're the kind of thing that only shows up in a security audit at 2am.
</details>

<details>
<summary><b>Code injection prevention</b></summary>

When the plugin generates client modules, it interpolates your function names and type signatures into the generated code. Every identifier is validated before it's written into the output. A server function named `greet; drop table users` won't make it through the generator — it'll fail at build time with a clear error, rather than producing a client module with arbitrary code in it.
</details>

<details>
<summary><b>Generic error responses</b></summary>

When a server function throws, the client receives a clean, generic error message. Stack traces, file paths, database connection strings, and other internal details stay on the server, where they belong. Your server logs get the full error. The client gets `"Internal Server Error"` and nothing more.
</details>

<details>
<summary><b>Body size limits</b></summary>

The `readBody` utility of each adapter doesn't cap raw request bodies by default. You need to use the middleware provided by your server framework of choice.
</details>

<details>
<summary><b>Method restriction (GET/POST only)</b></summary>

Server functions only support `GET` and `POST` (default `POST`). RPC dispatch is not REST — `PUT`/`PATCH`/`DELETE` carry resource semantics that don't apply to function calls, and `OPTIONS` must stay reserved for CORS preflight. Every accepted method is another dispatch path to validate; keeping the surface minimal (and defaulting to `POST`) reduces CSRF and parsing attack surface. See [Server Functions Guide](./wiki/server-functions.md) for details.
</details>

---
The full threat model, including edge cases and configuration options for tightening things further, is documented in [Security](./wiki/security.md).


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

Released under [MIT](./LICENSE).
