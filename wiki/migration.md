# Migrating to `@thednp/rpc` 0.4.x

Three guides, depending on where you are:

- **[From 0.4.x](#from-04x)** — the 0.4.2 calling-convention change: one input
  per function instead of positional arguments.
- **[From 0.3.x](#from-03x)** — an in-place upgrade. Nothing was removed, but
  two defaults changed and one of them will surface as a `403` or a `413`.
- **[From another RPC framework](#from-another-rpc-framework)** — a new setup.

The full change list is in [`CHANGELOG.md`](../CHANGELOG.md). This page is the
part you need in order to not be surprised.

---

## From 0.4.x

Since 0.4.2 every server function takes **one input** — `(signal, input)` —
instead of positional arguments. The wire is unchanged (still a JSON array, now
always of length one), so old and new servers/clients disagree loudly at the
type level rather than silently at runtime. Three edits, all mechanical:

1. **Handlers.** Collapse parameters into one object:
   ```ts
   // before
   async (_signal, username: string, password: string) => { ... }
   // after
   async (_signal, { username, password }: { username: string; password: string }) => { ... }
   ```
   Annotate the input (keep `signal` bare — context still flows to it); an
   unannotated input by itself is fine too, but then it is `JsonValue` and any
   property access needs its own narrowing.
2. **Callers.** Collapse arguments the same way: `login(user, pass)` becomes
   `login({ username: user, password: pass })`. Calling with zero arguments
   still works for input-less functions (`getTime()`); calling a function
   that takes input with zero arguments is a type error, as before.
3. **Native clients.** `getClientStub` takes one input as well; a `FormData`
   input needs an explicit type argument (`getClientStub<FormData>(...)`),
   since `FormData` is not JSON.

What did *not* change: the wire bodies (`[input]`, `?args=[input]`), `args[0]`
validation, the `{ data, cancel }` shape, status codes, the fallback, and
`getClientStub`'s runtime behaviour. A stale old client sending `["a", "b"]`
gets its first element as the input — no crash, but the second element is
dropped, so upgrade both sides together.

---

## From 0.3.x

Nothing was removed from the option types. `MiddlewareOptions` gained
`allowHeaderless`, `bodyLimit` and `onDispatch`; `ServerFunctionOptions` gained
`schema`, `hint` and `hints`; and `origin`'s type was renamed from an inline
`string | string[]` to the exported alias `OriginOption`, which is the same union.
So an upgrade is a version bump plus reading the two sections below.

### 1. Cross-origin protection is now on — this is the one that bites

`createRPCMiddleware` used to check cross-origin requests only if you asked it to.
It now checks by default, and the default is the strictest useful setting:

```ts
// 0.3.x — opt in
app.use(createRPCMiddleware({ origin: "https://app.example.com" }));

// 0.4.0 — the same line still works, and is now the default
app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
```

**What will break:** a request carrying **neither `Origin` nor
`Sec-Fetch-Site`** is answered `403`. Browsers send `Origin`. These do not:

- `curl` and most HTTP clients
- server-to-server calls made with `fetch` from a runtime
- a no-JS `<form>` fallback
- some email clients and crawlers

The rule is three tiers, first signal wins:

| the request carries | what happens |
| --- | --- |
| `Origin` | the policy decides |
| no `Origin`, but `Sec-Fetch-Site` | only `same-origin` and `none` pass |
| neither | **`403`** |

If you have non-browser clients, opt out of that last tier explicitly:

```ts
app.use(createRPCMiddleware({ allowHeaderless: true }));
```

Do that **per instance**, so you keep the check for browsers and only relax it
where you know you need to. It is a narrower change than turning the origin check
off — and there is no switch to turn the check off, by design.

**If your ingress rewrites `Host`**, a browser's `Origin` will name a host the
server no longer sees, and you get a `403` on a same-origin request. Name the
public origin:

```ts
app.use(createRPCMiddleware({ origin: "https://app.example.com" }));
```

Plain TLS termination needs nothing — the scheme is never compared. Do **not**
reach for an `X-Forwarded-Host` workaround; there is deliberately no `trustProxy`
option, because that header is client-influenceable.

An array `origin` **widens** `"self"` rather than replacing it, so your own
domain can never be locked out by a typo in the allowlist:

```ts
origin: ["https://admin.example.com"] // "self" is still allowed
```

Full rules: [Security — Origin Validation](./security.md#origin-validation).

### 2. Bodies over 10 MiB are now `413`

New `bodyLimit` option, `10485760` by default, `0` disables. It is enforced
**while the body streams**, for every content type, on every adapter.

```ts
// Raise it for a file-upload endpoint
app.use(createRPCMiddleware({ bodyLimit: 50 * 1024 * 1024 }));

// or turn rpc's cap off and rely entirely on the host
app.use(createRPCMiddleware({ bodyLimit: 0 }));
```

**What will break:** an upload that used to succeed at 12 MB and now returns
`413 Payload Too Large`. This is most likely to bite multipart and urlencoded
uploads, which a host parser like `express.json({ limit })` does not claim — so
those were previously uncapped rather than capped, which is exactly why rpc grew
a limit of its own.

**Fastify users:** set **Fastify's** `bodyLimit`, not rpc's. Fastify's own
content-type parser answers before any hook runs, so it always wins.

**Two cases rpc cannot cap**, because the body is already in memory by the time
the RPC middleware sees it: under `@hono/node-server`, and when a host middleware
has already read the body. In both, the host's own limit is what bounds the
upload. Per-adapter table: [Security — Body Size Limits](./security.md#body-size-limits).

### 3. Hono users: oversized JSON is now correctly rejected

Not a change you asked for, but one that will reach you if you are on Hono.
Previously `bodyLimit` did not apply to declared-JSON bodies on Hono, so a JSON
body far over the limit returned `200` with the payload parsed. It now returns
`413`, consistent with every other adapter. If you were relying on large JSON
bodies getting through, raise `bodyLimit` or set it to `0`.

### 4. Optional: add a `schema`

**New**, and the point of the release. Not required, and nothing changes until you
opt in.

```ts
import { createServerFunction } from "@thednp/rpc/server";
import * as v from "valibot";

const AddSchema = v.object({
  a: v.pipe(
    v.union([v.string(), v.number()]),
    v.transform(Number),
    v.number()
  ),
  b: v.pipe(
    v.union([v.string(), v.number()]),
    v.transform(Number),
    v.number()
  ),
});

export const add = createServerFunction("add", async (signal, { a, b }) => {
  signal.throwIfAborted();
  return a + b;
}, { schema: AddSchema, hint: "a and b are numbers" });
```

Three things worth knowing before you adopt it:

- **Only `args[0]` is validated.** Use one object argument rather than
  positional ones — `login(username, password)` validates the username and not
  the password. A schema on a handler declaring more than one argument logs a
  development warning.
- **It runs on direct calls too**, not just over HTTP. A function called from
  your SSR entry, or from a test, is validated. That is deliberate: the schema's
  transforms have to run whichever way you call it, or the same function behaves
  differently depending on who invoked it.
- **A rejected input is `422`, not `400` — and production is no longer a bare
  `{ error: "Bad Request" }`.** If any client branches on `res.status === 400` to
  detect a validation failure, it will silently stop recognising one; branch on
  `422` instead. In production the body now carries `code: "VALIDATION"` and each
  issue's `path` (and any `hint` you wrote), so field-level errors survive to
  production. The one thing it does not carry is the validator library's
  `message`, because some libraries interpolate the value that failed into it —
  valibot does, zod and arktype do not — and depending on that text also ties
  your error copy to that library's releases.

Any Standard Schema works — zod, valibot, arktype, effect. If a heavy vendor
type trips TypeScript 5.x with `TS2589`, wrap it in `schema.from(...)`. Details:
[Server Functions — Input Validation](./server-functions.md#input-validation).

### 5. Optional: turn failures into teaching errors

`hint` is developer-facing advice about how to fix a failure, and the typed
subclasses carry a status so a missing resource is a `404` rather than a `500`:

```ts
import { NotFoundError } from "@thednp/rpc/server";

export const getUser = createServerFunction("get-user", async (signal, id) => {
  const user = await db.find(id);
  if (!user) throw new NotFoundError("no such user", "ids look like u-42");
  return user;
});
```

Hints, `code` and `data` are stripped in production. For the client side,
`fieldErrors` / `fieldErrorText` / `fieldErrorHint` render any library's issues
the same way: [Client Usage — Field Errors](./client-usage.md).

### 6. Optional: observe dispatches

```ts
app.use(createRPCMiddleware({
  onDispatch: (ctx) => {
    // ctx.originTier, ctx.functionName, ctx.argShape, ctx.status, ctx.durationMs
    logger.info(ctx);
  },
}));
```

The library retains nothing — no buffer, no ring, no TTL — so where this goes is
your decision. `argShape` never captures argument values, which matters because
arguments routinely carry passwords. The correlation `id` appears on failure
bodies only when a hook is registered, so registering one does not change
successful responses. See
[Observing Dispatches](./middleware.md#observing-dispatches-ondispatch).

### 7. Optional: the no-JS `<form>` fallback moved into the library

Not a breaking change — but if you wrote your own fallback, **delete it.**

Most projects that supported no-JS forms ended up with an app-layer middleware
mounted *before* the RPC middleware, which is the arrangement that **bypasses the
cross-origin check** you just turned on in step 1. That middleware answers a form
post from any origin, so it reintroduces the exact CSRF hole rpc now closes. The
built-in runs inside the dispatch, so it is checked like everything else.

```diff
-const formFallback = createFormFallback({ rpcPrefix, functionName: "contact" });
-const stack = [bodyLimit, formFallback, rpc];
+const stack = [bodyLimit, rpc];
```

```ts
createServerFunction("contact", handler, {
  contentType: "application/x-www-form-urlencoded",
  schema: schema({ email: field.string() }),
  fallback: { to: "/contact", replay: ["email"] },
});
```

Then read the flash where you used to read your own query string. `decodeFormFlash`
is client-safe, so the same function serves SSR and the browser:

```diff
-const errors = new URLSearchParams(location.search).get("errors")?.split(",") ?? [];
+import { FLASH_PARAM, decodeFormFlash } from "@thednp/rpc/flash";
+const flash = decodeFormFlash(new URLSearchParams(location.search).get(FLASH_PARAM));
+const errors = flash?.errors ? Object.keys(flash.errors) : [];
```

**Two behaviours worth knowing before you delete yours:**

- **Replay is opt-in.** Your middleware probably replayed every submitted field
  back into the URL. `replay` takes an explicit allowlist and defaults to empty,
  because a URL reaches history, `Referer` and access logs. Name the fields you
  actually want back.
- **A `schema` failure now flashes.** If your function validated inside the handler
  and returned errors as data, that still works unchanged — the fallback reflects
  thrown `RPCError`s and `schema` rejections, not returned values. Moving
  validation onto a `schema` is what opts you into per-field flashes.

If your old middleware sanitised the redirect target, keep that instinct: `fallback.to`
is restricted to root-relative paths for exactly that reason. If you need an
off-origin success target, call `redirect()` from the request context in the
handler — it takes precedence over the fallback.

See [Native Form Fallback](./nojs-fallback.md).

---

## From another RPC framework

If you are coming from Next.js Server Actions, TanStack Start, SvelteKit form
actions, tRPC or Telefunc, the mechanics are the same but the shape is different.

### What you get

- **A transport, not a framework.** You keep your HTTP server and mount one
  middleware. Express, Fastify, Hono, Koa and h3 are all supported by the same
  `createRPCMiddleware` API — no framework types in your function signatures.
- **One module of functions.** `src/api/server.ts` is auto-scanned; there is no
  route file to maintain and no router to learn.
- **Cross-origin protection on by default**, which is the thing you would
  otherwise be configuring in every framework listed above. It compares your own
  `Host`, so a correct deployment needs no origin configuration at all.
- **Validation that runs before your code**, on any Standard Schema, with the
  handler typed from the schema's output — so a coercing schema needs no cast.
- **A capped body on every path**, enforced while streaming.

### What you give up

Be clear-eyed about this; the honest summary is in
[Comparison — Where the trade costs you](./comparison.md#where-the-trade-costs-you).

- **Requests with no browser provenance need an opt-in.** `curl` and native clients
  must set `allowHeaderless: true`; a browser's native `<form>` navigation sends
  `Origin`, so the built-in no-JS fallback does not need it. Every framework above
  lets headerless clients through silently.
- **A rewritten `Host` is a `403` until you name the public origin.** No
  `trustProxy` switch, on purpose.
- **No batching.** If you are moving *to* reduce round-trips, this is the wrong
  direction. tRPC and TanStack Start both batch.
- **No built-in caching.** Deliberately — server-side caching is
  `@tanstack/react-query`'s job, and pretending otherwise is how a cache becomes
  a correctness problem. The
  [react-query example](../examples/react-query) shows the intended shape.
- **No auth, no rate limiting, no security headers.** Middleware before
  `createRPCMiddleware()`, as with anything else in the stack.
- **Literal origins only** — no `*.example.com` wildcards.

### Getting started

1. Install the plugin and the adapter for your server, and add
   [the plugin](../README.md#quick-start) to `vite.config.ts`.
2. Put a function in `src/api/server.ts` using
   [`createServerFunction`](./server-functions.md).
3. Mount `createRPCMiddleware` **before** your auth middleware's handlers but
   **after** anything that must not see RPC traffic.
4. Call the function through the auto-generated client module. On the server it
   is the real handler; in the browser it is a `fetch` stub with an
   `AbortController`.
5. Add a [`schema`](./server-functions.md#input-validation) to every function
   that takes input.
6. If anything answers `403` unexpectedly, the `onDispatch` hook will tell you
   which tier decided.

`[Quick Start](./quickstart.md)` rebuilds a working Express SSR app from
`create-vite` in a few minutes, and the `[Examples](../examples)` directory has
one app per adapter.

---

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `403` from `curl` or a server-to-server call | no `Origin`, no `Sec-Fetch-Site` | `allowHeaderless: true` on that instance |
| `403` in the browser, same origin | an ingress rewrote `Host` | name the public origin in `origin` |
| `403` from a sandboxed iframe | `Origin: null` | intentional; can't be allowlisted to a real host |
| `413 Payload Too Large` | over `bodyLimit` | raise it, or `0` to rely on the host |
| `400 Bad Request` | a genuinely malformed request — a body that does not parse, or a `?args=` that is not an array | was also a validation failure in 0.3.x; a validation failure is `422` now |
| `422 Unprocessable Content` | a `schema` rejected the input | new in 0.4.0; a client branching on `400` needs updating |
| `404` on a function that exists | wrong prefix, or a second RPC instance | see [Multi-Prefix](./multi-prefix-guide.md) |
| `TS2589` on TypeScript 5.x | heavy vendor schema type | `schema.from(...)` |
| a function's argument is not what the schema produced | you call it outside a dispatch | validation now runs on direct calls too — check the schema |
