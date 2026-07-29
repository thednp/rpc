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

- [Getting Started](../../wiki/getting-started.md)
- [Setup Guide](../../wiki/setup.md)
- [Server Functions](../../wiki/server-functions.md)
- [Client Usage](../../wiki/client-usage.md)
- [Express Adapter](../../wiki/adapters.md#express) (compatible middleware)
- [Configuration](../../wiki/configuration.md)
- [Best Practices](../../wiki/best-practices.md)
- [Security](../../wiki/security.md)
