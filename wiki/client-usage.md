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
- **HTTP 4xx/5xx responses** — thrown from `await data`. The rejection's `message` is `"Fetch error: " + response.statusText` — the **status text only**. `handleResponse` reads the parsed JSON body so `RPCResponseError` can expose it as `body` (including `issues`/`hint` getters), but the rejection message itself does not carry server text
- **A top-level `error` in a 2xx body** — thrown from `await data` with that string as the message. This is the only path where server-provided text surfaces, and it only happens when the response was already `ok`
- **Validation-as-data** — returned `{ error }` from a server function resolves normally; check `'error' in result`. This is *not* the same as a function's `schema` option, which rejects at the boundary with a `422` and an `RPCResponseError` carrying `status`/`body`/`issues`/`hint` (see [Server Functions](./server-functions.md#input-validation))
- **Cancellation** — rejects the in-flight `fetch` (you get the `AbortError`), it does not resolve

When a server function **throws** (including `RPCError`, see [Server Functions](./server-functions.md#typed-errors-rpcerror)), the response is a `500` — and because that is not `ok`, the rejection carries the generic status text in **both** development and production:

```ts
try {
  const { data } = getProfile(userId);
  const profile = await data;
} catch (err) {
  (err as Error).message; // "Fetch error: Internal Server Error"
}
```

> **This is deliberate, and it is the reason you cannot branch on server error text.** A thrown handler is an *unexpected* failure, so the server returns a generic body (`{ error: "Internal Server Error" }`) and the generated stub never reads it — nothing internal leaks to the browser, in dev or prod. In development the 500 body additionally carries the `RPCError` `code` and `data` fields; you can inspect those in devtools with a raw `fetch`, but they are not re-exposed on the rejection. The `code`/`data` pair is server-side only, and `RPCError` is not a client export.

If you need to *branch* on a failure rather than just report one, model it as data instead of throwing: return `{ error, code }` from the handler with a `200`, and the client resolves it as a value you can discriminate on. That is the difference between the two bullets above.

### Field errors

A function with a [`schema`](./server-functions.md#the-schema-option) rejects with a `400`, and the rejection is an `RPCResponseError` carrying the **normalised** issues the server produced. Three helpers read them, and they are what replace the per-app `getError(error, field)` / `isValiError(error)` pair most projects end up writing:

```ts
import { RPCResponseError, fieldErrorText, fieldErrors } from '@thednp/rpc/helpers';

try {
  const { data } = add({ a: 1, b: 2 });
  await data;
} catch (err) {
  if (err instanceof RPCResponseError && err.status === 422) {
    // every message, keyed by the path that failed
    for (const [path, messages] of Object.entries(fieldErrors(err))) {
      showError(path, messages.join(' '));
    }
    // or one field, ready for textContent — '' when the field passed, so there
    // is no guard at the call site
    emailError.textContent = fieldErrorText(err, 'email');
  }
}
```

| helper | returns |
| --- | --- |
| `fieldErrors(err)` | `Record<string, string[]>`, keyed by the rendered path (`'email'`, `'address.city'`, `''` for a top-level scalar) |
| `fieldErrorText(err, field)` | that field's messages joined, or `''` — safe to assign directly |
| `fieldErrorHint(err, field)` | the field's hint, falling back to the function-wide `hint`; `''` when there is none |

**They are validator-agnostic, and that is the point.** The server normalises every library's issues into `{ path, message, hint? }`, so the same three lines render a zod rejection, a valibot rejection, an arktype rejection or an effect rejection without knowing which produced it. The only difference between the four is the *wording* of the message:

```ts
fieldErrorText(err, 'age');
// valibot:  "Invalid integer: Received 3.7"
// zod:      "Invalid input: expected int, received number"
// arktype:  "age must be an integer (was 3.7)"
// effect:   "Expected an integer, actual 3.7"
```

These work in **production** too. A production rejection carries each issue's `path` and any `hint` you wrote, but not the validator library's `message`, so `fieldErrors` falls back to the hint; an issue with neither still appears as a key with empty text, which is enough to mark an input invalid. `fieldErrorHint` returns the hint in both environments, because a hint is author-written and so was meant to be sent.

A `message`-free production issue means `fieldErrorText` can be empty for a field that genuinely failed — that is the field-with-no-hint case, not a bug. If your form needs per-field prose in production, write `hints` (or `field.string({ hint })` on the builder); that is what they are for. To have full control over the shape, validate with [validation-as-data](./server-functions.md#validation-as-data) and a `200` instead — see [Server Functions](./server-functions.md#validation-as-data).

`RPCResponseError` also exposes `status` and `body` directly, and `issues` / `hint` as getters, so a client that needs something the helpers do not provide can read the raw shape.

## Multipart / File Uploads

For functions declared with `contentType: 'multipart/form-data'`, the generated client sends the `FormData` you pass as the first argument — the browser sets the multipart boundary, so don't set `Content-Type`:

```ts
// uploadFile(fields) with contentType: 'multipart/form-data'
const form = new FormData();
form.append('file', fileInput.files[0]);

const { data } = uploadFile(form); // → POST /__rpc/upload-file (multipart/form-data)
```

Server-side, the body must be parsed before your handler sees it (Node has no built-in multipart parser): register your framework's parser (`multer`, `@fastify/multipart`, `koa-body`, Hono's `formData` helpers) **before** the RPC middleware — the adapter then forwards the parsed fields object as the function's first argument. Without a parser, the handler receives `{ raw: <string> }`, which you parse with `busboy`/`formidable` inside the function. See [Wire Protocol — Multipart](./wire-protocol.md#post--multipartform-data).

## Native HTTP Clients / `unwrapEnvelope<T>`

When building native clients or non-Vite toolchains that don't use the auto-generated fetch stubs, use `unwrapEnvelope<T>` to parse the wire protocol response:

```ts
import { unwrapEnvelope } from '@thednp/rpc/helpers';

const res = await fetch('http://localhost:3000/__rpc/say-hi', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(['World']),
});
const json = await res.json();
if (!res.ok) throw new Error(json.error);  // transport-level failure
const result = unwrapEnvelope<string>(json); // "Hello World!"
```

`unwrapEnvelope` throws when the body carries a **top-level** `error` with no `data` key — the failure shape the server uses for client and server transport errors, including `400`/`403`/`404`/`405`/`409`/`413`/`415`/`422`/`500`:

```ts
import { unwrapEnvelope } from '@thednp/rpc/helpers';

try {
  unwrapEnvelope(await res.json());
} catch (err) {
  (err as Error).message; // "Function not found"
}
```

Two things it deliberately does **not** do:

- **It does not throw for `{ data: { error } }`.** That is a `200` carrying a validation outcome as its result — the validation-as-data contract — and it resolves normally. Only a top-level `error` with no `data` aborts. A function's `schema` option is the other shape: it rejects at the boundary with a `422`, so it *does* throw here (as an `RPCResponseError`), with `issues` and `hint` attached in both development and production (the production body drops only the vendor library's `message`).
- **It is status-code agnostic.** Keep the `res.ok` check; that is what distinguishes a real `200` from a body that merely parses.

> `RPCError` is a **server-side** export (`@thednp/rpc/server`), not a client one — it is not available from `@thednp/rpc/helpers`, and its `code`/`data` are stripped from responses in production regardless.

### How this differs from the generated stubs

The stubs unwrap internally with `handleResponse`, which is **not** identical to `unwrapEnvelope`, and the difference is deliberate:

| | `handleResponse` (stubs) | `unwrapEnvelope` (yours) |
| --- | --- | --- |
| Reads the body | yes | no — you pass it in |
| Checks `res.ok` | yes, throws on any non-OK | no, status-code agnostic |
| `{ error, data }` (both keys) | **throws** on `error` | returns `data` |
| `{ error }` only | throws | throws |

The meaningful row is the third. `handleResponse` tests bare truthiness — `if (result.error)` — while `unwrapEnvelope` requires the `data` key to be absent. So a body carrying *both* keys resolves to `data` for `unwrapEnvelope` and throws for the stubs.

`@thednp/rpc` never emits both keys (a `200` carries `data`, an error response carries `error` alone), so this only shows up with a hand-rolled or proxied body. Reach for `unwrapEnvelope` when you want the conservative reading — the server's `data` wins — and for the stubs when you want the strict one.

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

If you integrate a query library into an SSR setup, be aware of a **disabled-query hang** that only affected `@tanstack/solid-query` below 5.102.0:

- solid-query forced `defaultOptions.experimental_prefetchInRender = true` when `isServer` (since 5.90.7), which added a live `promise` field (a `PendingThenable`) to the observer result.
- For a query with `enabled: false`, that thenable was **never settled** (there is no data and no error to finalize it).
- Solid's serializer (seroval) saw the nested pending promise inside the serialized observer result and awaited it forever, so `renderToStringAsync` hung until its `timeoutMs` fired.

**Reproduction on the old line:** any `createQuery(() => ({ ..., enabled: false }))` rendered inside `renderToStringAsync` on the server (upstream issue [TanStack/query#10907](https://github.com/TanStack/query/issues/10907)).

**Fixed upstream in 5.102.0** ([TanStack/query#11221](https://github.com/TanStack/query/pull/11221)): render-time prefetching and the result `promise` were removed outright, so a disabled `createQuery` renders its idle state on the server like any other query. The `solid-query` example therefore uses the same pattern as the `react-query` one — a disabled query plus `refetch()` on submit:

```ts
import { createSignal } from "solid-js";
import { createQuery } from "@tanstack/solid-query";
import { getServerTime } from "./api";

function TimeForm() {
  const [locale, setLocale] = createSignal("en-US");

  const query = createQuery(() => ({
    queryKey: ["getServerTime", locale()],
    queryFn: () => getServerTime(locale()).data,
    enabled: false,
  }));

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    query.refetch();
  };
  // ...
}
```

If you are pinned below 5.102.0, the old workaround still applies: don't let a disabled query participate in server rendering — call `queryClient.fetchQuery()` from the event handler and keep the result in a plain signal, so nothing async is serialized during SSR.

> **Next:** [Wire Protocol](./wire-protocol.md) — what these client modules actually send over the network.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Multi-Prefix Support](./multi-prefix-guide.md) — Parallel RPC instances with versioned/namespaced prefixes
- [Middleware](./middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Comparison](./comparison.md) — How the cross-origin/CSRF boundary compares to Next.js Server Actions, TanStack Start, SvelteKit, and tRPC
- [Best Practices](./best-practices.md) — Tips and best practices
