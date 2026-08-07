# Server Functions

## Overview

Server functions run exclusively on the server. They have access to server-only resources (databases, file system, environment variables, private APIs) and **never execute on the client**.

The `@thednp/rpc` Vite plugin transforms imports of server functions into client-side stubs that call the real implementation over HTTP. This isomorphic bridge means you write your functions once and call them from either server-rendered pages or client-side code — the RPC middleware handles routing on the server while the generated client modules handle serialization, transport, and cancellation.

**The duality, explicitly:** `src/api/server.ts` is *one module with two resolutions*.

1. **At type-check time** — TypeScript (your editor, `tsc`) always resolves `./api` to the real typed server module, so client code gets full inference of arguments and return types.
2. **On the server (SSR)** — Node imports the real module and calls the actual handlers.
3. **In the browser (client bundle)** — the plugin substitutes each function with a `fetch`-based stub; the same import syntax, same signatures, no `fetch` code in your source.

The `src/api/index.ts` re-export is the single import point for all three resolutions. See [Client Usage — Type Safety](./client-usage.md) for how this preserves types, and [Wire Protocol](./wire-protocol.md) for what the stubs send.

All examples except the SPA use SSR to demonstrate this: the same server functions are imported directly during server-side rendering (in `entry-server.ts`) and also called from client-side JavaScript (via the auto-generated fetch module).

The [SPA example](../examples/spa) uses a thin `node:http` based proxy that executes the server functions.

## `createServerFunction(name, handler, options?)`

The core API for defining server-side functions.

### Signature

```ts
function createServerFunction<T>(
  name: string,
  handler: (signal: AbortSignal, ...args: JsonArray) => Promise<T>,
  options?: {
    contentType?: 'application/json' | 'text/plain' | 'multipart/form-data',
    credentials?: "same-origin" | "include" | "omit",
    method?: "GET" | "POST",
  }
): ServerFunction<T>;
```

### Parameters

- **`name`** (`string`) — The registered name used in RPC routing.
- **`handler`** (`(signal: AbortSignal, ...args: JsonArray) => Promise<T>`) — The actual implementation. The first argument is always an `AbortSignal`; remaining arguments come from the client. The return value must be JSON-serializable.
- **`options`** — Optional credentials, serialization strategy, and HTTP method
  * `contentType?: 'application/json' | 'text/plain' | 'multipart/form-data'` - Defaults to `'application/json'`.
  * `credentials?: "include" | "same-origin" | "omit"` - Defaults to `'same-origin'`.
  * `method?: "GET" | "POST"` - Defaults to `'POST'`.

### Content Types

- `'application/json'` (default) — arguments travel as a JSON array in the request body.
- `'text/plain'` — the single argument (or `JSON.stringify` of the args array) travels as plain text.
- `'multipart/form-data'` — designed for file uploads. The generated client sends the `FormData` you pass as the first argument (the browser sets the boundary — never set `Content-Type` yourself). Server-side, Node has no built-in multipart parser: register your framework's parser middleware (`multer`/`express-fileupload`, `@fastify/multipart`, `koa-body`, or Hono's `hono/body-limit` + `formData` helpers) **before** the RPC middleware, and the adapter forwards the parsed fields object as the function's argument. Without a parser, the raw multipart body arrives as `{ raw: <string> }` — parse it inside the handler with `busboy` or `formidable` (see [Wire Protocol — Multipart](./wire-protocol.md#post--multipartform-data)).

### HTTP Method

By default every server function is invoked via `POST`. Functions that are safe to call from a browser URL bar, a `<script>` tag, or a CDN can opt into `GET` — arguments then travel as an `?args=` JSON query parameter:

```ts
export const publicData = createServerFunction(
  'public-data',
  async (signal, topic: string) => {
    return await fetchPublicData(topic);
  },
  { method: 'GET' },
);
```

The generated client module issues a `GET /__rpc/public-data?args=%5B%22news%22%5D` request. The middleware rejects requests whose HTTP method does not match the function's configured method with `405 Method Not Allowed` — so `POST`-only functions are safe from cross-site `GET` requests, and `GET` functions can be linked/bookmarked directly.

> The exact request/response contract (bodies, encodings, status codes) is documented in the [Wire Protocol](./wire-protocol.md) guide.

> **Security note:** defaulting to `POST` prevents CSRF via `<img>`/`<script>`/form `GET` requests. Only set `method: "GET"` for functions with no side effects.

> **Why only `GET` and `POST`?** This is deliberate, not an oversight:
>
> - RPC dispatch is not REST — functions have no resource semantics, so the meanings of `PUT` (idempotent replace), `PATCH` (partial update), or `DELETE` (removal) don't apply to a function call. The only transport distinctions that matter are `POST` (args in the body, any payload) and `GET` (args in the query string, cacheable by browsers and CDNs).
> - `OPTIONS` is reserved by the HTTP protocol for CORS preflight; browsers send it automatically, and frameworks handle it. Exposing it as a function method would collide with framework CORS handling.
> - `HEAD` is derived from `GET` at the HTTP layer, so it needs no function-level support.
> - Every accepted method is another dispatch path to validate. Keeping the surface minimal (and defaulting to `POST`) reduces CSRF and parsing attack surface.
>
> If a concrete need arises (e.g. a REST-style wrapper wanting true `PUT` semantics), the `method` union is a one-line extension — adapters already centralize dispatch on it.

### AbortSignal

The first argument to every server function is an `AbortSignal`. This allows the client to cancel a request:

```ts
export const longTask = createServerFunction(
  'long-task',
  async (signal: AbortSignal, id: string) => {
    signal.throwIfAborted(); // throws if client cancelled
    // ... do work ...
    signal.throwIfAborted(); // check again after each step
    return result;
  },
);
```

Use `signal.aborted` or `signal.throwIfAborted()` in long-running functions to respond to cancellation promptly.

### Registration

When `createServerFunction` is called, it registers the function in a server-side map keyed by `name`. This map is used by the RPC middleware to route incoming requests to the correct implementation.

### Return Type

The return value of `handler` is serialized to JSON and sent as the HTTP response body. **Ensure your return type is JSON-serializable.**

## Input Validation

Server functions receive raw, untrusted client data. **Always validate data within your server functions before use.**

**zod:**

```ts
import { z } from 'zod';
import { createServerFunction } from '@thednp/rpc/server';

const AddSchema = z.object({
  a: z.number(),
  b: z.number(),
});

export const add = createServerFunction('add', async (signal, raw) => {
  const parsed = AddSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.flatten() };
  }
  return parsed.data.a + parsed.data.b;
});
```

**valibot:**

```ts
import * as v from 'valibot';
import { createServerFunction } from '@thednp/rpc/server';

const AddSchema = v.object({
  a: v.number(),
  b: v.number(),
});

export const add = createServerFunction('add', async (signal, raw) => {
  const parsed = v.safeParse(AddSchema, raw);
  if (parsed.issues) {
    return { error: v.flatten(parsed.issues).nested };
  }
  return parsed.output.a + parsed.output.b;
});
```

Validation errors return structured data instead of throwing. The middleware wraps every result in `{ data: ... }`, so a returned `{ error: ... }` arrives as **resolved data** on the client — check `'error' in result`, the promise does not reject. Only transport failures (404/405/500, network errors) reject the client's `data` promise. See [Wire Protocol](./wire-protocol.md) for the exact response envelope.

## Typed Errors (`RPCError`)

For **server-side failures** — not validation, but unexpected errors, failed upstream calls, missing resources — throw `RPCError` instead of returning `{ error }`:

```ts
import { createServerFunction, RPCError } from '@thednp/rpc/server';

export const getProfile = createServerFunction('get-profile', async (signal, userId) => {
  const user = await db.users.find(userId);
  if (!user) {
    throw new RPCError('User not found', 'USER_NOT_FOUND');
  }
  if (!user.isAdmin) {
    throw new RPCError('Insufficient permissions', 'FORBIDDEN', { required: 'admin' });
  }
  return user;
});
```

`RPCError` is exported by the `@thednp/rpc/server` barrel (as is `formatError`, used by the adapters). Its constructor is `new RPCError(message: string, code?: string, data?: unknown)`.

What happens when an `RPCError` (or any error) is thrown:

- **Development**: the response is `500` with body `{ error: "<message>", code: "<code>", data: <data> }` — message and code/data are included so you can debug instantly.
- **Production**: the response is `500` with a generic `{ error: "Internal Server Error" }` — no message, code, or stack traces leak to clients. The server-side log still shows `String(err)` for debugging.

When to use which:

| Situation | Use | Client sees |
| --------- | --- | ----------- |
| Expected user-facing problem (validation, business rule) | `return { error: ... }` | Resolved `data` with `error` key — no rejection |
| Server-side failure (not found, auth, upstream error) | `throw new RPCError(...)` | Rejected `data` promise with the error message |

See [Client Usage](./client-usage.md#error-handling) and [Security](./security.md) for the full picture.

> **Next:** [Client Usage](./client-usage.md) — calling the functions from your client code.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
