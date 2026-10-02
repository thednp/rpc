# Comparison: RPC transports and what each one hardens

How `@thednp/rpc` lines up against Next.js Server Actions, TanStack Start server
functions, SvelteKit remote functions, and tRPC — on the cross-origin / CSRF
boundary specifically.

> **Read this first.** These are **not equivalent products**. Next.js, TanStack
> Start, and SvelteKit are full application frameworks; tRPC is a typed RPC layer
> that expects you to bring an HTTP framework; `@thednp/rpc` is only the RPC
> transport. Comparing them on "security" mostly compares how much each one
> chose to take on. The useful question is narrower: **for the cross-origin
> check on a server-function call, who enforces what — and what does it cost
> you to get the strict version?**
>
> This page was verified against vendor documentation and source on
> **2026-09-27**, against Next.js **16.3.6**, TanStack Start **1.168.59** (still
> pre-1.0), SvelteKit **2.70.x** (2.70.3; SvelteKit 3 is at release candidate),
> tRPC **11.18.0**, and Telefunc **0.2.24**. These implementations change;
> re-check before relying on any row.

---

## The short, honest version

`@thednp/rpc` is a **transport**, not a framework — so it draws the line in a
different place than the others. It has no opinion about your *public* origin, so
it does not guess one: it uses the request's own `Host` header. Enforcement is
**on by default** (as of 0.4.0; it was opt-in before), and `origin` is only needed
to admit origins *other* than your own.

**`@thednp/rpc` is the strictest of the group on the paths they share.**
An explicit `allowlist` rejects an untrusted `Origin` *even when
`Sec-Fetch-Site: same-origin` claims otherwise* — which is exactly the case
TanStack's tier order waves through, since it returns on `Sec-Fetch-Site` before
it ever inspects `Origin`. It also rejects `Origin: null`, lookalike hosts, and
every request with no browser provenance at all. Measured against TanStack's
documented algorithm across realistic request shapes:

|                                                    | `@thednp/rpc` | TanStack |
| ----------------------------------------------------| ---------------| ----------|
| untrusted `Origin` + `Sec-Fetch-Site: same-origin` | **403**       | passes   |
| `Origin: null`                                     | **403**       | passes   |
| lookalike host (`…example.com.evil.com`)           | **403**       | passes   |
| `cross-site` origin                                | `403`         | `403`    |
| no `Origin`, `Sec-Fetch-Site: cross-site`          | `403`         | `403`    |
| no `Origin` + `Sec-Fetch-Site: same-origin`        | passes        | passes   |
| allowlisted sibling + `Sec-Fetch-Site: same-site`  | passes        | `403`    |
| no `Origin`, no `Sec-Fetch-Site` (curl)            | `403`¹        | `403`    |

Counted from that table: **3 stricter, 1 more lenient, 4 equal** — and the lenient
one is the point, since the allowlisted sibling is precisely what an allowlist
exists to admit. (An earlier draft of this page said "4 stricter", which its own
table does not support; the `cross-site`, stripped-`Origin` and
`Sec-Fetch-Site: cross-site` rows are `403` on both sides.) A second leniency
sits outside the table: with `allowHeaderless: true`, rpc passes the headerless
`curl` row that TanStack refuses, and rpc has no `Referer` tier where TanStack
falls back to it. So **3 stricter / 2 more lenient** counting both, and both
leniencies are deliberate and named.

So the trade is not "weaker check, more options". It is
**secure by default, strictest-once-configured, and multi-origin without a proxy
rewriting headers** — a capability the `Host`-comparison model otherwise has to
fight for.

¹ Unless you set `allowHeaderless: true`, which is the documented opt-in for
`curl` and server-to-server callers. This was the "documented curl/native hole"
in earlier drafts, and 0.4.0 closed it by default. The no-JS `<form>` fallback is
**not** in that category: a browser navigation sends `Origin`, so it passes the
default policy — and because the fallback runs *inside* the dispatch it is
checked, which is the point. See the progressive-enhancement row below.

Two more places `@thednp/rpc` is ahead regardless of configuration: its `Origin: null`
handling is correct by default (Next.js shipped
[`GHSA-mq59-m269-xvcx`](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx)
for treating `null` as *missing*), and its body parsers are immune to the
prototype-pollution class tRPC hit in
[`CVE-2025-68130`](https://nvd.nist.gov/vuln/detail/CVE-2025-68130) — verified
against live `__proto__` payloads.

**Where this costs you.** An ingress that *rewrites* `Host` to a different name
than the browser used gets a `403`, and the fix is to name the public origin in
`origin` — because the alternative, trusting `X-Forwarded-Host`, is how Next.js
ends up comparing a client-influenceable header. Plain TLS termination is fine:
the scheme is never compared, so nothing is needed there.

**Where this page has been wrong before.** An earlier draft stated that Next.js
*aborts* a request with no `Origin`, treating the missing header as a `Host`
mismatch. That is not what Next.js does: an absent `Origin` is let through with a
dev warning, on the stated reasoning that a handcrafted request cannot carry
unwilling victim credentials. `@thednp/rpc` shared that posture until 0.4.0 and
has since closed it by default, which is why Next.js now sits on the more
permissive side of the headerless row. The same draft also overstated TanStack,
which rejects a request with *no* signal at all rather than specifically one
lacking `Origin`. Both are corrected in the table above. The tally is measured
against TanStack only, and it reads **3 stricter / 2 more lenient** from the
table and the two named gaps — not the "4 stricter" an earlier draft claimed.

---

## Cross-origin / CSRF enforcement

|                             | `@thednp/rpc`                                 | Next.js Server Actions                                                                             | TanStack Start                                                                                                                         | SvelteKit                                                                                      | tRPC                                                                            |
|------------------------------|------------------------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| Enabled by default           | **Yes** — `origin: "self"`; `origin` is only needed for other origins | **Yes**                                                                                             | **Yes** — auto-installed unless you define `src/start.ts`                                                                               | **Yes**, in production only                                                                     | No origin check; ships POST `Content-Type` enforcement as a form-CSRF mitigation |
| Mechanism                    | `Host` + port comparison (`"self"`), **extended** by an optional list | `Origin` vs `Host` / `X-Forwarded-Host`                                                             | `Sec-Fetch-Site` → `Origin` → `Referer`                                                                                                                         | `Origin` vs the server's own origin, for form submissions                                       | Bring your own (`CORS`/middleware)                                               |
| Allow multiple origins       | Yes — `origin: [...]`                          | Yes — `serverActions.allowedOrigins`, incl. `*.domain` wildcards                                    | Yes — `createCsrfMiddleware({ origin })`                                                                                                | Yes — `csrf.trustedOrigins`                                                                     | Framework-dependent                                                              |
| Request with **no** `Origin` | **Rejected** unless `allowHeaderless: true`     | **Passes** — an absent `Origin` is let through with a dev warning, not treated as a `Host` mismatch | **Rejected** only when `Sec-Fetch-Site` **and** `Referer` are absent too; a no-`Origin` request with a same-origin `Referer` is allowed | Aborted for form submissions                                                                    | Framework-dependent                                                              |
| Applies to GET / queries?    | Yes                                            | No — actions are POST-only                                                                          | `filter` can target only server fns                                                                                                     | CSRF covers `POST`/`PUT`/`PATCH`/`DELETE` **form** content types only                           | Framework-dependent                                                              |
| Uses `Sec-Fetch-Site`        | Yes — tier-3 fallback                          | No                                                                                                  | Yes — **checked first**                                                                                                                 | No                                                                                              | No                                                                               |
| Uses `Referer`               | No                                             | No                                                                                                  | Yes — third fallback, on by default                                                                                                     | No                                                                                              | No                                                                               |
| Tier order                   | `Origin` → `Sec-Fetch-Site`                    | n/a (single comparison)                                                                             | `Sec-Fetch-Site` → `Origin` → `Referer`                                                                                                 | n/a (single comparison)                                                                         | n/a                                                                              |
| Escape hatch                 | `allowHeaderless` for non-browser clients; `origin` for a rewritten `Host` | `allowedOrigins` config                                                                             | `allowRequestsWithoutOriginCheck` (default `false`)                                                                                     | `csrf.trustedOrigins: ['*']` — but **not** for a missing `Origin`, and not for remote functions | Framework-dependent                                                              |
| Custom failure response      | No (fixed `403`)                               | No                                                                                                  | Yes — `failureResponse`                                                                                                                 | No                                                                                              | Framework-dependent                                                              |
| Input validation           | **Opt-in `schema`** — any Standard Schema, validated before the handler is entered; issues returned in development                  | No                                                                                                  | No                                                                                                  | No — but remote functions take a Standard Schema                                                | Opt-in `.input()`; issues only via a custom `errorFormatter`                                   |

**SvelteKit caveats worth knowing.** Its CSRF protection is scoped to *form
submissions* (`application/x-www-form-urlencoded`, `multipart/form-data`,
`text/plain`, plus its internal `application/x-sveltekit-formdata`) on unsafe
methods, so a JSON-`POST` RPC call is outside its scope. It also **only runs in
production** — in `vite dev` there is no CSRF check at all, though `vite preview`
of a production build *does* enforce. The config surface is mid-migration:
`csrf.checkOrigin` is deprecated in favour of `csrf.trustedOrigins`, and is
**removed in SvelteKit 3**, which replaces the `adapter-node` `ORIGIN` env var
with `config.kit.paths.origin`.

Two things that are commonly written up wrongly:

- **`csrf.trustedOrigins: ['*']` is not a full escape hatch.** The runtime
  condition rejects a form POST with a *missing* `Origin` regardless of
  `trustedOrigins`, including `['*']` — only the deprecated `checkOrigin: false`
  allowed those through, and that option is being removed. See
  [sveltejs/kit#15992](https://github.com/sveltejs/kit/issues/15992).
- **Remote functions are exempt from `trustedOrigins` by design, not by
  oversight.** They get their own stricter same-origin check, and maintainers
  closed [PR #14795](https://github.com/sveltejs/kit/pull/14795) — which proposed
  honouring `trustedOrigins` for them — *unmerged*, on the grounds that
  "`trustedOrigins` is the wrong tool for this job". Remote endpoints are
  same-origin by design.

> **Removed as unsupported:** an earlier draft of this page claimed
> `Referrer-Policy: no-referrer` causes SvelteKit CSRF false positives. That does
> not hold up — SvelteKit reads **only** the `Origin` header and has no `Referer`
> fallback, so stripping `Referer` has no path to trip the check. The documented
> cause of those false positives is **self-origin misderivation** behind a proxy,
> fixed with `ORIGIN` (v2) or `paths.origin` (v3).

### Why our rpc checks `Origin` first, and TanStack checks `Sec-Fetch-Site` first

This looks like a contradiction but both orders are forced by their own design. TanStack's `secFetchSite` matcher defaults to the single value `same-origin`, and its `origin` matcher defaults to "the trusted request origin" — it has no reason
to consult a coarse enum first, because the precise comparison is free.

`@thednp/rpc`'s `allowlist` exists for exactly one reason: to admit a **sibling subdomain**. That request carries `Sec-Fetch-Site: same-site`, which a `same-origin`-only check rejects. So `@thednp/rpc` must consult `Origin` first and use `Sec-Fetch-Site` only once the precise signal is gone — at which point it fails closed. A regression test pins the ordering, because getting it backwards breaks legitimate traffic.

---

## Progressive enhancement (no-JS `<form>`)

A separate axis from CSRF enforcement, and measured separately. Setting
`fallback` on a function turns it into a usable HTML `<form action>` with
JavaScript disabled: the native post is answered with a `303` and the failure
flashed, instead of a JSON body the browser renders raw.

| | `@thednp/rpc` | Next.js Server Actions | TanStack Start | SvelteKit | tRPC | Vike / Telefunc |
| --- | --- | --- | --- | --- | --- | --- |
| No-JS `<form>` | **Built in** — `fallback` on the function, all five adapters | **Yes, when the Server Function is passed directly to `<form action>`** — progressive enhancement works, including without JavaScript ([React `<form>`](https://react.dev/reference/react-dom/components/form#handle-form-submission-with-a-server-function), [Next.js forms](https://nextjs.org/docs/app/guides/forms)) | **Yes** — form actions | **Yes** — form actions | **No** | **No** |
| Failure transport | `__flash` in the redirect URL, 4 KiB cap, **dropped** not truncated | normal navigation/rerender; displaying server validation errors before hydration generally needs client React state (for example `useActionState`) | cookie, where oversized `Set-Cookie` values are rejected rather than truncated | the re-rendered page receives only the fields the handler returns, for example through `fail(status, data)` ([SvelteKit form actions](https://svelte.dev/docs/kit/form-actions)) | n/a | n/a |
| Replayed values | **Explicit allowlist, empty by default** | n/a | **every** decoded submitted field by default ([TanStack source](https://github.com/TanStack/form/blob/main/packages/react-form-start/src/createServerValidate.tsx)) | only the fields the handler chooses to return | n/a | n/a |
| Subject to the origin check | **Yes** — it runs inside the dispatch | Yes | Yes | Yes | Yes | Yes |
| Off-origin success target | `redirect()` from the request context, which wins over `fallback` | Yes | Yes | Yes | Yes | Yes |

Two honest notes on the shape of this. An app-layer fallback middleware mounted
*before* the RPC middleware is **not** subject to the origin check, and answering
a form post from any origin is a CSRF hole — so the built-in's placement is the
security-relevant part, not just the convenience. TanStack Form persists server
validation state in a cookie, while SvelteKit returns the handler-selected fields
to the re-rendered page; browser cookie limits mean a very large TanStack flash can
be rejected rather than truncated. A related failure shape appears in SolidStart's
open issue on large no-JS submissions losing SSR input
([#2179](https://github.com/solidjs/solid-start/issues/2179)).


## Vike and Telefunc — considered, and why the reasoning matters

**Vike is not in the table, but not for quite the reason it first appears.**
Vike ships no RPC transport of its own — that part is right, and it is why a
"Vike row" has nothing to put in the cross-origin column. It *does*, however,
ship and recommend [Telefunc](https://telefunc.com/), a server-function RPC
maintained by the Vike team. So it isn't that Vike "doesn't do any of that" —
it's that the thing to compare is Telefunc, one layer down.

Telefunc is worth a mention because it inverts two of the axes above:

- **It has the strongest input validation of anything here.** `shield()` is
  auto-generated for production builds and guarantees that *every* value arriving
  at the server is validated — including values sent through its streaming
  primitives, not just top-level arguments. One caveat: it is **off in
  development** by default (`config.shield.dev`, since Telefunc only generates it
  when building for production), so argument types are not checked in `dev` unless
  you opt in. tRPC requires you to attach a validator, and so does
  `@thednp/rpc` — its `schema` option takes any Standard Schema and is checked
  by the middleware before the handler runs. Neither is on unless you ask, and
  TanStack Start does not validate for you at all.
- **Its security model is explicitly authorization, not cross-origin.** The docs
  state plainly that "telefunctions are public and can be called by anyone", and
  that you protect each one with `throw Abort()` / `shield()`. We found **no
  documented origin or CSRF check** in its configuration surface — note that's
  *absence of evidence*, not a confirmed absence, so treat it as "unverified"
  rather than "none".

So on the cross-origin axis Telefunc would rank **below** `@thednp/rpc`, which now
enforces a check by default. On the validation axis it still ranks **above**
everyone, and the gap is narrower than it was: `@thednp/rpc` now has an opt-in
`schema` option, comparable to tRPC's `.input()`. Telefunc is stronger on two
specific counts that a per-function schema does not replicate — `shield()` is
auto-generated rather than something you attach, and it covers values arriving
through streaming primitives, not just top-level arguments. If you want it as a
full column, say so — it is a small addition once the rest of the page is
settled.

## Where our rpc is stronger

- **`Origin: null` is rejected by default.** Next.js shipped
  [`GHSA-mq59-m269-xvcx`](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx)
  ([CVE-2026-27978](https://nvd.nist.gov/vuln/detail/CVE-2026-27978), published
  2026-03-16, Moderate 5.3) for treating `origin: null` as a *missing* origin,
  which let sandboxed iframes and opaque contexts bypass the check instead of
  being validated as cross-origin. It affected `16.0.1`–`16.1.6` and is fixed in
  **`16.1.7`**: `null` is now preserved as a literal that can never equal a real
  host, so it is rejected unless `'null'` is explicitly allowlisted.
  `@thednp/rpc`'s exact-match allowlist never equals `null`, so it rejects by
  default and has no equivalent window.
- **Your own origin is never something you have to remember to allow.** The default is
  `origin: "self"`, so a deployment that serves one domain configures nothing, and the
  option exists to *extend* that — an admin subdomain, a marketing site — rather
  than to enumerate what is acceptable. Next.js's `allowedOrigins` is the inverse: you
  list what you accept, so a single-site deployment either writes a redundant
  entry or runs unprotected. rpc's list form widens `"self"` rather than replacing
  it, which is what makes it safe to write down: naming an extra origin can no
  longer lock the operator out of their own site.
- **No prototype pollution via body keys.** tRPC shipped
  [`CVE-2025-68130`](https://nvd.nist.gov/vuln/detail/CVE-2025-68130)
  ([GHSA-43p4-m455-4f4j](https://github.com/trpc/trpc/security/advisories/GHSA-43p4-m455-4f4j),
  High 8.5): its `formDataToObject` split FormData keys on `.`/`[]` and wrote
  them unvalidated, so `__proto__[isAdmin]=true` polluted `Object.prototype`.
  Fixed in **10.45.3 / 11.8.0**. Scope it honestly: the advisory covers that
  helper reached via the `experimental_caller` / `experimental_nextAppDirCaller`
  adapters, not tRPC's general body parsing. `@thednp/rpc`'s urlencoded path uses
  `Object.fromEntries(new URLSearchParams(body))`, which creates own properties
  and cannot invoke a `__proto__` setter — and it has no `FormData`-normalising
  path at all. Verified against live `__proto__[isAdmin]=true` and
  `constructor[prototype][isAdmin]=true` bodies: the prototype stays clean.
- **A per-dispatch hook that owns none of your data.** `onDispatch` reports one
  redacted `DispatchContext` per dispatch on all five adapters — which origin
  tier decided, the matched function and its siblings, declared vs actual method
  and content type, the *shape* of the arguments, status, error class and
  duration — and the library **retains nothing**: no buffer, no ring, no TTL. The
  competition's equivalent is a logging call you wire up, which means either you
  hold request data by default or you get nothing; and the shape detail is what
  makes a `403` diagnosable without guessing. `argShape` never captures values,
  so it is safe to log despite arguments routinely carrying passwords. See
  [Observing Dispatches](./middleware.md#observing-dispatches-ondispatch).
- **No transport-level crash surface.** tRPC 11's WebSocket `connectionParams`
  validation had an unhandled throw that crashed the process —
  [`CVE-2025-43855`](https://github.com/trpc/trpc/security/advisories/GHSA-pj3v-9cm8-gvj8).
  `@thednp/rpc` has no WebSocket transport.

## Where the trade costs you

Everything here is a real cost, and none of it is hidden — but most of it is the
price of the capability above rather than a gap in it.

- **Both headers absent ⇒ rejected** (0.4.0). This is stricter than Next.js,
  which lets an absent `Origin` through with a dev warning, and it will break a
  `curl` command or a server-to-server client until you add
  `allowHeaderless: true`. That is a deliberate trade: a headerless POST is
  indistinguishable on the wire from a cross-site form post whose headers were
  stripped, and a check nobody has to opt into is a check most deployments never
  have. The one-line opt-in is the price.
- **A rewritten `Host` is a 403.** An ingress that rewrites `Host` to a different
  name than the browser used means the `Origin` the browser sent names a host the
  server no longer sees. The fix is to name the public origin in `origin` —
  deliberately not a `trustProxy` switch, because trusting `X-Forwarded-Host` is
  exactly how Next.js ends up comparing a client-influenceable header. Plain TLS
  termination needs nothing: the scheme is not compared.
- **Case sensitivity depends on which tier decides.** The `"self"` comparison is
  **case-insensitive** — hosts are lowercased on both sides, because DNS names are
  (RFC 1035 §2.3.3). Literal allowlist entries are still an exact byte match, so
  `HTTPS://APP.EXAMPLE.COM` must be spelled as you intend. Next.js had the
  case-sensitivity bug class and fixed it in
  [PR #89127](https://github.com/vercel/next.js/pull/89127) (merged 2026-01-29),
  so its allowlist is now case-insensitive throughout.
- **Literal origins only** — no `*.example.com` wildcards, as Next.js's
  `allowedOrigins` allows (it supports both `*` for a single label and `**` for
  multiple). Enumerate the subdomains you actually serve.
- **No `Referer` tier — deliberately.** TanStack falls back to `Referer`; `@thednp/rpc` does not, because [Google's own guidance](https://web.dev/articles/referrer-best-practices) is explicit: *"Don't use referrers for Cross-Site Request Forgery (CSRF) protection… use `Origin` and `Sec-Fetch-Site`."* `@thednp/rpc` consults exactly those two.
  The practical cost is that a user sending `Referrer-Policy: no-referrer` with `Sec-Fetch-Site` stripped is treated as a native client and allowed.
- **No server-side batching limits exist to abuse** — but also no batching, so tRPC's unbounded-batch complaint ([#5825](https://github.com/trpc/trpc/issues/5825)) has no analogue.
- **Input validation is opt-in, and the detail is development-only.** As of 0.4.0
  `@thednp/rpc` has a `schema` option — any Standard Schema, validated by the
  middleware before the handler is entered, so a bad input is a `422` rather than
  a call into your code. On the *mechanism* that is level with tRPC's
  `.input()`: both are opt-in, both run before the resolver, and both hand the
  resolver the schema's output so coercion needs no cast.

  The error surface is where the two differ, and it was measured against tRPC
  11.19's `getErrorShape` rather than assumed (re-verified 2026-09-29):

  | | rpc | tRPC |
  | --- | --- | --- |
  | validation issues in the response | **yes**, in development | **no** — the default shape omits them; you must write an `errorFormatter` to add `zodError` |
  | error `message` in production | **not sent** — the status reason phrase only | **sent** — `message` is unconditional; only the stack is `isDev`-gated |
  | who decides the error shape | rpc, with no app-level override | the app, per router, inferred to the client |
  | client-side error type | `RPCResponseError` with `status`/`body`/`issues`/`hint` | `TRPCClientError` with a typed `data.code` |

  So rpc teaches better out of the box and leaks less; tRPC is more configurable
  and gives the client a compile-time error code. The missing piece on our side
  is an app-level error formatter — without one, "strip in production" is a
  decision rpc makes on your behalf.

  It is still not Telefunc's `shield()`, which is auto-generated and
  runtime-enforced in production. See
  [Server Functions — Input Validation](./server-functions.md#input-validation).

## What none of these do for you

All of these hand the following to the host. `@thednp/rpc` is the most explicit
about it — and the one place it no longer fully delegates is body size limits,
because 0.4.0 found a content type nothing was bounding:

- **Authentication / authorization** — middleware registered before
  `createRPCMiddleware()`.
- **Rate limiting** — see [Best Practices](./best-practices.md#rate-limiting).
- **Security headers** (CSP, HSTS, `X-Frame-Options`) — reverse proxy or host.
- **Body size limits** — partly. `@thednp/rpc` enforces a **10 MiB default cap**
  of its own (`bodyLimit`, `0` disables) on the paths it reads, *while the body
  streams* rather than after buffering, for every content type. That is not
  redundant with a host framework's limit, and the reason was measured:
  `express.json({ limit: "1mb" })` **declines** urlencoded and multipart, leaves
  them on the stream, and rpc read that stream uncapped — a 20 MB multipart POST
  returned `200` with 20,971,594 bytes buffered. Next.js bounds Server Action
  bodies via `bodySizeLimit`; tRPC and TanStack Start have nothing that applies
  to a body rpc did not hand them.

  Two caveats, both honest limits rather than omissions. A body some *other*
  layer already buffered cannot be capped — under `@hono/node-server`, and when a
  host middleware has read the body first — and there the host's own limit is
  what bounds the upload. And Fastify is effectively exempt, because its
  content-type parser answers before any hook runs. Per-adapter table, measured:
  [Security — Body Size Limits](./security.md#body-size-limits). Reference
  implementation: `examples/spa/body-limit.ts`.

---

## Choosing between them

- Want **CSRF protection with zero configuration** in a React app you don't
  already have a framework for → **TanStack Start** (or `@thednp/rpc` as of
  0.4.0, where it is the default rather than an opt-in).
- Already in **Next.js** → its Server Actions check is on by default and needs no
  configuration, so there is no reason to add a second transport for this. Two
  caveats worth knowing: it fails **open** on a request with no `Origin` (which
  `@thednp/rpc` closed in 0.4.0, at the cost of needing `allowHeaderless` for
  non-browser clients), and it only covers POST, so it does nothing for a
  GET-based transport.
- Want a **typed API with batteries-included validation ergonomics** and control
  over batching/caching → **tRPC**.
- Want a **transport that stays out of the way**: framework-agnostic, no runtime
  lock-in, multi-prefix, and a cross-origin check that is already on →
  **`@thednp/rpc`**.

> **If any of the above makes you want to try it:** the
> [Migration guide](./migration.md) covers both directions — upgrading an
> existing 0.3.x install (two defaults changed; one of them will surface as a
> `403` or a `413`) and coming from one of the frameworks on this page. The
> comparison above is meant to be read honestly, including the costs, so the
> guide does not pretend the trade is free.

> **The honest framing:** `@thednp/rpc` is not "more secure than Next.js". It is a
> smaller surface that makes fewer decisions for you — and as of 0.4.0 the one
> decision that matters most is made *for* you, on the secure side, rather than
> waiting to be made. The bill for that is a `403` on your first `curl`.

---

## Sources

Checked on 2026-09-27 against each project's **documentation and, where the docs
were ambiguous, its current source and test suite**. Versions verified:
Next.js 16.3.6, TanStack Start 1.168.59, SvelteKit 2.70.3 (3 at RC), tRPC 11.18.0,
Telefunc 0.2.24.

- Next.js — [`serverActions.allowedOrigins`](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions), [Data Security guide](https://nextjs.org/docs/app/guides/data-security), advisory [`GHSA-mq59-m269-xvcx`](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx) / [CVE-2026-27978](https://nvd.nist.gov/vuln/detail/CVE-2026-27978), the `Origin: null` fix (PR #91478, commit [`a27a11d`](https://github.com/vercel/next.js/commit/a27a11d78e748a8c7ccfd14b7759ad2b9bf097d8)), case-insensitivity fix [PR #89127](https://github.com/vercel/next.js/pull/89127), CSRF logic in [`action-handler.ts`](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts)
- TanStack Start — [Middleware: CSRF](https://tanstack.com/start/latest/docs/framework/react/guide/middleware), [Server Functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions), [`createCsrfMiddleware` source](https://github.com/TanStack/router/blob/main/packages/start-client-core/src/createCsrfMiddleware.ts), auto-install in [`createStartHandler.ts`](https://github.com/TanStack/router/blob/main/packages/start-server-core/src/createStartHandler.ts), and its [test suite](https://github.com/TanStack/router/blob/main/packages/start-server-core/tests/createCsrfMiddleware.test.ts) — which is where the no-signal rejection and fail-closed-under-opt-in behaviour are actually pinned. Import it from `@tanstack/react-start` / `@tanstack/solid-start`, not `-core` ([#7460](https://github.com/TanStack/router/issues/7460)).
- SvelteKit — [Configuration (`csrf.trustedOrigins`)](https://svelte.dev/docs/kit/configuration), [Remote functions](https://svelte.dev/docs/kit/remote-functions), [Form actions](https://svelte.dev/docs/kit/form-actions), [adapter-node (`ORIGIN`)](https://svelte.dev/docs/kit/adapter-node), the CSRF block in [`respond.js`](https://github.com/sveltejs/kit/blob/main/packages/kit/src/runtime/server/respond.js), missing-`Origin` gap [issue #15992](https://github.com/sveltejs/kit/issues/15992), remote-functions CSRF [PR #14795](https://github.com/sveltejs/kit/pull/14795) (**closed unmerged**), SvelteKit 3 migration guide
- tRPC — [Input & Output Validators](https://trpc.io/docs/server/validators), [CORS is adapter-side](https://trpc.io/docs/client/cors), POST `Content-Type` enforcement [PR #5526](https://github.com/trpc/trpc/pull/5526), advisory [`CVE-2025-68130`](https://nvd.nist.gov/vuln/detail/CVE-2025-68130) / [`GHSA-43p4-m455-4f4j`](https://github.com/trpc/trpc/security/advisories/GHSA-43p4-m455-4f4j), advisory [`CVE-2025-43855`](https://github.com/trpc/trpc/security/advisories/GHSA-pj3v-9cm8-gvj8), batch limits [#5825](https://github.com/trpc/trpc/issues/5825)
- Vike / Telefunc — [Vike RPC](https://vike.dev/RPC) (recommends *an* RPC tool, Telefunc first), [Telefunc RPC](https://telefunc.com/RPC), [`shield()`](https://telefunc.com/shield), [`shield()` config](https://telefunc.com/shield-config), [Permissions](https://telefunc.com/permissions)
- Progressive enhancement — [React `<form>` Server Function](https://react.dev/reference/react-dom/components/form#handle-form-submission-with-a-server-function), [Next.js forms](https://nextjs.org/docs/app/guides/forms), [TanStack Form SSR](https://tanstack.com/form/latest/docs/framework/react/guides/ssr), [`createServerValidate` source](https://github.com/TanStack/form/blob/main/packages/react-form-start/src/createServerValidate.tsx)
- `@thednp/rpc` — [Security](./security.md), [Wire Protocol](./wire-protocol.md)

> **Next:** [Security](./security.md) — the full rules for this framework.

---

## Table of Contents

- [The short, honest version](#the-short-honest-version)
- [Cross-origin / CSRF enforcement](#cross-origin--csrf-enforcement)
  - [Why the tier orders differ](#why-our-rpc-checks-origin-first-and-tanstack-checks-sec-fetch-site-first)
- [Vike and Telefunc — considered, and why the reasoning matters](#vike-and-telefunc--considered-and-why-the-reasoning-matters)
- [Where our rpc is stronger](#where-our-rpc-is-stronger)
- [Where the trade costs you](#where-the-trade-costs-you)
- [What none of these do for you](#what-none-of-these-do-for-you)
- [Choosing between them](#choosing-between-them)
- [Sources](#sources)
