# Advanced Example — Multi-Prefix + Universal Middleware

Server-Side Rendering (SSR) with Express, showcasing `public:rpc` (rate-limited, audited) + `admin:rpc` (auth-guarded via `x-admin-token`) coexisting under the same `src/api/` with `serverFiles:"glob"`.

> **Security note:** `admin:rpc` is **not** hidden by the prefix. The public client bundle (`rpc.config.ts: public:rpc`) never contains `admin:rpc` stubs (`getClientModules` only emits the config prefix, each `*.server.ts` is replaced in-memory, no files on disk — `src/getClientModules.ts:93`, `src/index.ts:221`), but an attacker can still guess `POST /admin:rpc/get-user`. The example protects it with `requireAdmin` (`src/api/middleware.ts:46`) inside the handler — always enforce auth per privileged prefix, never rely on obscurity. See `wiki/security.md#multi-prefix-client-isolation`.

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
