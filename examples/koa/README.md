# Koa Example

Server-Side Rendering (SSR) application using Koa with `@thednp/rpc` for automatic RPC generation.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Vite HMR |
| `pnpm build` | Build client and server for production |
| `pnpm preview` | Build and start production server |
| `pnpm start` | Start production server |

## Dependencies

- `koa` — HTTP server framework
- `koa-body` — Body parsing middleware
- `koa-static` — Static file serving
- `koa-connect` — Connect/Express middleware compatibility
- `koa-mount` — Sub-app mounting
- `compression` — gzip/brotli compression middleware
- `sirv` — Static file serving
- `valibot` — Runtime validation
- `vite` — Dev server and build tool

## Resources

- [Getting Started](https://github.com/thednp/rpc/blob/master/wiki/getting-started.md)
- [Wire Protocol](https://github.com/thednp/rpc/blob/master/wiki/wire-protocol.md)
- [Server Functions](https://github.com/thednp/rpc/blob/master/wiki/server-functions.md)
- [Middleware](https://github.com/thednp/rpc/blob/master/wiki/middleware.md)
- [Client Usage](https://github.com/thednp/rpc/blob/master/wiki/client-usage.md)
- [Koa Adapter](https://github.com/thednp/rpc/blob/master/wiki/adapters.md#koa)
- [Configuration](https://github.com/thednp/rpc/blob/master/wiki/configuration.md)
- [Best Practices](https://github.com/thednp/rpc/blob/master/wiki/best-practices.md)
- [Security](https://github.com/thednp/rpc/blob/master/wiki/security.md)
