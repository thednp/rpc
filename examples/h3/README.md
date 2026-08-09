# h3 Example

Server-Side Rendering (SSR) application using [h3](https://h3.unjs.io/) with `@thednp/rpc` for automatic RPC generation.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Vite HMR |
| `pnpm build` | Build client and server for production |
| `pnpm preview` | Build and start production server |
| `pnpm start` | Start production server |

## Dependencies

- `h3` — HTTP framework (`H3` app + `serveStatic` + `toNodeListener`)
- `valibot` — Runtime validation
- `vite` — Dev server and build tool

## How it works

- **Development**: the whole Vite dev server stack is bridged into h3 via `viteMiddleware`, so dev assets, HMR, and the RPC endpoint (registered on Vite's Connect stack by the plugin) all flow through the Vite dev server.
- **Production**: `createRPCMiddleware` gates the `/__A_server/*` RPC endpoint, `serveStatic` serves `dist/client` assets, and a catch-all handler renders the SSR HTML.
- Server functions live in `src/api/server.ts` and are auto-scanned by the plugin.

## Resources

- [Getting Started](https://github.com/thednp/rpc/blob/master/wiki/getting-started.md)
- [Wire Protocol](https://github.com/thednp/rpc/blob/master/wiki/wire-protocol.md)
- [Server Functions](https://github.com/thednp/rpc/blob/master/wiki/server-functions.md)
- [Client Usage](https://github.com/thednp/rpc/blob/master/wiki/client-usage.md)
- [h3 Adapter](https://github.com/thednp/rpc/blob/master/wiki/adapters.md#h3)
- [Configuration](https://github.com/thednp/rpc/blob/master/wiki/configuration.md)
- [Best Practices](https://github.com/thednp/rpc/blob/master/wiki/best-practices.md)
- [Security](https://github.com/thednp/rpc/blob/master/wiki/security.md)