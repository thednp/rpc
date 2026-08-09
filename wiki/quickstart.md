# Quick Start

Rebuild the [Express SSR example](https://github.com/thednp/rpc/tree/master/examples/express) from an empty `create-vite` project — copy-paste ready, done in less than a minute.

> Prefer a plain SPA? See [SPA, no server framework](#spa-no-server-framework) below.

## 1. Scaffold an SSR project

The `ssr-vanilla-ts` template ships Express 5 + `sirv` + `compression` + a custom `node server` — the same shape `@thednp/rpc`'s Express middleware was made for.

```bash
pnpm create vite-extra . --template ssr-vanilla-ts

pnpm install
```

> Other `ssr-*` templates (`ssr-vue-ts`, `ssr-react-ts`, ...) work identically — only the entry files differ.

## 2. Install the library

```bash
pnpm add @thednp/rpc valibot # or your validator of choice
```

## 3. Configuration

Create `rpc.config.ts`:

```ts
import { defineConfig } from "@thednp/rpc";

export default defineConfig({
  rpcPrefix: "__A_server",
  adapter: "express",
});
```

Register the plugin in `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import rpc from "@thednp/rpc";

export default defineConfig({
  plugins: [rpc()],
});
```

## 4. Define the server functions

Create `src/api/server.ts`:

```ts
import { createServerFunction } from "@thednp/rpc/server";
import * as v from "valibot";

export const sayHi = createServerFunction(
  "say-hi",
  async (_signal, name: string) => `Hello ${name}!`,
  { contentType: "text/plain" },
);

const AddSchema = v.object({ a: v.number(), b: v.number() });

export const add = createServerFunction(
  "add-numbers",
  async (signal, formData: string) => {
    const valid = v.safeParse(AddSchema, JSON.parse(formData));
    signal.throwIfAborted();
    if (valid.issues) return { error: v.flatten(valid.issues).nested };
    return valid.output.a + valid.output.b;
  },
);

export const getServerTime = createServerFunction(
  "get-server-time",
  async (_signal, locale: string) => ({
    locale,
    time: new Date().toLocaleTimeString(locale),
    iso: new Date().toISOString(),
  }),
  { method: "GET" },
);
```

Create `src/api/index.ts`:

```ts
export * from "./server";
```

## 5. Wire the middleware in `server.js`

Add `express.json({ limit })` right after the app is created:

```js
const app = express();
app.use(express.json({ limit: 1024 * 1024 }));
```

Then, in the **production** branch, replace the existing middleware block with:

```js
} else {
  const compression = (await import("compression")).default;
  const sirv = (await import("sirv")).default;
  const { loadRPCConfig } = await import("@thednp/rpc");
  const { createRPCMiddleware } = await import("@thednp/rpc/express");
  const { adapter, ...options } = await loadRPCConfig();
  app.use(createRPCMiddleware(options));

  // other middleware
  app.use(compression());
  app.use(base, sirv("./dist/client", { extensions: [] }));
}
```

> The dev server needs **no** RPC setup — the plugin attaches the middleware to Vite's internal Connect/Express server automatically.

## 6. SSR + hydration entries

Replace `src/entry-server.ts`:

```ts
import { sayHi } from "./api";

export async function render(_url: string) {
  const { data: greeting } = sayHi("John Doe");
  const html = `
    <div>
      <h1>Hello World!</h1>
      <p>SSR says: <strong>${await greeting}</strong></p>
      <p>
        <a href="/?get=now">Get server time (GET)</a>
      </p>
    </div>
  `;
  return { html };
}
```

Replace `src/entry-client.ts`:

```ts
import { add, getServerTime, sayHi } from "./api";

// server functions are now fetch-based client modules — same signatures

const { data: greeting } = sayHi("Jane Doe");
greeting.then((msg) => {
  const p = document.createElement("p");
  p.textContent = `Client says: ${msg}`;
  document.body.appendChild(p);
});

const { data: sum } = add(JSON.stringify({ a: 2, b: 3 }));
sum.then((res) => console.log("2 + 3 =", res));

if (new URLSearchParams(location.search).get("get")) {
  const { data: t } = getServerTime("en-US");
  t.then((res) => console.log(res.time, res.iso));
}
```

> `src/api/index.ts` re-exports everything, so `entry-server.ts` (SSR, runs the real functions) and `entry-client.ts` (hydration, gets the generated fetch stubs) import from the same place. See [Client Usage](./client-usage.md).

## 7. Run it

```bash
pnpm dev        # http://localhost:5173 — SSR + HMR
pnpm build      # client + server bundles
pnpm preview    # build + production server with the RPC middleware
```

Open the page: the heading renders server-side via `sayHi`, the client module calls `add` on hydration, and `/add-numbers` / `__A_server/get-server-time` are live RPC endpoints.

> Debugging with `curl` or a native client? The body is a bare JSON array of args (`["World"]`), not `{"data":[...]}` — see the [Wire Protocol](./wire-protocol.md) page for exact request/response formats and copy-paste examples.

---

## SPA, no server framework

A plain Vite SPA needs a tiny **RPC proxy server** because the Vite dev server only serves static assets until the plugin's middleware handles `rpcPrefix` routes. Two options:

1. **Use the `create vite . --template vanilla-ts` command** — start from the official vite SPA starter template and continue with the above steps except Express setup.
2. **Copy [examples/spa](https://github.com/thednp/rpc/tree/master/examples/spa)** verbatim. It runs the Vite dev/preview server and, in preview, boots `server.ts` (a minimal `node:http` proxy) on a side port, forwarding `<prefix>/*` requests via Vite's `preview.proxy`:

```ts
// vite.config.ts (from examples/spa)
if (config.isPreview) {
  const { startProxyServer } = await import("./server.ts");
  await startProxyServer(proxyPort);
}
...
preview: {
  port: 5173,
  proxy: {
    [`/${rpcConfig.rpcPrefix}`]: {
      target: `http://localhost:${proxyPort}`,
      changeOrigin: true,
    },
  },
},
```

In **production**, remember the prefix proxy must point at a real server that registers `createRPCMiddleware()` — the SPA example's `server.ts` is that server.
> **Next:** [Getting Started](./getting-started.md) — the minimal manual setup explained step by step.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
