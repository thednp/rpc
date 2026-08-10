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
    contentType?: 'application/json' | 'text/plain' | 'application/x-www-form-urlencoded' | 'multipart/form-data',
    credentials?: "same-origin" | "include" | "omit",
    method?: "GET" | "POST",
  }
): ServerFunction<T>;
```

### Parameters

- **`name`** (`string`) — The registered name used in RPC routing.
- **`handler`** (`(signal: AbortSignal, ...args: JsonArray) => Promise<T>`) — The actual implementation. The first argument is always an `AbortSignal`; remaining arguments come from the client. The return value must be JSON-serializable.
- **`options`** — Optional credentials, serialization strategy, and HTTP method
  * `contentType?: 'application/json' | 'text/plain' | 'application/x-www-form-urlencoded' | 'multipart/form-data'` - Defaults to `'application/json'`.
  * `credentials?: "include" | "same-origin" | "omit"` - Defaults to `'same-origin'`.
  * `method?: "GET" | "POST"` - Defaults to `'POST'`.

### Content Types

- `'application/json'` (default) — arguments travel as a JSON array in the request body.
- `'text/plain'` — the single argument (or `JSON.stringify` of the args array) travels as plain text.
- `'application/x-www-form-urlencoded'` — designed for native HTML forms: the generated client serializes the single object argument with `new URLSearchParams(args[0]).toString()`, so a `<form>` can POST straight to your RPC endpoint without client-side serialization. Server-side, the adapters parse `key=value&key2=value2` into an object with `URLSearchParams`; if you register your framework's urlencoded parser (`express.urlencoded()`, `@fastify/formbody`, `koa-body`) **before** the RPC middleware, the pre-parsed object is used directly. Each value is a string (repeated keys collapse — see [Wire Protocol — urlencoded](./wire-protocol.md#post--applicationx-www-form-urlencoded)).
- `'multipart/form-data'` — designed for file uploads. The generated client sends the `FormData` you pass as the first argument (the browser sets the boundary — never set `Content-Type` yourself). Server-side, Node has no built-in multipart parser: register your framework's parser middleware (`multer`/`express-fileupload`, `@fastify/multipart`, `koa-body`, or Hono's `hono/body-limit` + `formData` helpers) **before** the RPC middleware, and the adapter forwards the parsed fields object as the function's argument. Without a parser, the raw multipart body arrives as `{ raw: <string> }` — parse it inside the handler with `busboy` or `formidable` (see [Wire Protocol — Multipart](./wire-protocol.md#post--multipartform-data)).

> **Content-type enforcement:** the adapters validate the incoming `Content-Type` against the declared `contentType` before parsing, returning `415 Unsupported Media Type` on a mismatch. JSON and text functions are strict (exact match after stripping `charset`/`boundary`); the two form encodings are interchangeable, so native urlencoded submissions keep working on multipart-declared functions — this is what lets server functions double as the `action` of a nojs `<form>`. Requests with no `Content-Type` header are exempt. The check is available programmatically via `hasContentTypeMismatch`/`isFormContentType` from `@thednp/rpc/server`.

### Generated client module

The plugin generates a fetch-based stub for every server function — `body` and `headers` follow the `contentType`/`method` options:

```ts
import { innerModule } from "@thednp/rpc/helpers";

// contentType: "application/json" (default) — args travel as a JSON array body
export const updateUser = (...args) => {
  const body = JSON.stringify(args);
  const headers = { 'Content-Type': 'application/json' };
  const prefix = "__rpc";
  const name = "update-user";
  const credentials = "same-origin";
  const method = "POST";
  return innerModule(body, headers, credentials, prefix, name, method);
}

// contentType: "text/plain" — the raw first argument travels as text
export const sayHi = (...args) => {
  const body = args[0];
  const headers = { 'Content-Type': 'text/plain' };
  const prefix = "__rpc";
  const name = "say-hi";
  const credentials = "same-origin";
  const method = "POST";
  return innerModule(body, headers, credentials, prefix, name, method);
}

// contentType: "multipart/form-data" — your FormData passes through untouched
export const upload = (...args) => {
  const body = args[0];
  const headers = {}; // ← deliberate: the browser must generate the boundary
  const prefix = "__rpc";
  const name = "upload";
  const credentials = "same-origin";
  const method = "POST";
  return innerModule(body, headers, credentials, prefix, name, method);
}

// contentType: "application/x-www-form-urlencoded" — a plain object becomes form params
export const submitForm = (...args) => {
  const body = new URLSearchParams(args[0]).toString();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const prefix = "__rpc";
  const name = "submit-form";
  const credentials = "same-origin";
  const method = "POST";
  return innerModule(body, headers, credentials, prefix, name, method);
}

// method: "GET" — args travel as the ?args= query parameter, no body at all
export const publicData = (...args) => {
  const body = JSON.stringify(args);
  const headers = {}; // ← deliberate: no body, so no Content-Type
  const prefix = "__rpc";
  const name = "public-data";
  const credentials = "same-origin";
  const method = "GET";
  return innerModule(body, headers, credentials, prefix, name, method);
}
```

The server's body parsing is driven by the request's `Content-Type` header, so the stub only sends it when a body actually needs parsing:

- **`application/json`** is set explicitly so the framework's JSON parser picks the body up.
- **`text/plain`** is set explicitly so text parsers handle the payload.
- **`application/x-www-form-urlencoded`** is set explicitly so the adapter (or the framework's urlencoded parser) decodes the `key=value` pairs into an object.
- **multipart leaves the header empty** — `FormData` carries its own `Content-Type: multipart/form-data; boundary=...` generated by the browser. A hardcoded header without the boundary would make the server's multipart parser (busboy/multer) fail to split the fields.
- **GET leaves the header empty** — there is no body to parse; the server reads the arguments from the `?args=` query parameter regardless of headers.

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

## Redirects (`redirect`)

For **Post/Redirect/Get** (PRG) flows — a native form POST that should bounce the browser to a new URL — use the `redirect` helper instead of hand-writing `statusCode`/`Location`/`end`:

- **Core**: `redirect(res, location, status?)` from `@thednp/rpc/server` — accepts an Express `Response` **or** a raw Node `ServerResponse`. When the response exposes a native `.redirect()`, it delegates to it; otherwise it falls back to writing the status code and `Location` header directly. The raw-node path works on Connect-compatible middlewares and serverless adapters (e.g. Netlify's `serverless-http` mock) whose responses lack `.redirect()`.
- **Per adapter**: `redirect(reply, location, status?)`, `redirect(ctx, location, status?)`, `redirect(c, location, status?)` on the Fastify, Koa, and Hono adapters respectively, typed for each framework's native response object.

All variants default to **`303 See Other`** — the semantically correct code for "the POST succeeded, now GET this page". Fastify's native API takes the URL first (`reply.redirect(url, status)`), Koa requires setting `ctx.status` *after* `ctx.redirect()` (Koa ignores a status set before it, see [koajs/koa#857](https://github.com/koajs/koa/issues/857)), and Hono's must be **returned** from the handler (`return redirect(c, url)`).

```ts
import { redirect } from '@thednp/rpc/server';       // Express/Node
import { redirect } from '@thednp/rpc/express';      // Express adapter
import { redirect } from '@thednp/rpc/fastify';      // FastifyReply
import { redirect } from '@thednp/rpc/koa';          // Koa Context (set ctx.status = 303 after)
import { redirect } from '@thednp/rpc/hono';         // Hono Context → return it from the handler
```

The demo's native form fallback uses this helper for its PRG redirects.

## Request Context (`provideRequestContext`, `getRequestContext`)

Every RPC dispatch establishes a **per-request context** that is available to any code running inside the async tree of that server function. This eliminates the need to thread `req`/`res` (or framework `Context` objects) through every nested call.

The system uses `AsyncLocalStorage` (Node's built-in, stable across module copies and HMR) under a global symbol — mirroring Solid Start's request-event pattern.

### The `RequestEvent` Shape

```ts
interface RequestEvent {
  /** Adapter-specific native event for deep framework access */
  nativeEvent?: unknown;
  /** Adapter request object */
  request: unknown;
  /** Adapter response object */
  response: unknown;
  /** Adapter-bound redirect — sets `redirected` so middleware skips JSON `{ data }` send */
  redirect: (location: string, status?: number) => void;
  /** Set by `redirect` once issued; middleware checks this after `await`ing the handler */
  redirected?: { location: string; status: number };
  /** Adapter-bound short-circuit — writes `status`/`body`/`headers` directly, sets `sent` so the middleware skips the JSON `{ data }` send */
  send: (status: number, body: unknown, headers?: Record<string, string>) => void;
  /** Set by `send` once issued; middleware checks this after `await`ing the handler */
  sent?: { status: number; body: unknown; headers?: Record<string, string> };
  /** Matched RPC function name (e.g. "greet") — useful for per-function rate limiting */
  functionName?: string;
  /** Per-request app data shared across the async tree of the dispatch */
  locals: Record<string, unknown>;
  [prop: string]: unknown;
}
```

Each adapter populates `request`, `response`, and `nativeEvent` with its own types:

| Adapter | `request` | `response` | `nativeEvent` |
|---------|-----------|------------|---------------|
| Express | `Request` | `Response` | `{ req, res }` |
| Fastify | `FastifyRequest` | `FastifyReply` | `request` |
| Hono | `HonoRequest` | `Context` | `c` (the Hono `Context`) |
| Koa | `KoaRequest` | `Context` | `ctx` |
| h3 | `H3Event` | `H3Event` (via `event.res`) | `event` |

### Using the Context in Your Server Functions

```ts
import { createServerFunction, getRequestContext } from '@thednp/rpc/server';

export const getProfile = createServerFunction('get-profile', async (signal, userId) => {
  // Access framework-native objects anywhere in the async call stack
  const { request, response, nativeEvent, locals } = getRequestContext();

  // Example: read a cookie from the Hono context (type via nativeEvent)
  const honoCtx = nativeEvent as import('hono').Context;
  const cookie = honoCtx.req.header('cookie');

  // Example: share data across nested calls via `locals`
  locals.requestId = crypto.randomUUID();

  const user = await db.users.find(userId);
  if (!user) throw new RPCError('Not found', 'NOT_FOUND');
  return user;
});
```

### Deep Async Tree Example

The real power is sharing data through nested service layers without threading context:

```ts
// services/user.ts
import { getRequestContext } from '@thednp/rpc/server';

export async function fetchUserWithPosts(userId: string) {
  const { locals } = getRequestContext();

  // Attach request-scoped data once
  if (!locals.userCache) locals.userCache = new Map();

  if (locals.userCache.has(userId)) return locals.userCache.get(userId);

  const user = await db.users.find(userId);
  if (!user) throw new RPCError('User not found', 'NOT_FOUND');

  // Nested call also has access to the same `locals`
  const posts = await fetchUserPosts(user.id);
  const result = { ...user, posts };
  locals.userCache.set(userId, result);
  return result;
}

async function fetchUserPosts(userId: string) {
  const { locals } = getRequestContext(); // same context, same `locals`
  // logger can read locals.requestId without it being passed down
  logger.info('Fetching posts', { requestId: locals.requestId });
  return db.posts.findByUser(userId);
}
```

### How It Works

1. The adapter's RPC middleware calls `provideRequestContext(init, handler)` around your server function.
2. Inside the handler (or any async descendant), call `getRequestContext()` to read the current `RequestEvent`.
3. The `locals` object is empty at the start of each request — use it to pass data through the async tree (e.g. user identity, request IDs, feature flags).
4. The `redirect` function on `RequestEvent` is bound to the adapter's native redirect; calling it sets `redirected` so the middleware skips the JSON `{ data }` response.
5. The `send` function on `RequestEvent` writes a raw status/body/headers response (e.g. `401`, `429`), sets `sent`, and makes the middleware skip the JSON `{ data }` response — perfect for short-circuiting from shared middleware.

> The `redirect` helper from `@thednp/rpc/server` (and each adapter) is just a thin wrapper around `getRequestContext().redirect(location, status)`. The `sendResponse` helper is the same wrapper around `getRequestContext().send(status, body, headers?)`.

### Writing Universal Middleware

Because `getRequestContext()` works identically across all five adapters, you can write **one** middleware function and use it everywhere — wrap your framework's official middleware (sessions, rate limiting, auth) so it populates `locals` and short-circuits with real status codes via `sendResponse`. See [Middleware](./middleware.md) for the full guide.

### Why Not Pass `req`/`res` Directly?

- **Ergonomics**: Deep call chains (services → repositories → utilities) don't need to accept `req`/`res` parameters.
- **Type safety**: The context is strongly typed per adapter; you get autocomplete for `nativeEvent`.
- **HMR stability**: The `AsyncLocalStorage` lives on a `Symbol.for` global key, surviving Vite HMR module reloads.
- **Framework agnostic**: Same API works across Express, Fastify, Hono, Koa, h3, and the plain Vite dev server.

> **Next:** [Middleware](./middleware.md) — write universal, adapter-agnostic middleware against the request context.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation and quick start
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Middleware](./middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
