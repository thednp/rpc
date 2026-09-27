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
different place than the others. It has no opinion about your public origin, so
it does not guess one: enforcement is **opt-in**, and you name your origins
explicitly. That is the only meaningful difference from TanStack Start and
Next.js, and it is a single option (`origin`) rather than a fixed policy.

**Once you set it, `@thednp/rpc` is the strictest of the group on the paths they share.**
An explicit `allowlist` rejects an untrusted `Origin` *even when
`Sec-Fetch-Site: same-origin` claims otherwise* — which is exactly the case
TanStack's tier order waves through, since it returns on `Sec-Fetch-Site` before
it ever inspects `Origin`. It also rejects `Origin: null` and lookalike hosts
outright. Measured against TanStack's documented algorithm across realistic
request shapes:

|                                                    | `@thednp/rpc` | TanStack |
| ----------------------------------------------------| ---------------| ----------|
| untrusted `Origin` + `Sec-Fetch-Site: same-origin` | **403**       | passes   |
| `Origin: null`                                     | **403**       | passes   |
| lookalike host (`…example.com.evil.com`)           | **403**       | passes   |
| `cross-site` origin                                | `403`         | `403`    |
| no `Origin`, `Sec-Fetch-Site: cross-site`          | `403`         | `403`    |
| no `Origin` + `Sec-Fetch-Site: same-origin`        | passes        | passes   |
| allowlisted sibling + `Sec-Fetch-Site: same-site`  | passes        | `403`    |
| no `Origin`, no `Sec-Fetch-Site` (curl)            | passes        | `403`    |

`@thednp/rpc` is stricter in three cases and more permissive in two — and **both of the
lenient ones are the point**: the `allowlisted` sibling is precisely what an
allowlist exists to admit, and the headerless case is the deliberate
curl/native-client hole. So the trade is not "weaker check, more options". It
is **fail-open by default, strictest-once-configured, and multi-origin without
a proxy rewriting headers** — which is a capability the `Host`-comparison model
has to fight for.

Two more places `@thednp/rpc` is ahead regardless of configuration: its `Origin: null`
handling is correct by default (Next.js shipped
[`GHSA-mq59-m269-xvcx`](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx)
for treating `null` as *missing*), and its body parsers are immune to the
prototype-pollution class tRPC hit in
[`CVE-2025-68130`](https://nvd.nist.gov/vuln/detail/CVE-2025-68130) — verified
against live `__proto__` payloads.

What that framing does **not** excuse is leaving `origin` unset. If you want
TanStack's fail-closed default, set `origin` to your own origin; if you want
zero configuration, that is the one axis where a framework is genuinely the
better fit. (Telefunc, discussed below, appears to sit below `@thednp/rpc` on this axis entirely.)

**Where this page has been wrong before.** An earlier draft stated that Next.js
*aborts* a request with no `Origin`, treating the missing header as a `Host`
mismatch. That is not what Next.js does: an absent `Origin` is let through with a
dev warning, on the stated reasoning that a handcrafted request cannot carry
unwilling victim credentials — the same fail-open posture `@thednp/rpc` takes for
the curl/native hole. It also overstated TanStack, which rejects a request with
*no* signal at all rather than specifically one lacking `Origin`. Both are
corrected in the table above. The `3 stricter / 2 more lenient` tally is measured
against TanStack only and is unchanged.

---

## Cross-origin / CSRF enforcement

|                             | `@thednp/rpc`                                 | Next.js Server Actions                                                                             | TanStack Start                                                                                                                         | SvelteKit                                                                                      | tRPC                                                                            |
|------------------------------|------------------------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| Enabled by default           | **No** — opt-in via `origin`                   | **Yes**                                                                                             | **Yes** — auto-installed unless you define `src/start.ts`                                                                               | **Yes**, in production only                                                                     | No origin check; ships POST `Content-Type` enforcement as a form-CSRF mitigation |
| Mechanism                    | Exact-match allowlist (`string` or `string[]`) | `Origin` vs `Host` / `X-Forwarded-Host`                                                             | `Sec-Fetch-Site` → `Origin` → `Referer`                                                                                                 | `Origin` vs the server's own origin, for form submissions                                       | Bring your own (`CORS`/middleware)                                               |
| Allow multiple origins       | Yes — `origin: [...]`                          | Yes — `serverActions.allowedOrigins`, incl. `*.domain` wildcards                                    | Yes — `createCsrfMiddleware({ origin })`                                                                                                | Yes — `csrf.trustedOrigins`                                                                     | Framework-dependent                                                              |
| Request with **no** `Origin` | **Passes** (documented curl/native hole)       | **Passes** — an absent `Origin` is let through with a dev warning, not treated as a `Host` mismatch | **Rejected** only when `Sec-Fetch-Site` **and** `Referer` are absent too; a no-`Origin` request with a same-origin `Referer` is allowed | Aborted for form submissions                                                                    | Framework-dependent                                                              |
| Applies to GET / queries?    | Yes, if you set `origin`                       | No — actions are POST-only                                                                          | `filter` can target only server fns                                                                                                     | CSRF covers `POST`/`PUT`/`PATCH`/`DELETE` **form** content types only                           | Framework-dependent                                                              |
| Uses `Sec-Fetch-Site`        | Yes — tier-3 fallback                          | No                                                                                                  | Yes — **checked first**                                                                                                                 | No                                                                                              | No                                                                               |
| Uses `Referer`               | No                                             | No                                                                                                  | Yes — third fallback, on by default                                                                                                     | No                                                                                              | No                                                                               |
| Tier order                   | `Origin` → `Sec-Fetch-Site`                    | n/a (single comparison)                                                                             | `Sec-Fetch-Site` → `Origin` → `Referer`                                                                                                 | n/a (single comparison)                                                                         | n/a                                                                              |
| Escape hatch                 | None (by design — don't set `origin`)          | `allowedOrigins` config                                                                             | `allowRequestsWithoutOriginCheck` (default `false`)                                                                                     | `csrf.trustedOrigins: ['*']` — but **not** for a missing `Origin`, and not for remote functions | Framework-dependent                                                              |
| Custom failure response      | No (fixed `403`)                               | No                                                                                                  | Yes — `failureResponse`                                                                                                                 | No                                                                                              | Framework-dependent                                                              |
| Automatic input validation   | **No** — handler validates its own args        | No                                                                                                  | No                                                                                                                                      | No — but remote functions take a Standard Schema                                                | Opt-in `.input()` validator                                                      |

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
  you opt in. tRPC requires you to attach a validator; `@thednp/rpc` and TanStack
  don't validate for you at all.
- **Its security model is explicitly authorization, not cross-origin.** The docs
  state plainly that "telefunctions are public and can be called by anyone", and
  that you protect each one with `throw Abort()` / `shield()`. We found **no
  documented origin or CSRF check** in its configuration surface — note that's
  *absence of evidence*, not a confirmed absence, so treat it as "unverified"
  rather than "none".

So on the cross-origin axis Telefunc would rank **below** `@thednp/rpc`, which at least
offers an opt-in allowlist; and on the validation axis it would rank **above**
everyone. If you want it as a full column, say so — it is a small addition once
the rest of the page is settled.

## Where our rpc is stronger

- **`Origin: null` is rejected whenever an allowlist is set.** Next.js shipped
  [`GHSA-mq59-m269-xvcx`](https://github.com/vercel/next.js/security/advisories/GHSA-mq59-m269-xvcx)
  ([CVE-2026-27978](https://nvd.nist.gov/vuln/detail/CVE-2026-27978), published
  2026-03-16, Moderate 5.3) for treating `origin: null` as a *missing* origin,
  which let sandboxed iframes and opaque contexts bypass the check instead of
  being validated as cross-origin. It affected `16.0.1`–`16.1.6` and is fixed in
  **`16.1.7`**: `null` is now preserved as a literal that can never equal a real
  host, so it is rejected unless `'null'` is explicitly allowlisted.
  `@thednp/rpc`'s exact-match allowlist never equals `null`, so it rejects by
  default and has no equivalent window.
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
- **No transport-level crash surface.** tRPC 11's WebSocket `connectionParams`
  validation had an unhandled throw that crashed the process —
  [`CVE-2025-43855`](https://github.com/trpc/trpc/security/advisories/GHSA-pj3v-9cm8-gvj8).
  `@thednp/rpc` has no WebSocket transport.

## Where the trade costs you

Everything here is a real cost, and none of it is hidden — but most of it is the
price of the capability above rather than a gap in it.

- **The check is opt-in.** With no `origin` configured there is no cross-origin
  enforcement at all. This is the one axis where TanStack or Next.js is the
  better fit, and the honest cost of a transport that refuses to guess your
  public origin. Setting it is one line.
- **Both headers absent ⇒ allowed.** curl and native clients keep working by
  design; that is also a hole a header-stripping attacker can use *if* they can
  strip `Sec-Fetch-Site` too. Setting `origin` does not close this one — it is
  the deliberate curl/native hole, and closing it would mean breaking non-browser
  clients. Worth being precise about the field here: **Next.js now behaves the
  same way** — it lets an absent `Origin` through with a dev warning, on the
  reasoning that a handcrafted request cannot carry unwilling victim credentials.
  So this is a shared posture, not a gap unique to `@thednp/rpc`. TanStack Start
  is the one that differs, rejecting a request carrying *no* signal at all.
- **Origin matching is case-sensitive.** DNS names are case-insensitive
  (RFC 1035 §2.3.3), so `HTTPS://APP.EXAMPLE.COM` is rejected against
  `https://app.example.com`. Next.js had the same bug class and fixed it in
  [PR #89127](https://github.com/vercel/next.js/pull/89127) (merged 2026-01-29),
  so its allowlist is now case-insensitive. A pinned test documents
  `@thednp/rpc`'s current behaviour; it is a known sharp edge, not an oversight.
- **Literal origins only** — no `*.example.com` wildcards, as Next.js's
  `allowedOrigins` allows (it supports both `*` for a single label and `**` for
  multiple). Enumerate the subdomains you actually serve.
- **No `Referer` tier — deliberately.** TanStack falls back to `Referer`; `@thednp/rpc` does not, because [Google's own guidance](https://web.dev/articles/referrer-best-practices) is explicit: *"Don't use referrers for Cross-Site Request Forgery (CSRF) protection… use `Origin` and `Sec-Fetch-Site`."* `@thednp/rpc` consults exactly those two.
  The practical cost is that a user sending `Referrer-Policy: no-referrer` with `Sec-Fetch-Site` stripped is treated as a native client and allowed.
- **No server-side batching limits exist to abuse** — but also no batching, so tRPC's unbounded-batch complaint ([#5825](https://github.com/trpc/trpc/issues/5825)) has no analogue.
- **No automatic input validation.** Telefunc's `shield()` and tRPC's `.input()` both give you runtime argument checking; `@thednp/rpc` leaves it entirely to the handler.
  `wiki/client-usage.md` shows the resulting pattern — validate inside the
  function, and return `{ error }` as data rather than throwing.

## What none of these do for you

All of these hand the following to the host. `@thednp/rpc` is the most explicit about it:

- **Authentication / authorization** — middleware registered before
  `createRPCMiddleware()`.
- **Rate limiting** — see [Best Practices](./best-practices.md#rate-limiting).
- **Security headers** (CSP, HSTS, `X-Frame-Options`) — reverse proxy or host.
- **Body size limits** — the host framework's parser. `@thednp/rpc`'s raw `readBody` path
  has **no built-in cap**; see [Security — Body Size Limits](./security.md#body-size-limits)
  and note the `examples/spa/body-limit.ts` reference implementation.
- **Input validation** — the handler validates its own arguments. (tRPC makes
  this ergonomic with `.input()` validators, but still opt-in; there is "no magic
  here".)

---

## Choosing between them

- Want **CSRF protection with zero configuration** in a React app you don't
  already have a framework for → **TanStack Start**.
- Already in **Next.js** → its Server Actions check is on by default and needs no
  configuration, so there is no reason to add a second transport for this. Two
  caveats worth knowing: it fails **open** on a request with no `Origin` (as
  `@thednp/rpc` does), and it only covers POST, so it does nothing for a GET-based
  transport.
- Want a **typed API with batteries-included validation ergonomics** and control
  over batching/caching → **tRPC**.
- Want a **transport that stays out of the way**: framework-agnostic, no runtime
  lock-in, multi-prefix, and you will configure `origin` yourself → **`@thednp/rpc`**. Turn
  `origin` on; that is the whole opt-in.

> **The honest framing:** `@thednp/rpc` is not "more secure than Next.js". It is a smaller
> surface that makes fewer decisions for you — and the one decision that matters
> most (the cross-origin check) is one you have to make explicitly.

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
