# SSR Example

Server-Side Rendering application using a custom `node:http` server (Express-compatible middleware) with `@thednp/rpc` for automatic RPC generation. No framework adapter — uses the Express RPC middleware directly.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Vite HMR |
| `pnpm build` | Build client and server for production |
| `pnpm preview` | Build and start production server |
| `pnpm start` | Start production server |

## Dependencies

- `vite` — Dev server and build tool
- `valibot` — Runtime validation

## Resources

- [Getting Started](https://github.com/thednp/rpc/wiki/getting-started.md)
- [Setup Guide](https://github.com/thednp/rpc/wiki/setup.md)
- [Server Functions](https://github.com/thednp/rpc/wiki/server-functions.md)
- [Client Usage](https://github.com/thednp/rpc/wiki/client-usage.md)
- [Express Adapter](https://github.com/thednp/rpc/wiki/adapters.md#express) (compatible middleware)
- [Configuration](https://github.com/thednp/rpc/wiki/configuration.md)
- [Best Practices](https://github.com/thednp/rpc/wiki/best-practices.md)
- [Security](https://github.com/thednp/rpc/wiki/security.md)
