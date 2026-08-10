# React Query Example

Server-Side Rendering (SSR) application using Express, React, and `@tanstack/react-query` with `@thednp/rpc` for automatic RPC generation.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with Vite HMR |
| `pnpm build` | Build client and server for production |
| `pnpm preview` | Build and start production server |
| `pnpm start` | Start production server |

## Dependencies

- `express` — HTTP server framework
- `react` / `react-dom` — UI framework (SSR via `renderToString`, hydration via `hydrateRoot`)
- `@tanstack/react-query` — Data fetching with `useQuery` / `useMutation`
- `compression` — gzip/brotli compression middleware
- `sirv` — Static file serving
- `valibot` — Runtime validation
- `vite` — Dev server and build tool

## Data Fetching

- `useQuery` wraps `sayHi` / `getServerTime`, mapping the RPC `{ data, cancel }` shape to query/mutation functions
- The greeting query is prefetched on the server and dehydrated into the HTML (`window.__REACT_QUERY_STATE__`), then hydrated on the client via `HydrationBoundary`
- `useMutation` handles the `add` form, preserving valibot error rendering and cancellation

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
