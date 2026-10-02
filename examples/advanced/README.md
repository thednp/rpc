# Advanced Example — Multi-Prefix + Universal Middleware

Server-Side Rendering (SSR) with Express, showcasing `public:rpc` (rate-limited, audited) + `admin:rpc` (auth-guarded via `x-admin-token`) coexisting under the same `src/api/` with `serverFiles:"glob"`.

> **Security note:** `admin:rpc` is **not** hidden by the prefix. The public client bundle (`rpc.config.ts: public:rpc`) never contains `admin:rpc` stubs (`getClientModules` only emits the config prefix, each `*.server.ts` is replaced in-memory, no files on disk — `src/getClientModules.ts:93`, `src/index.ts:221`), but an attacker can still guess `POST /admin:rpc/get-user`. The example protects it with `requireAdmin` (`src/api/middleware.ts:46`) inside the handler — always enforce auth per privileged prefix, never rely on obscurity. See `wiki/security.md#multi-prefix-client-isolation`.

## Security model in this example

Since 0.4.0 the cross-origin check is **on by default**, so this example's
configuration is mostly a consequence of that rather than a choice.

**`allowHeaderless: true` is set deliberately, and only here.** The default policy
rejects any request carrying neither `Origin` nor `Sec-Fetch-Site`, which is the
right answer for browsers and the wrong one for `verify.mjs` and `curl` — a
scripted caller has no browser provenance to present. That is the documented
opt-in, and this example turns it on so its live assertions can talk to the
server at all.

A real browser never needs it. A native form navigation sends `Origin`, which is
why the built-in `fallback` flow works here without any loosening.

**What the example demonstrates, and you should copy:**

- `public:rpc` and `admin:rpc` are **two prefixes on one server**, each with its
  own middleware and its own function set. A prefix is a routing boundary, not an
  access-control one — see the note above.
- Validation runs at the **boundary**: the same valibot schema per validator, so
  the public and admin paths cannot drift apart, and the handler is entered only
  with validated input.
- Failures are observed through `onDispatch`, which records a `DispatchContext`
  per dispatch and **retains nothing** — the hook owns any storage. A throwing
  hook is ignored rather than allowed to take down the request it describes.

**What it deliberately does not show:** caching (that is TanStack Query's job) and
any rate limiting beyond what a host should provide.

Run `node verify.mjs` for 94 live assertions against a local build — the claims
above are checked, not asserted.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Vite HMR |
| `pnpm build` | Build client and server for production |
| `pnpm preview` | Build and start production server |
| `pnpm start` | Start production server |

## Dependencies

- `express` — HTTP server framework
- `compression` — gzip/brotli compression middleware
- `sirv` — Static file serving
- `valibot` — Runtime validation
- `vite` — Dev server and build tool

## Resources

- [Quick Start](https://github.com/thednp/rpc/blob/master/wiki/quickstart.md) — rebuild this example from `create-vite` in under a minute
- [Getting Started](https://github.com/thednp/rpc/blob/master/wiki/getting-started.md)
- [Wire Protocol](https://github.com/thednp/rpc/blob/master/wiki/wire-protocol.md)
- [Server Functions](https://github.com/thednp/rpc/blob/master/wiki/server-functions.md)
- [Middleware](https://github.com/thednp/rpc/blob/master/wiki/middleware.md)
- [Client Usage](https://github.com/thednp/rpc/blob/master/wiki/client-usage.md)
- [Express Adapter](https://github.com/thednp/rpc/blob/master/wiki/adapters.md#express)
- [Configuration](https://github.com/thednp/rpc/blob/master/wiki/configuration.md)
- [Best Practices](https://github.com/thednp/rpc/blob/master/wiki/best-practices.md)
- [Security](https://github.com/thednp/rpc/blob/master/wiki/security.md)
- [Comparison](https://github.com/thednp/rpc/blob/master/wiki/comparison.md) — how the cross-origin boundary measures against Next.js Server Actions, TanStack Start, SvelteKit, tRPC and Vike
- [Native Form Fallback](https://github.com/thednp/rpc/blob/master/wiki/nojs-fallback.md) — the built-in no-JS `<form>` flow
