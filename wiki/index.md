# @thednp/rpc

A Vite plugin for creating server-safe Remote Procedure Calls (RPC). Server functions are auto-scanned from a dedicated file and transformed into client-side fetch modules — no manual API route setup.

## What 0.4.x adds

If you are upgrading from 0.4.x, one thing changed shape:

- **One input per function** (0.4.2): handlers are `(signal, input)`, never
  positional — `login(user, pass)` becomes `login({ username: user, password: pass })`.
  The wire is unchanged. See [Migration — From 0.4.x](./migration.md#from-04x).

If you are upgrading from 0.3.x, three things changed behaviour and one is new:

- **Cross-origin protection is on by default** (`origin: "self"`), and requests with neither `Origin` nor `Sec-Fetch-Site` are rejected. This is **breaking** for headerless `curl`/native clients — see [Security — Origin Validation](./security.md#origin-validation) and set `allowHeaderless: true` for those. A browser's native `<form>` navigation sends `Origin` and is checked like any other request.
- **Request bodies are capped** at 10 MiB (`bodyLimit`), on the paths rpc reads itself. Before this the raw-stream path had no cap at all.
- **Input validation via `schema`**, taking any [Standard Schema](https://standardschema.dev) — zod, valibot, arktype, effect — or rpc's dependency-free builder. A rejected input is a `422` naming the field that failed; production keeps `path`/`hint` and drops the validator's own `message`. See [Server Functions — Input Validation](./server-functions.md#input-validation).
- **`onDispatch` is new**: one redacted record per dispatch, with the library retaining nothing. See [Observing Dispatches](./middleware.md#observing-dispatches-ondispatch).

## How to follow this guide

The pages below follow a natural learning sequence — each ends with a **Next** pointer. Every page is self-contained, and the footer links on every page let you jump anywhere anytime.

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation, project structure, and your first function
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Multi-Prefix Support](./multi-prefix-guide.md) — Parallel RPC instances with versioned/namespaced prefixes
- [Middleware](./middleware.md) — Universal middleware via the request context, and handler wrappers for adapter-agnostic `locals`
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Comparison](./comparison.md) — How the cross-origin boundary compares to Next.js, TanStack Start, SvelteKit, and tRPC
- [Best Practices](./best-practices.md) — Tips and best practices
- [Migration](./migration.md) — Upgrading an existing install (0.4.x single-input change, 0.3.x defaults), or coming from another RPC framework
