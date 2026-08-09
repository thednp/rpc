# Client Usage

Server functions, despite their name, work in both server and client side (transformed into `fetch` based modules by our plugin), a perfect fit for isomorphic rendering.

In most cases you will be working with client focused apps.

## Auto-Generated Client Modules

When you import from `./api` in your client code, the plugin intercepts the import and resolves a generated client module for each server function.

```ts
import { sayHi, add } from './api';
```

Each imported function returns:

```ts
{ data: Promise<T>, cancel: (reason: string) => void }
```

- **`data`** — A promise that resolves to the server function's return value.
- **`cancel(reason: string)`** — Aborts the underlying fetch request, causing `signal.aborted` to be set in the server function.

> What actually hits the network (URLs, request/response bodies, status codes) is documented in the [Wire Protocol](./wire-protocol.md) guide — handy for `curl` debugging or native clients.

### Example

```ts
import { sayHi } from './api';

const { data, cancel } = sayHi('World');
const result = await data; // "Hello World!"
cancel('user cancelled'); // triggers AbortController on the client side
```

## Type Safety

Client code keeps **full type inference** — the `TArgs`/`TResult` types from `createServerFunction` flow through to the generated stubs:

```ts
import { addNumbers } from './api';

const { data } = addNumbers(JSON.stringify({ a: 2, b: 3 }));
const result = await data;
// result: { error: {...} | undefined; sum?: undefined }
//       | { sum: number; error?: undefined }

if (result && 'error' in result) {
  result.error; // valibot field errors — type-narrowed
} else {
  result.sum; // number — type-narrowed
}
```

This works because TypeScript resolves `./api` to the real typed server module (via the `src/api/index.ts` re-export), while the Vite plugin swaps in the fetch stubs **only at bundle time**. Your editor and `tsc` see the actual handler signatures; the browser runs the `fetch`-based stubs. The shapes are identical by design: both are `(...args: TArgs) => { data: Promise<TResult>, cancel }`.

> Keep the `src/api/index.ts` re-export as the single import source — importing server modules directly in client code would bypass the plugin's client-module swap.

## Error Handling

- **Fetch errors** (network failure, CORS) — thrown from `await data`
- **HTTP 4xx/5xx responses** — thrown from `await data`; the rejection's `message` is the error string from the response body
- **Validation-as-data** — returned `{ error }` from a server function resolves normally; check `'error' in result` (see [Server Functions](./server-functions.md#input-validation))
- **Cancellation** — aborts the fetch and warns `"Request was cancelled"` in the console

When a server function **throws** (including `RPCError`, see [Server Functions](./server-functions.md#typed-errors-rpcerror)), the client's `data` promise rejects with an `Error` whose `message` is the error string:

```ts
try {
  const { data } = getProfile(userId);
  const profile = await data;
} catch (err) {
  (err as Error).message; // "User not found" (dev) / "Internal Server Error" (prod)
}
```

> In development the 500 response body also carries the `RPCError` `code` and `data` fields, so you can inspect them with the raw fetch in devtools. In production only the generic message is ever sent. The generated client throws a plain `Error` — the `code`/`data` fields are not re-exposed on the rejection.

## Multipart / File Uploads

For functions declared with `contentType: 'multipart/form-data'`, the generated client sends the `FormData` you pass as the first argument — the browser sets the multipart boundary, so don't set `Content-Type`:

```ts
// uploadFile(fields) with contentType: 'multipart/form-data'
const form = new FormData();
form.append('file', fileInput.files[0]);

const { data } = uploadFile(form); // → POST /__rpc/upload-file (multipart/form-data)
```

Server-side, the body must be parsed before your handler sees it (Node has no built-in multipart parser): register your framework's parser (`multer`, `@fastify/multipart`, `koa-body`, Hono's `formData` helpers) **before** the RPC middleware — the adapter then forwards the parsed fields object as the function's first argument. Without a parser, the handler receives `{ raw: <string> }`, which you parse with `busboy`/`formidable` inside the function. See [Wire Protocol — Multipart](./wire-protocol.md#post--multipartform-data).

## @tanstack/react-query Integration

`@thednp/rpc` is a transport pipe — it handles serialization and transport only. For client-side caching, data invalidation, and stale-while-revalidate patterns, use `@tanstack/react-query`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sayHi } from './api';

function GreetUser({ name }: { name: string }) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['say-hi', name],
    queryFn: ({ signal }) => {
      const result = sayHi(name);
      signal.addEventListener('abort', () => result.cancel('query cancelled'));
      return result.data;
    },
  });

  return <div>{data ?? 'Loading...'}</div>;
}
```

Combine `cancel()` with React Query's `signal` for proper abort handling during component unmount or query invalidation.

Other frameworks have a `@tanstack/<framework>-query` made by [Tanstack](https://tanstack.com/).

## SSR Gotcha: Queries Disabled at Server Render

The example apps in this repository keep query libraries optional — the plain SSR examples (`express`, `fastify`, `hono`, `koa`, `ssr`, `spa`) call RPC functions directly and update the DOM when the promise resolves, with no query-framework hydration involved. The `react-query` and `solid-query` examples demonstrate how to integrate `@tanstack/*-query` on top of that.

If you integrate a query library into an SSR setup, be aware of a **disabled-query hang** that only surfaces on the server:

- `@tanstack/solid-query` forces `defaultOptions.experimental_prefetchInRender = true` when `isServer`, which adds a live `promise` field (a `PendingThenable`) to the observer result.
- For a query with `enabled: false`, that thenable is **never settled** (there is no data and no error to finalize it).
- Solid's serializer (seroval) sees the nested pending promise inside the serialized observer result and awaits it forever, so `renderToStringAsync` hangs until its `timeoutMs` fires.

**Reproduction:** any `createQuery(() => ({ ..., enabled: false }))` rendered inside `renderToStringAsync` on the server.

**Workaround:** don't let a disabled query participate in server rendering. Instead of creating the disabled query and calling `refetch()` on a user action, call `queryClient.fetchQuery()` directly from the event handler and keep the result in a plain signal:

```ts
import { createSignal } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import { getServerTime } from "./api";

function TimeForm() {
  const [locale, setLocale] = createSignal("en-US");
  const [time, setTime] = createSignal<string | null>(null);
  const [fetching, setFetching] = createSignal(false);
  const queryClient = useQueryClient();

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setFetching(true);
    queryClient
      .fetchQuery({
        queryKey: ["getServerTime", locale()],
        queryFn: () => getServerTime(locale()).data,
      })
      .then((res) => setTime(res.time))
      .finally(() => setFetching(false));
  };
  // ...
}
```

Because the query is only created on demand (client-side), nothing async is serialized during SSR and `renderToStringAsync` completes normally. The fully working pattern lives in the `solid-query` example app.

> **Next:** [Wire Protocol](./wire-protocol.md) — what these client modules actually send over the network.

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
