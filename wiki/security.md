# Security

What threats `@thednp/rpc` handles for you, and what it expects you to own — prefix guards, CSRF, authentication, body limits, and origin checks.

## Why these are the defaults

An RPC endpoint is public surface by definition: a function name is enough to reach it, and everything it
does is a decision someone else gets to make. So the useful question is not "can this be checked?" — it
always can — but "is it checked in a deployment nobody configured?"

Through 0.3.x the answer was uncomfortable. The checks that were **mandatory** were the harmless ones:
prefix matching, HTTP method, `Content-Type`. All three have to be enforced for the transport to function
at all, so enabling them cost an author nothing. The checks with **real security value** — cross-origin
protection, a body size cap, validating input before the handler runs — were all opt-in. An opt-in check
is a check most deployments never have, which means the protection the README advertises is the protection
0.4.0 decided to stop advertising and start shipping.

So the order is deliberate: **the boundary checks that keep the transport honest are always on, and now so
are the ones that keep a caller honest.**

| | 0.3.x | 0.4.0 |
| --- | --- | --- |
| Prefix boundary, method, content-type | always on | always on |
| Cross-origin / CSRF | opt-in | **on by default**, `origin: "self"` |
| Body size cap | host framework's job | **10 MiB, on by default**, enforced while streaming |
| Input validation before the handler | opt-in | opt-in — but it is a `422`, and the details are worth sending (see [Input Validation](#input-validation)) |

The origin default deserves a note, because "allowlist" usually means *enumerate every origin you accept*
— which is work, and work that is skipped, and skipping it silently locks the operator out of their own
site. rpc's default is the inverse: **your own domain always works, and you extend it.** `origin` exists
only to *add* origins you also serve — a marketing site, an admin subdomain — and a list widens `"self"`
rather than replacing it. That is why the list case is safe to write down at all.

The cost is real and 0.4.0 does not pretend otherwise: a `curl`, a native client, or a no-JS `<form>`
sends no browser provenance and is refused until you say `allowHeaderless: true`. That is the bill for the
default, it is one line to pay it, and it is documented under
[0.4.0 Migration](#040-migration) with the three situations that need attention.

What remains yours: authentication, authorization, rate limiting, and security headers. Those are
middleware before `createRPCMiddleware()` — see
[Authentication via Middleware](#authentication-via-middleware).

## Prefix Boundary Check

All adapters use `RegExp` instead of `startsWith` to match the RPC endpoint path. The prefix is escaped with `escapeRegExp()` before being embedded in the boundary regex, preventing ReDoS or unintended matching from metacharacters in the prefix. This prevents path-segment bypass attacks:

```
rpcPrefix = '__rpc'

# Safe: matches /__rpc/foo
// __rpc/foo  →  /__rpc/

# Not matched: /__rpc-evil/foo or /foo/__rpc/bar
```

Using `startsWith` would incorrectly match paths like `/__rpc-evil/foo`, which could route to unintended handlers. The regex ensures the prefix is a standalone path segment.

## URL Normalization (all adapters)

Every adapter normalizes the request URL before any prefix matching, so a query string can never be injected into the function-name lookup. The call site differs per adapter, so it is worth being precise about which is which:

| Adapter | Source | How it is normalized |
| --- | --- | --- |
| Fastify, Koa, Hono | `req.url` / `ctx.url` / `c.req.path` | `safeURL()` directly |
| Express | `req.url` | `safeURL()` via `getRequestDetails(req)` (`src/express/helpers.ts`) |
| h3 | `event.url.pathname` | Already parsed by h3 before the middleware runs — `safeURL()` is not called, and does not need to be |

```ts
const { pathname, search, searchParams } = safeURL(rawUrl);
```

Where `safeURL` is used, it never throws. Malformed request-targets (`/\`, `//`, `/\/`) make the WHATWG URL parser raise `TypeError: Invalid URL`, and the adapters parse the URL *before* their dispatch `try` block — so an unguarded throw became an unhandled rejection that crashes raw `node:http` hosts (and Express 4) on a single unauthenticated request. On failure `safeURL` falls back to the base root, so the pathname never matches the prefix and the request is treated as non-RPC and falls through to `next()` / 404. h3 is unaffected by that class of crash because it parses the request target itself, upstream of this middleware.

This applies to Express, Fastify, Koa, Hono, h3, and `getRequestMeta` in the request context.

## Generic 404 Responses

Error responses do not echo the requested function name. The **response body** never discloses which functions exist — an attacker probing names against a non-existent endpoint gets a generic `{ error: "Function not found" }` with no name echoed back.

Note that this mitigates **message disclosure**, not existence probing: the **status code** still differs by outcome (`404` for an unknown function vs `405`/`415`/`403` for a known one), so a determined attacker can distinguish "exists" from "does not exist". This is an accepted trade-off — function names ship in the generated client bundle to every browser, so they are not secret — and distinct status codes keep legitimate clients debuggable. If you need to hide the API surface entirely, terminate unknown-prefix requests at a reverse proxy or WAF instead of at the middleware.

## Error Responses: Dev vs Production

Handler errors always produce `500 Internal Server Error`, but the response body depends on the environment:

- **Production** (`NODE_ENV === 'production'`): a generic `{ "error": "Internal Server Error" }` — no message, code, or stack is sent to the client. Internals are logged server-side only.
- **Development**: only `RPCError` payloads (developer-authored `message`, `code`, optional `data`) are included so developers can identify issues immediately. Unexpected exceptions still return the generic message — their details are logged server-side only, so a misconfigured deployment cannot leak internals even in dev.

```jsonc
// production (any error) — and any unexpected exception in dev
{ "error": "Internal Server Error" }

// development: RPCError
{ "error": "validation failed", "code": "VALIDATION", "data": { "field": "email" } }
```

**Never set `NODE_ENV=production` implicitly** in dev tooling — the switch is driven by the environment variable alone, so a misconfigured deployment cannot leak internals accidentally. The client's `handleResponse` rejects on any `{ error }` envelope regardless of environment, so error handling code does not need to branch on `NODE_ENV`.

### Native Clients: `unwrapEnvelope`

Native HTTP clients (Deno, Bun, curl-equivalents) that do not use the generated stubs can unwrap the envelope with `unwrapEnvelope` from `@thednp/rpc/helpers`. It follows the same error contract as `handleResponse`:

```ts
import { unwrapEnvelope } from "@thednp/rpc/helpers";

const res = await fetch("/__rpc/get-user", { method: "POST", /* ... */ });
const body = await res.json();
if (!res.ok) throw new Error(body.error);   // transport-level failure
const user = unwrapEnvelope<User>(body);   // 200 → { data: <result> }
```

- A **top-level** `error` key (which the server emits only for `400`/`404`/`405`/`415`/`422`/`500`) **throws**.
- A `{ data: { error } }` body **resolves normally** — that is the documented validation-as-data contract, where a `200` carries the validation outcome as its result. Do not "fix" this by throwing on any nested `error`.

`unwrapEnvelope` is status-code agnostic, so keep the `res.ok` check: it is what distinguishes a genuine `200` from a body that happens to parse. Note that `RPCError` is **not** exported from `@thednp/rpc/helpers` — it is a server-side export (`@thednp/rpc/server`) and its `code`/`data` are never re-exposed to clients in production anyway.

## Duplicate Function Names

Each server function name must be unique — the registration map is keyed by name. During scanning:

- **Development**: a duplicate name throws immediately, failing the dev server startup so the conflict is fixed fast.
- **Production**: a duplicate name logs a warning and the first registration wins.

## HTTP Method Enforcement

Server functions default to `POST`, and the middleware rejects any request whose HTTP method does not match the function's configured method with `405 Method Not Allowed`:

```
GET  /__rpc/do-stuff  →  405  (function defaults to POST)
POST /__rpc/do-stuff  →  200
```

This blocks the simplest CSRF vector: an attacker page embedding `<img src="/__rpc/do-stuff">` or a form `GET` that would otherwise trigger side effects. Functions that opt into `method: "GET"` (via `createServerFunction(name, handler, { method: 'GET' })`) receive their arguments as an `?args=` JSON query parameter. Reserve `GET` for side-effect-free functions only. See [Server Functions Guide](./server-functions.md) for details, and [Wire Protocol](./wire-protocol.md) for the exact request/response encodings.

### `?args=` Must Be a JSON Array

For `GET` functions the `?args=` value is parsed and checked with `Array.isArray` before dispatch; anything else is rejected with `400 Bad Request`. Without the guard, `?args={"a":1}` would arrive at the handler as a misshapen single input instead of a clean `400` — and `?args="abc"` likewise, both surfacing as confusing downstream failures and burning server CPU on attacker-controlled input.

## Content-Type Enforcement

The middleware checks the request's `Content-Type` against the function's declared `contentType` **before** reading the body, rejecting mismatches with `415 Unsupported Media Type` (see [Wire Protocol — Content-Type Enforcement](./wire-protocol.md#content-type-enforcement)):

- **JSON and text functions are strict**: the header must match the declared type (case-insensitive, after stripping `charset`/`boundary`). This keeps a body from being parsed with the wrong encoding — e.g. a urlencoded body fed to a JSON-declared function fails loudly instead of mis-parsing. A JSON-declared function therefore does **not** accept form bodies; the leniency below runs only in the other direction.
- **Form functions are lenient between the two encodings**: `multipart/form-data` and `application/x-www-form-urlencoded` are interchangeable, so native urlencoded `<form>` submissions work on multipart-declared functions (the nojs progressive-enhancement flow). A form-declared function still rejects `application/json`.
- **Requests without a `Content-Type` header are exempt** (url bar, `GET`, legacy clients) — the check only applies when the header is present, preserving curl/native compatibility.

The comparison normalizes the header (lowercased, parameters stripped) before matching, so `multipart/form-data; boundary=----xyz` matches `multipart/form-data`, and casing is ignored. See [Server Functions Guide](./server-functions.md) for the strict/lenient rules per content type.

## Origin Validation

> **Changed in 0.4.0.** Cross-origin protection used to be opt-in and off by
> default. It is now **on by default**, and the behaviour is a breaking change.
> See the [0.4.0 migration](#040-migration) section at the end of this page.

`createRPCMiddleware()` enforces cross-origin protection by default. The `origin`
option is only needed to admit origins *other* than the server's own host.

```ts
// the default — the server's own host *and port*
app.use(createRPCMiddleware());

// admit one other origin; your own host keeps working
app.use(createRPCMiddleware({ origin: 'https://app.example.com' }));

// admit several; the list widens "self", it never replaces it
app.use(createRPCMiddleware({
  origin: ['https://app.example.com', 'https://admin.example.com'],
}));
```

The rule, shared by all five adapters via the `isOriginRequestAllowed` helper
(`src/server-helpers.ts`). Three tiers, first signal with meaning wins:

1. **`Origin` present** → the policy decides. `"self"` (the default) compares
   the origin's **host and port** against the request's `Host`; an explicit list
   matches exactly, and also admits self.
2. **`Origin` absent but `Sec-Fetch-Site` present** → allow only `same-origin` and
   `none`; anything else, including an unrecognised value, is `403`.
3. **Both absent** → `403`, unless `allowHeaderless: true`.

`allowHeaderless` exists for the clients that legitimately send neither header —
`curl`, most runtimes' `fetch`, and server-to-server calls. It is opt-in because a headerless POST is indistinguishable on the wire
from a cross-site form post that had its headers stripped. A browser's native
`<form>` navigation supplies `Origin`, so the built-in no-JS fallback is checked
like any other request:

```ts
// trusted server-to-server client, no browser exposure at all
app.use(createRPCMiddleware({ allowHeaderless: true }));
```

Full matrix (`Host: app.example.com`, allowlist =
`["https://app.example.com", "https://admin.example.com"]`):

| `origin` option | `Origin` | `Sec-Fetch-Site` | Result |
|---|---|---|---|
| unset (default) | `https://app.example.com` | anything | passes |
| unset (default) | `http://app.example.com` | anything | passes (scheme is not compared) |
| unset (default) | `https://app.example.com.evil.com` | anything | **403** |
| unset (default) | `null` | anything | **403** |
| unset (default) | absent | `same-origin` | passes |
| unset (default) | absent | `cross-site` | **403** |
| unset (default) | absent | absent | **403** |
| set (list) | in list | anything | passes |
| set (list) | not in list, not self | anything | **403** |
| set (list) | self host | anything | passes (list widens, never replaces) |
| any | absent | `none` | passes |
| any | absent | `same-site` / `cross-site` | **403** |
| any | absent | unrecognised | **403** |
| any | absent | absent | **403** unless `allowHeaderless` |

Three properties worth relying on:

- **`Origin` is consulted first, and short-circuits.** The allowlist exists
  precisely to admit a sibling subdomain, and that request carries
  `Sec-Fetch-Site: same-site` — which tier 2 alone would reject. `Sec-Fetch-Site`
  is a coarse four-value enum that cannot name a host, so it only earns a vote
  once the precise signal has been stripped away, at which point there is nothing
  left to trust and it fails closed.
- **The scheme is not compared, but the port is.** A browser behind a load balancer
    sends `Origin: https://app.example.com` while the server sees `http://`, and the
    scheme is deliberately not part of the comparison — so TLS termination needs no
    action. The **port** is compared, with *default* ports normalised, so
    `https://app.example.com:443` matches `Host: app.example.com`.

    That asymmetry is worth stating rather than glossing. Same-host/different-port is
    a different origin and is rejected; same-host/different-**scheme** is also a
    different origin and is **accepted**. HSTS closes most of the downgrade case in
    practice, since an HSTS host upgrades `http` before the request is made — but
    this check does not close it, and closing it would mean trusting
    `X-Forwarded-Proto`, a client-influenceable header unless the proxy strips it.
    That is precisely the trade the next bullet refuses.

- **`Host` has to be the host the client asked for.** Because `"self"` compares the
    origin's port against `Host`'s, a proxy that rewrites `Host` to an internal
    name turns every check into a `403` — and native form submissions fail with
    `{"error":"Forbidden"}` and no other clue. This is not hypothetical:
    `changeOrigin` defaults to `true` in `http-proxy-middleware`, and Vite's
    `preview.proxy` needs `changeOrigin: false` for exactly this reason. Prefer
    preserving `Host`. Where the ingress cannot, name the public origins with
    `origin`: that is the supported shape for a rewritten `Host`, and it records
    what you trust rather than switching the check off.

    Measured while building the built-in no-JS fallback, which is what surfaced it:
    with `changeOrigin: true` and a browser `Origin` of `http://localhost:5173`
    against a rewritten `Host` of `localhost:3000`, every submission was a `403`.
    Same request with `Host` preserved: `303`.

- **No forwarded header is ever trusted.** `X-Forwarded-Host` and friends are
  never consulted, and there is no `trustProxy` option — a header the client may
  influence must not decide "which host am I?". If an ingress *rewrites* `Host` to
  a different name than the browser used, that is a `403` until you name the
  public origin explicitly with `origin`. This is the escape hatch, and it is a
  statement of what you trust rather than a switch someone can flip.

Why the default flipped: an origin check that is off unless someone turns it on is
a check that most deployments never have. "Correct when careless" is the standard
this library is held to, and the cost of the secure default is one `403` for a
`curl` command that `allowHeaderless` fixes in a single line.

`Origin: null` is sent by sandboxed iframes, `file://` pages, and browser extensions. Because it never equals a real origin, it is rejected under the default `"self"` policy as well as whenever an allowlist is set.

An empty or whitespace-only header value counts as **absent**, not as an unrecognised signal — no browser emits an empty `Sec-Fetch-Site`.

This closes the "sibling subdomain" CSRF gap that `SameSite=Lax` cookies alone cannot cover. See [Best Practices — Origin / CSRF Protection](./best-practices.md#origin--csrf-protection) for the full guide and alternatives, and [Comparison](./comparison.md) for how this check stacks up against Next.js Server Actions, TanStack Start, and tRPC — including where it is the *weakest* of the four.

### Residual Gaps

One limit worth knowing before you rely on `origin` alone:

- **Top-level `GET` navigations send no `Origin` header**, so a cross-site `<a href>` or `<img>` pointing at a `GET` function passes the `origin` check even when one is configured. This is the reason `GET` functions must be side-effect-free — the method check does not help there, because the request genuinely is a `GET`.

> **Closed in 0.3.6.** `Sec-Fetch-Site` used to be unconsulted, which meant anything stripping `Origin` turned the check into a no-op. It is now the tier-3 fallback: when `Origin` is gone but `Sec-Fetch-Site` survives, the request must claim `same-origin` or `none` or it is rejected. The snippet that used to live here is only needed if you want `Sec-Fetch-Site` enforcement **without** setting an origin allowlist — in which case mount it before `createRPCMiddleware()`:
>
> ```ts
> app.use((req, res, next) => {
>   const site = req.headers["sec-fetch-site"];
>   if (site && site !== "same-origin" && site !== "none") {
>     return res.status(403).json({ error: "Forbidden" });
>   }
>   next();
> });
> ```

## Multi-Prefix Client Isolation

`getClientModules` (`src/getClientModules.ts:67`) does **not** write files to disk. The Vite plugin's `transform` hook (`src/index.ts:236`) replaces each scanned server file **in-memory** (a virtual module) with the string returned by `getClientModules`. That string is built from a single prefix-scoped map:

```ts
const prefixMap = getFunctionsForPrefix(initialOptions.rpcPrefix); // src/getClientModules.ts:74
```

Only functions whose `createServerFunction(...,{rpcPrefix})` matches the config `rpcPrefix` are emitted. With `rpc.config.ts: {rpcPrefix:"public:rpc", serverFiles:"glob"}` scanning both `public.server.ts` (`public:rpc`) and `admin.server.ts` (`admin:rpc`), a client build for `public:rpc` contains **no** `admin:rpc` stubs — inspecting the public client bundle cannot reveal `admin` function names. Each scanned `*.server.ts` is replaced with the same virtual module (all public functions), not a file per server file.

Prefix isolation is **not** a security boundary. The prefix segment (`/admin:rpc/get-user`) is just a URL path — an attacker can guess `admin:rpc`, `private:rpc`, `v1:rpc` regardless of the bundle. Do not rely on obscurity. Protect every non-public prefix with explicit auth inside the handler (`requireAdminSession` via `getRequestContext`/`sendResponse(403)` as in `examples/advanced/src/api/admin.server.ts:13` and `examples/advanced/src/api/middleware.ts:98`), and validate the prefix with the same escaped-regex guard the adapters use. Client-bundle isolation only prevents accidental leakage; the network boundary must enforce auth.

## Authentication via Middleware

Authentication is handled by middleware registered **before** `createRPCMiddleware()`. The middleware chain composes naturally:

```ts
// Express example
app.use(authMiddleware);             // auth first
app.use(createRPCMiddleware());      // RPC second
```

**Do not add auth hooks inside the plugin.** Use your framework's standard middleware pattern. Check [Best Practices Guide](./best-practices.md) for more detailed examples.

## Body Size Limits

> **Changed in 0.4.0.** rpc now enforces a **10 MiB default cap** of its own
> (`bodyLimit`). Before 0.4.0 the raw-stream path had no cap at all and relied
> entirely on your framework — which, as measured below, does not cover that
> path.

### Why your framework's limit was not enough

A body-parser middleware only limits the content types **it** claims. With the
most common Express setup:

```ts
app.use(express.json({ limit: "1mb" }));
app.use(createRPCMiddleware());
```

`express.json` claims `application/json`, enforces `1mb`, and **declines
urlencoded and multipart requests without reading them** — leaving them on the
stream. rpc then reads that stream itself, and `1mb` was never in the path.
Measured before the fix, against a form-declared server function:

```
12 MB urlencoded  ->  200   (whole body buffered, limit irrelevant)
20 MB multipart   ->  200   (20,971,594 bytes resident as a string)
```

The same applies to Koa without `koa-bodyparser`, and to h3 and Hono, which have
no body parser at all unless you add one.

### What the cap covers, per adapter

`bodyLimit` applies to the paths where **rpc** reads the body. Where your
framework parses the body first, your framework's limit is the operative one and
`bodyLimit` is not consulted. All rows below were measured against real servers.

| Adapter | Path rpc reads | Enforcement | Verified |
| --- | --- | --- | --- |
| **Express** | no upstream body parser | **real cap** — bytes measured as the stream is consumed | 12 MB → `413`; 2 MB → `200`; `bodyLimit: 0` → `200` |
| **Koa** | no `koa-bodyparser` | **real cap** | 12 MB → `413`; 2 MB → `200` |
| **Fastify** | *almost never* | Fastify's own `bodyLimit` | 12 MB JSON with Fastify `bodyLimit: 1mb` → `413` from **Fastify** (`FST_ERR_CTP_BODY_TOO_LARGE`), before rpc runs |
| **h3** | always (Web `Request`) | **real cap** — the `ReadableStream` is measured | 12 MB → `413`; 12 MB chunked with no `Content-Length` → `413` |
| **Hono** | always, except when a host has already read the body | **real cap** for every content type | 4 KB with `bodyLimit: 64` → `413` (declared-JSON *and* text); chunked with no `Content-Length` → `413`; under the cap → `200` |

**Fastify is the exception worth understanding.** It always runs a content-type
parser before any hook, so rpc's streaming path is effectively unreachable for a
well-formed request: Fastify either parses the body (rpc takes the pre-parsed
path) or answers `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` itself — a urlencoded POST
gets that unless you register `@fastify/formbody`. Set **Fastify's** `bodyLimit`,
not rpc's.

**Hono has two paths where the body is already buffered**, and on both the
adapter's own limit is the only thing that can bound it — rpc cannot cap a body
it never reads:

- **Under `@hono/node-server`**, when the Node adapter has already decoded the
  body onto `c.env.incoming`.
- **When a host middleware has already read the body**, which leaves it in
  Hono's `c.req.bodyCache`. This is a real pattern: an auth or validation step
  calling `c.req.json()` before the RPC middleware. rpc reads the cache rather
  than re-reading a spent stream.

One subtlety in that cache: Hono keys entries by *body form*, and
`c.req.json()` stores the **raw text** under `text` and parses it itself
afterwards — so the cache can hand rpc either a parsed value or raw bytes
depending on who wrote it. rpc dispatches on the form, parsing raw text against
the declared content type and accepting a parsed value as-is.

**Hono's JSON path used to be uncapped, and this table was wrong about it.**
`readBody` returned early for declared-JSON through `c.req.json()`, on the
reasonable-sounding grounds that a `4xx` Hono had already classified should keep
its status. But `c.req.json()` reads the stream itself and no cap lives on that
path, so `bodyLimit` silently did not apply to JSON on Hono — while applying to
every other content type, and to the identical body on h3. Measured with
`bodyLimit: 64` and a 4 KB body:

```
hono  declared-JSON  ->  200, payload parsed    <- uncapped
h3     declared-JSON  ->  413 Payload Too Large
```

JSON is what every generated client stub sends, so this was the common case
rather than an edge one. It survived at 100% line coverage because the Hono
suite had **no `bodyLimit` test at all** — coverage measured that the branch ran,
not that it bounded anything. Both the fix and the regression guard are in
`tests/hono.test.ts` under `Hono bodyLimit`. The status-provenance concern that
motivated the early return dissolved once rpc took over the read: there is no
host error left to preserve, and a malformed body is rpc's own `400` on every
adapter.

### Why a `Content-Length` pre-check was not enough on its own

The first implementation of this feature was a `Content-Length` pre-check for h3
and Hono, on the theory that turning an honest oversized request away before the
read was enough. It is not, and the measurement is worth keeping:

```
hono  12 MB body, bodyLimit 1 MB  ->  200
```

A `Request` constructed in JavaScript **does not carry a `Content-Length`
header** — that is added by the HTTP layer when serialising, and it is absent
entirely for a chunked request. This affects `app.fetch()`, Workers, Bun, Deno,
and most serverless adapters, not just tests. rpc now measures the actual bytes
from the same `ReadableStream` the framework would have read, so the cap holds
on those runtimes too.

### Configuring

```ts
app.use(createRPCMiddleware());                          // 10 MiB (default)
app.use(createRPCMiddleware({ bodyLimit: 50 * 1024 * 1024 }));  // larger uploads
app.use(createRPCMiddleware({ bodyLimit: 0 }));          // no cap; host's limits only
```

The cap is enforced **while streaming, never after buffering**: chunks are
measured as they arrive and nothing past the limit is retained, so an oversized
body is never resident in memory. That bounded footprint is the entire guarantee.
The obvious shape — read the whole body, then measure it — provides no
memory-exhaustion protection at all, because the attacker has already forced the
allocation.

Past the cap the remainder is **drained and discarded** rather than the socket
being closed on the spot: closing a socket with unread request data makes Node
emit `RST`, and the client never learns the real reason it failed. The discard
has its own ceiling, so a client that keeps pushing sees a connection reset
instead of an unbounded slowloris.

For a raw `node:http` host with no framework, see the streaming reference
implementation in [Best Practices — Body Limits](./best-practices.md#body-limits)
and the demo's `body-limit.ts`. rpc's own cap does not apply to a body a custom
middleware has already read.

## Input Validation

Server functions receive raw, untrusted client data. Always validate before use. Check [Server Functions Guide](./server-functions.md) for more detailed examples.

> **Next:** [Best Practices](./best-practices.md) — production patterns for auth, rate limiting, body limits, and CSRF.

---

## 0.4.0 Migration

The only breaking change in 0.4.0. Three situations need attention:

- **Non-browser clients** (`curl`, server-to-server, some workers) now get `403`
  because they send no `Origin` and no `Sec-Fetch-Site`. Fix:
  `createRPCMiddleware({ allowHeaderless: true })`.
- **The no-JS `<form>` fallback** runs inside the dispatch and therefore uses the
  normal origin policy; a browser navigation supplies `Origin`. Do not set
  `allowHeaderless` for it — use a per-function `fallback` and see
  [No-JS Fallback](./nojs-fallback.md).
- **An ingress that rewrites `Host`** (rather than merely terminating TLS) will
  `403`, because the `Origin` the browser sent names a host the server no longer
  sees. Fix by naming the public origin: `origin: 'https://app.example.com'`.

Nothing changes for a browser-only deployment: the request was already same-origin,
and same-origin still passes. Existing explicit `origin` configurations keep
working, with one behavioural difference worth knowing — **a configured list now
also admits your own host**. Previously `origin: ['https://admin.example.com']`
locked out `https://app.example.com`; that was almost never intentional, and
naming an extra origin can no longer lock you out of your own site.

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
