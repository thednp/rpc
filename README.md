# @thednp/rpc

[![Coverage Status](https://coveralls.io/repos/github/thednp/rpc/badge.svg)](https://coveralls.io/github/thednp/rpc)
[![ci](https://github.com/thednp/rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/thednp/rpc/actions/workflows/ci.yml)
[![NPM Version](https://img.shields.io/npm/v/@thednp/rpc.svg)](https://www.npmjs.com/package/@thednp/rpc)
[![JSR Version](https://img.shields.io/jsr/v/@thednp/rpc.svg)](https://jsr.io/@thednp/rpc)
[![NPM Downloads](https://img.shields.io/npm/dm/@thednp/rpc.svg)](http://npm-stat.com/charts.html?package=@thednp/rpc)

A Vite plugin for automatic RPC generation — write server functions, re-export them, call them. Simple and framework agnostic.

## Isomorphic Design

Server functions defined in `src/api/server.ts` run exclusively on the server. The plugin transforms their imports into client-side fetch stubs, so calling a server function from the client looks and feels like a local call — but the actual execution stays on the server.

The server functions run **isomorphically** within any Vite powered runtime.

## Why this exists

Many RPC solutions like to overcomplicate things to the point where you no longer ship features, you're maintaining a framework. RPC should be a bridge, not a metropolis.

`@thednp/rpc` allows you to supercharge any vite powered SPA/SSR starter template in minutes. To prove it, we made a quick guide to [recreate our Express SSR example](./wiki/quickstart.md).

### Simplicity is best

`@thednp/rpc` takes simplicity very seriously:
<details>
<summary><b>Server functions should just be functions</b></summary>

You define them in a file, import and call them where you need them. The plugin handles everything in between — system wide configuration, scanning, type inference, client fetch modules generation, middleware registration, request cancellation — without asking you to restructure your codebase.
</details>

<details>
<summary><b>The architecture is clean and minimal</b></summary>

* `createFunction.ts` — server-side definition (wrapped handler with `AbortController`)
* `getClientModules.ts` — build-time code generation (string template with validation)
* `client-helpers.ts` — client-side runtime (thin `fetch` based modules)
* `schema.ts` — the `schema` option: any Standard Schema, plus the dependency-free builder
* `body.ts` — body parsing policy and the size cap, shared by all five adapters
* `execution-log.ts` — the `onDispatch` hook and the dispatch record
* `server-helpers.ts` — server-only utilities (`RPCError`, error formatting, `redirect`, glob file walking)
* `validate.ts` — the content-type gate shared by the adapters
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

The core plugin doesn't care whether you're running Express, Fastify, Hono, Koa, or h3. Adapters for all five are bundled with the package — you import the one you need, register it as middleware, and you're done. If you're building a plain SPA with no server framework at all, the Vite dev server handles RPC requests directly in development. No adapter needed.
</details>

<details>
<summary><b>Flexible server file discovery</b></summary>

Scan `src/api/` for classic `server.ts|js|mjs|mts` files, or switch to glob mode (`serverFiles: 'glob'`) to recursively pick up `*.server.{ts,js,mjs,mts}` files — handy for feature-based layouts. A `scanRoot` option points scanning at a shared package directory in monorepos. Duplicate function names throw in development so the conflict is fixed immediately (warning in production).
</details>

<details>
<summary><b>Cross-origin protection, on by default</b></summary>

Since 0.4.0 the `origin` check is **not opt-in**. With no configuration, a foreign
`Origin` is rejected, and a request carrying no browser provenance at all is
`403` too — a check nobody turns on protects nobody. An allowlist *widens*
`"self"` rather than replacing it, so naming an extra origin can never lock you
out of your own site.

It is shared by all five adapters and it fails **closed**: if `Origin` has been
stripped, `Sec-Fetch-Site` is consulted instead, and only `same-origin`/`none`
pass. No forwarded header is ever trusted and there is no `trustProxy` option.

See [Security](./wiki/security.md), and the
[Comparison](./wiki/comparison.md) for how this measures against Next.js Server
Actions, TanStack Start, SvelteKit, tRPC and Vike.
</details>

<details>
<summary><b>A form that works without JavaScript</b></summary>

Set `fallback` on a server function and a native `<form action>` pointing at it gets a
Post/Redirect/Get `303` with the failure as a flash, instead of a `422` JSON body
rendered as raw text. It runs *inside* the dispatch, so it is subject to the
origin check above — unlike an app-layer middleware mounted before it, which
answers a form post from any origin and is a CSRF hole.

Values come back only if you name them: `replay` is an explicit allowlist and
defaults to empty, because a URL reaches history, `Referer` and access logs.

See [Native Form Fallback](./wiki/nojs-fallback.md).
</details>


<details>
<summary><b>Typed errors, safe by default</b></summary>

Server errors return a generic `Internal Server Error` — no messages, codes, or stacks leak to clients, in any environment. Only `RPCError` payloads (developer-authored `message`/`code`/`data`) reach the client, and only in development, so you can debug instantly. `multipart/form-data` content type is supported for file uploads via your framework's multipart parser, and json/text/urlencoded requests are validated against the function's declared content type (`415 Unsupported Media Type` on mismatch; form encodings are interchangeable for nojs form fallbacks).
</details>

<details>
<summary><b>TypeScript throughout</b></summary>

Generic type inference flows from your server function's arguments and return type all the way to the client stub. You get autocomplete for function names, argument types, and return types without writing a single type annotation on the client side.
</details>

<details>
<summary><b>Multi-prefix support</b></summary>

Run multiple RPC instances in parallel. Pass `{ rpcPrefix: "v1:rpc" }` to `createServerFunction` to register a function under a custom prefix — versioned APIs, namespaced endpoints, and API segregation without function-name collisions. The same name can coexist under different prefixes (`v1:rpc/login` + `v2:rpc/login`), middleware dispatches to the prefix-scoped map, and the plugin generates client stubs per prefix. Functions default to `"__rpc"` for full backward compatibility. See the [Multi-Prefix Guide](./wiki/multi-prefix-guide.md).
</details>

<details>
<summary><b>Universal middleware</b></summary>

Write **one** middleware function that runs unchanged on every adapter (Express, Fastify, Hono, Koa, h3). Because every dispatch runs inside a per-request context, middleware written against `getRequestContext()` — reading normalized request data via `getRequestMeta()`, short-circuiting with `sendResponse(status, body, headers)` — behaves identically regardless of the host framework. No per-framework rewrites for cross-cutting RPC rules like per-function rate limiting, audit logging, or feature flags. See the [Middleware Guide](./wiki/middleware.md).
</details>

<details>
<summary><b>Errors that teach, not just complain</b></summary>

A `hint` is the difference between a failure that says what went wrong and one that says what to do about it: `"ids look like u-42"` beats `"Invalid user id"`. Pass it as the fourth argument to `RPCError`, or use the typed subclasses — `NotFoundError`, `ForbiddenError`, `ConflictError` — where it's **required**, because a class whose whole purpose is to explain a failure shouldn't be constructible without the explanation. Each carries a status, so a missing resource is answered `404` rather than `500`. Hints are developer-facing and stripped in production, like `code` and `data`.

Register `onDispatch` and every dispatch is reported with a bounded, redacted record — which function ran and its siblings, which tier of the cross-origin rule decided the request, declared vs actual content type, the **shape** of the arguments and never their values, the status, and how long it took. The library retains nothing: what you pass it to is the storage, and a hook that throws is ignored rather than taking down the request it is describing.
</details>

<details>
<summary><b>Input validation, with no lock-in</b></summary>

Pass a `schema` to any server function and the input is validated **before the handler is entered** — a bad input is a `422`, and your function is never called with it. Any [Standard Schema](https://standardschema.dev) works: zod, valibot, arktype, effect. There's no adapter and no per-library branch in the library, and if you don't want a dependency, `schema()` / `field` build one from rpc's own primitives.

The client stub is typed from the schema's **input** and the handler from its **output**, so a coercing schema lets the browser send `"2"` while your function receives `2` — no cast. A rejection names the failing path and any hints you attached — **in production as well as development**. The only thing production drops is the validator library's own message, because some libraries interpolate the value that failed into it (valibot does; zod and arktype report the type only). A `path` is safe because the caller supplied the field, and a `hint` is safe because you wrote it, so both are sent — and an author who attaches no hints still learns *which* field to fix.
</details>

## Examples

| Source                                                                                 | Demo                                                                                         | Clone                                                   |
| ----------------------------------------------------------------------------------------| ----------------------------------------------------------------------------------------------| ---------------------------------------------------------|
| [examples/spa](https://github.com/thednp/rpc/tree/master/examples/spa)                 | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/spa)         | `pnpm dlx degit thednp/rpc/examples/spa my-app`         |
| [examples/ssr](https://github.com/thednp/rpc/tree/master/examples/ssr)                 | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/ssr)         | `pnpm dlx degit thednp/rpc/examples/ssr my-app`         |
| [examples/express](https://github.com/thednp/rpc/tree/master/examples/express)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/express)     | `pnpm dlx degit thednp/rpc/examples/express my-app`     |
| [examples/fastify](https://github.com/thednp/rpc/tree/master/examples/fastify)         | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/fastify)     | `pnpm dlx degit thednp/rpc/examples/fastify my-app`     |
| [examples/h3](https://github.com/thednp/rpc/tree/master/examples/h3)                   | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/h3)          | `pnpm dlx degit thednp/rpc/examples/h3 my-app`          |
| [examples/hono](https://github.com/thednp/rpc/tree/master/examples/hono)               | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/hono)        | `pnpm dlx degit thednp/rpc/examples/hono my-app`        |
| [examples/koa](https://github.com/thednp/rpc/tree/master/examples/koa)                 | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/koa)         | `pnpm dlx degit thednp/rpc/examples/koa my-app`         |
| [examples/react-query](https://github.com/thednp/rpc/tree/master/examples/react-query) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/react-query) | `pnpm dlx degit thednp/rpc/examples/react-query my-app` |
| [examples/solid-query](https://github.com/thednp/rpc/tree/master/examples/solid-query) | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/solid-query) | `pnpm dlx degit thednp/rpc/examples/solid-query my-app` |
| [examples/advanced](https://github.com/thednp/rpc/tree/master/examples/advanced)       | [StackBlitz](https://stackblitz.com/fork/github/thednp/rpc/tree/master/examples/advanced)    | `pnpm dlx degit thednp/rpc/examples/advanced my-app`    |

> **Clone an example**: `degit` scaffolds a fresh copy straight from the repo — no git history, ready to run:

```bash
# Scaffold the Express example
pnpm dlx degit thednp/rpc/examples/express my-rpc-app
cd my-rpc-app
pnpm install
pnpm dev
```

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
// pnpm/bun from the npm registry
pnpm add @thednp/rpc
```

```bash
// npm
npm i @thednp/rpc
```

### 2. Configuration

Create `rpc.config.ts` at your project root:

```ts
import { defineConfig } from "@thednp/rpc/config";

export default defineConfig({
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
import { createServerFunction, schema, field, RPCError } from "@thednp/rpc/server";

// A `schema` describes the input, so rpc validates it before the handler runs
// and a bad input is a 422 — your function is never entered with one.
const GreetSchema = schema({ name: field.string() });

export const greet = createServerFunction(
  "greet",
  (signal, { name }) => {
    // access AbortSignal
    signal.throwIfAborted();

    // throw typed errors for server-side failures
    if (!name) throw new RPCError("Name is required", "EMPTY_NAME");

    // return the result of processing
    return `Hello, ${name}!`;
  },
  { schema: GreetSchema },
);
```

That example uses rpc's built-in `schema()` so the quickstart adds no dependency. Any [Standard Schema](https://standardschema.dev) works unchanged — swap in zod, valibot, arktype, or effect and the `schema` option stays the same:

```ts
import { z } from "zod";

const GreetSchema = z.object({ name: z.string().min(1) });
```

A rejected input is a **`422`** in both environments — not `400`, which now means only "this request could not be understood". A client can therefore tell a malformed request from a rejected one by status alone.

In production the body still names **which field** failed, plus any `hint` you wrote. The one thing it drops is the validator library's own `message`, and that is deliberate rather than merely cautious: going through the same `~standard.validate` call rpc makes, valibot answers `"Expected string but received 12345"` for a failed `name: 12345`, where zod and arktype report the type only. Whether a message is safe to send depends on which library you picked — and depending on one also ties your error copy to that library's releases. A `path` is safe because the caller supplied the field; a `hint` is safe because you wrote it. So an author who writes `hints` gets them in production for free, and one who writes none still learns *which* field to fix.

`RPCError` is the typed error helper for *server-side* failures — in development its message (and `code`/`data`) reach the client for instant debugging; in production the response is always a generic `Internal Server Error`.

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
pnpm test         # Run tests once with coverage (vitest run --coverage)
pnpm test:watch   # Run tests in watch mode with coverage
pnpm test:ui      # Run tests with UI
```

Tests use **Vitest** with **Istanbul** coverage — 16 test files covering the plugin, scanning, body parsing and limits, the schema, the fallback, the dispatch hook, server/client helpers, request context, the adapter type-export surface, and all five adapters, at 100% coverage.

Two further gates are worth knowing about, because each has caught something the unit tests could not:

```bash
pnpm check:ts5    # Type-checks the examples under a pinned TypeScript 5.9.3
```

The project compiles on TypeScript 7, which passes code an editor bundling TS 5.x rejects — a heavy vendor schema type can blow the inference budget and fail with `TS2589`. This gate exists to catch that, and it is **not** part of `pnpm lint` because it only resolves while the examples point at this repo.

```bash
cd examples/advanced && pnpm verify
```

Drives a live Express server and asserts the library's documented behaviour end to end — the cross-origin matrix, both validation bodies, the option combinations, protocol statuses, typed errors, redaction, roles, and the direct-call path. Two bugs were found this way that 100% line coverage had not, one of them a `bodyLimit` that never applied to the most common content type.

### Live Testing

```bash
pnpm test:dev     # Runs all examples/<example> in DEV mode and reports their status in a table
pnpm test:prod    # Runs all examples/<example> in PRODUCTION mode and reports their status in a table
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
pnpm format       # deno fmt src tests examples/**/src
pnpm test         # Run tests once with coverage (vitest run --coverage)
pnpm test:ui      # Run tests with UI
pnpm build        # Bundle with tsdown (tsdown)
```

All changes should pass `pnpm lint && pnpm format && pnpm test` before submitting. Note the order: `pnpm build` first, because `dist/` is tracked and `tsc` type-checks against it — a stale bundle silently validates the wrong types. See [AGENTS.md](./AGENTS.md) for the full command reference and project conventions.

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

Since 0.4.0 rpc caps request bodies itself — **10 MiB by default**, raised or disabled with the `bodyLimit` middleware option. The cap is enforced *while the body streams*, not after buffering, which is the difference that matters: a `readBody`-then-check shape provides no memory-exhaustion protection at all. Past the cap the remainder is drained and discarded up to a ceiling, so the `413` is deliverable without becoming a slowloris.

It is not redundant with your framework's parser, and the reason was measured rather than assumed: `express.json({ limit })` **declines** urlencoded and multipart, leaves them on the stream, and rpc read that stream uncapped — a 20 MB multipart POST used to return `200` with 20,971,594 bytes buffered.

Two limits worth knowing. A body some *other* layer already buffered cannot be capped, because rpc never reads it — under `@hono/node-server`, and when a host middleware got there first. And Fastify is effectively exempt, because its content-type parser answers before any hook runs; set **Fastify's** `bodyLimit`, not this one. The per-adapter table, with measured behaviour, is in [Security — Body Size Limits](./wiki/security.md#body-size-limits).
</details>

<details>
<summary><b>Method restriction (GET/POST only)</b></summary>

Server functions only support `GET` and `POST` (default `POST`). RPC dispatch is not REST — `PUT`/`PATCH`/`DELETE` carry resource semantics that don't apply to function calls, and `OPTIONS` must stay reserved for CORS preflight. Every accepted method is another dispatch path to validate; keeping the surface minimal (and defaulting to `POST`) reduces CSRF and parsing attack surface. See [Server Functions Guide](./wiki/server-functions.md) for details.
</details>

<details>
<summary><b>Content-type enforcement</b></summary>

Request bodies are validated against the function's declared `contentType` before parsing — mismatches get a `415 Unsupported Media Type`. JSON and text functions require an exact match (after stripping `charset`/`boundary` parameters); the two form encodings are interchangeable so native urlencoded `<form>` submissions keep working on multipart-declared endpoints (nojs progressive enhancement). Requests without a `Content-Type` header are exempt, so curl and `GET` keep working unchanged. See [Wire Protocol](./wiki/wire-protocol.md) for details.
</details>

---
The full threat model, including edge cases and configuration options for tightening things further, is documented in [Security](./wiki/security.md).


## Known limitations

Stated here rather than left for someone to discover in production. Each is a
consequence of a deliberate choice, and each has a workaround.

### ~~A no-JS `<form>` cannot render validation errors~~ — fixed in 0.4.0

**This used to be a limitation, and the guidance was to work around it. Don't
follow that advice any more.** Attaching a `schema` to a function pointed at by a
native `<form>` used to navigate to a `422` carrying a JSON body, which the
browser rendered as raw text — the user saw a wall of JSON instead of their form
with the bad field marked.

A function that sets **`fallback`** now answers a native submission with a
Post/Redirect/Get `303` and the failure as a flash, so the page re-renders with
the field marked. It runs *inside* the dispatch, so it is subject to the
cross-origin check — unlike the app-layer middleware this replaces, which answered
a form post from any origin and was a CSRF hole.

```ts
createServerFunction("contact", handler, {
  contentType: "application/x-www-form-urlencoded",
  schema: schema({ email: field.string() }),
  fallback: { to: "/contact", replay: ["email"] },
});
```

`replay` takes an explicit allowlist and **defaults to empty**, because a URL
reaches browser history, the `Referer` of the next navigation, and every access
log in between. See [Native Form Fallback](./wiki/nojs-fallback.md).


### `multipart/form-data` + `schema` needs a host parser, and the array-root rule

Still true, for the same reason: a `schema` validates `args[0]`, and for multipart
that argument is the `{ raw: <string> }` object rpc passes through (Node has no
built-in multipart parser), so a schema describing your fields rejects it with a
`422` on the path `raw`.

Register a host multipart parser — `multer`, `@fastify/multipart`, `koa-body` —
**before** the RPC middleware and the pre-parsed fields object becomes the
argument, so the schema applies normally.

**Or just use `application/x-www-form-urlencoded`**, which rpc parses itself and
which the demo now uses for *both* clients — the generated stub and a native
`<form>`. That makes it the worked example of why the fallback's discriminator
cannot be the content type: with both clients on one encoding, `Accept` /
`Sec-Fetch-*` are the only thing separating a navigation from an RPC call.

Related: a **root array** is refused outright. `z.array(Item)` / `v.array(Item)`
as the whole payload throws, because everything downstream — `fieldErrors`, the
no-JS flash, a client resolver — needs *named* fields, and an array index cannot
label an input. Wrap it: `{ items: field.custom(z.array(Item)) }`. See
[Server Functions — Input Validation](./wiki/server-functions.md#validated-functions-take-a-single-payload-argument).

### Development and production bodies differ in shape

A rejected input carries each issue's `message` in development and omits it in
production. Making the shapes identical would mean sending vendor messages in
production, which is the thing the split exists to prevent. Clients should read
`path` and `hint`, both of which are sent in either environment — which is what
`fieldErrors` / `fieldErrorText` / `fieldErrorHint` do.

## Fact checks

Claims in this README that could be marketing, with what was actually measured.
Every number below was reproduced against this codebase, not taken from a
framework's own documentation.

| claim | measured |
| --- | --- |
| Bodies are capped, on every adapter | `bodyLimit: 64` with a 4 KB body: h3 → `413`. Hono returned **`200` with the payload parsed** — `bodyLimit` was silently not applied to declared-JSON, because `c.req.json()` reads the stream itself and sits on no capped path. Fixed; JSON now takes the same capped read as h3. |
| A 20 MB multipart POST is not silently buffered | Express with `express.json({ limit: "1mb" })` **declines** urlencoded and multipart, leaving them on the stream; rpc read that stream uncapped and answered `200` with **20,971,594** bytes buffered. Hence the 10 MiB default, enforced *while streaming*. |
| Production bodies are safe to send | valibot returns `"Invalid type: Expected string but received 12345"` — it interpolates the value that failed. zod returns `"Invalid input: expected string, received number"`, type only. Whether a message is safe therefore depends on which library the author picked, so `message` is withheld structurally in production and `path` + `hint` are sent instead. |
| The origin check is stricter than the alternatives | Counted from a request-shape table: **3 stricter, 2 more lenient** against TanStack Start, both leniencies deliberate and named. An earlier draft of the comparison claimed "4 stricter", which its own table did not support. See [Comparison](./wiki/comparison.md). |
| Tests measure behaviour, not just lines | The Hono `bodyLimit` bug shipped at **100% line coverage** — the suite had no `bodyLimit` test at all. Coverage measured that a branch ran, not that it bounded anything. |
| Async validators are not skipped | A runner that read `~standard.validate`'s result synchronously would see `issues === undefined` **on the Promise**, conclude the input was valid, and hand the handler a Promise. Effect's adapter is async, so this is load-bearing; the async shape is pinned in the test suite. |
| A flash can survive a real proxy | The flash URL is **re-requested** by the browser, so it becomes a request line — nginx's default `large_client_header_buffers 4 8k` caps that at 8 KiB. Hence a 4 KiB bound, dropped rather than truncated past it. |

Two claims we deliberately do **not** make. We do not say the origin check is
"as secure as" anything: it is a `Host` comparison, so TLS termination needs no
action but a proxy that rewrites `Host` to another port rejects everything until
you preserve `Host` or name the public origin. And we do not say we do no
validation — `schema` runs in the dispatch before the handler, on the HTTP path
and on direct calls.

## Documentation

- [Quick Start](./wiki/quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./wiki/getting-started.md) — Installation, project structure, and your first function
- [Configuration](./wiki/configuration.md) — Full configuration reference
- [Server Functions](./wiki/server-functions.md) — Creating server functions
- [Multi-Prefix Support](./wiki/multi-prefix-guide.md) — Parallel RPC instances with versioned/namespaced prefixes
- [Middleware](./wiki/middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./wiki/nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action
- [Client Usage](./wiki/client-usage.md) — Client-side usage
- [Wire Protocol](./wiki/wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./wiki/adapters.md) — Framework adapters
- [Comparison](./wiki/comparison.md) — How the cross-origin/CSRF boundary compares to Next.js Server Actions, TanStack Start, SvelteKit, and tRPC
- [Best Practices](./wiki/best-practices.md) — Tips and best practices
- [Security](./wiki/security.md) — Security hardening
- [Migration](./wiki/migration.md) — Upgrading from 0.3.x, or coming from another RPC framework

## License

Released under [MIT](./LICENSE).
