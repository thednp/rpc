# Progressive Enhancement: Native Form Fallback (nojs)

RPC endpoints can double as the `action` of a plain HTML `<form>`. A browser with
JavaScript disabled submits it natively, and rpc answers with a
**Post/Redirect/Get `303`** instead of a JSON body a browser would render as raw
text. The failure comes back as a flash the page renders on the next load.

This is built in. You declare a `fallback` target on the function; the adapters
in the dispatch do the rest, on all five of them.

<!-- LLMs only
```
no JS?
  HTML <form action="/@demo/submit-contact" method="post">
    → POST, urlencoded, Accept: text/html (and Sec-Fetch-Dest: document)
    → rpc dispatch, inside the origin check
    → validate → 303 redirect
        ├─ ok   → Location: https://github.com/.../discussions/new?…   (handler's own redirect)
        └─ bad  → Location: /?__flash=…                             (flash carries errors)
                 → the page reads it with decodeFormFlash() from @thednp/rpc/flash
```
-->

The form is a plain `<form>` pointing straight at the RPC endpoint — no special
client, no hidden fields:

```html
<form action="/@demo/submit-contact" method="post" novalidate>
```

## Declaring the fallback

```ts
import { createServerFunction } from "@thednp/rpc/server";
import { schema, field } from "@thednp/rpc/server";

export const submitContact = createServerFunction(
  "submit-contact",
  async (signal, payload: ContactOutput) => {
    // …
  },
  {
    contentType: "application/x-www-form-urlencoded",
    schema: schema({ email: field.string(), message: field.string() }),
    fallback: {
      to: "/contact",
      // Only these come back in the URL. Default: replay nothing.
      replay: ["email"],
    },
  },
);
```

`fallback` also accepts a bare string (`fallback: "/contact"` — one path for both
outcomes) or a function choosing per outcome
(`fallback: (o) => o.status === "ok" ? "/thanks" : "/contact"`).

**A `schema` is what makes this worthwhile.** Validation runs in the dispatch
before the handler, so a rejected submission is flashed field-by-field. Without
one, only what the handler *throws* is reflected.

## Why the redirect is `303`, and where state goes

A `POST` that redirects would re-posts on refresh, so the status is `303 See
Other`. The failure rides in a single `__flash` query parameter on the
`Location`, capped at 4 KiB — the browser re-requests that URL, so it becomes a
request line, and nginx's default `large_client_header_buffers 4 8k` would
answer a `414`. Past the cap the flash is **dropped, not truncated**: the
redirect still happens and the form re-renders empty.

```json
{ "status": "error",
  "errors": { "email": ["expected a string"] },
  "message": "input did not match the function's schema" }
```

Read it with the client-safe codec — it works in the browser as well as in SSR:

```ts
import { FLASH_PARAM, decodeFormFlash } from "@thednp/rpc/flash";

const flash = decodeFormFlash(new URLSearchParams(location.search).get(FLASH_PARAM));
// null when absent, oversized, or malformed — never throws
```

`@thednp/rpc/flash` is deliberately separate from `@thednp/rpc/server`: a
no-JS fallback has to be readable on **both** sides of the wire, and the server
entry pulls in `bodyKind` and `isRPCError`. The split is by dependency, not
convenience.

## The detection rule: the navigation, not the content type

This is the part people get wrong. **A form-declared function is called by two
different clients that both send a form content type** — a native `<form>` posts
`application/x-www-form-urlencoded`, and the generated client stub posts
`multipart/form-data` via `fetch`. Keying on content type alone cannot tell them
apart, and a fallback that did would hand every browser-side caller a `303`
where it expected a rejection.

So the discriminator is whether the request is a **document navigation**:

1. `POST`, and a form content type; then
2. if either `Sec-Fetch-Dest` or `Sec-Fetch-Mode` is present, **they decide** —
   a navigation is `document` / `navigate`. An absent header within a present
   pair is not treated as disagreement.
3. otherwise `Accept` decides, and must include `text/html`.

Fetch metadata is consulted first because it is strictly more precise: it
catches the false positive `Accept` alone cannot — a `fetch` that requests HTML.
`curl` sends neither header, so `Accept` remains the signal for non-browser
clients.

The demo is the worked example: it declares
`application/x-www-form-urlencoded` for **both** clients, so the same request
differs only by `Accept`. A stub call gets `422`; a navigation gets `303`.

## Replaying values safely

Values are replayed **only when named**, via `fallback.replay`. The default is
to replay nothing.

That default is the point. A URL is a poor home for user data: it reaches
browser history, the `Referer` of the next navigation, and every access log in
between, and rpc cannot know which of your fields are secrets. Naming them is a
sentence you have to write, and that is the whole consent mechanism. In the
demo, `title` and `message` are deliberately excluded and the user retypes them.

`replay` accepts primitives only. A nested object would serialise to
`[object Object]`, so it is dropped rather than mangled.

Even when you do replay, whitelisting again on the way back is cheap insurance —
those values arrived in a URL, so they are untrusted input:

```ts
for (const field of CONTACT_FIELDS) {
  const value = flash?.values?.[field];
  if (typeof value === "string") values[field] = value;
}
```

## Outcomes

A normal return is a success; a thrown `RPCError` (or a typed subclass) is
flashed from its `hint` plus any per-field `issues`. An **unexpected throw stays
a `500`** and is never flashed — a stack trace must not be laundered into a
friendly redirect, and a genuine fault should look like one.

For a success the flash is omitted entirely, so the redirect is a bare path.

**A handler may issue its own redirect**, through the request context:

```ts
import { getRequestContext } from "@thednp/rpc/server";

getRequestContext().redirect("https://example.com/elsewhere");
```

That takes precedence over the fallback, which matters when the target is
**off-origin**: `fallback.to` is deliberately restricted to root-relative paths
so an author cannot turn it into an open redirect. The demo's success path
redirects to a GitHub discussion this way, and `fallback.to` only ever points at
`/`.

A handler redirect is **unconditional** — it also answers `303` to a stub's
`fetch`, which then follows the `Location` (and on an off-origin target, fails
with a CORS error). If the same function should PRG for navigations but return
`{ data }` to JS callers, gate it with `isNativeFormNavigation`; see
[Redirects](./server-functions.md#redirects-redirect).

## What it does not change

- A **JSON-declared** function receiving a form body still answers `415`. The
  fallback activates only for functions that set it, which in practice means
  form-declared ones.
- A **`fetch` from the generated stub** is untouched on every path — same
  content type, different navigation signal.
- A **`400`** for a malformed body and a **`405`** for a method mismatch are
  unchanged.

## The origin check applies — and that is the point

Because the fallback runs *inside* the dispatch, it is subject to the cross-origin
check like any other request. An app-layer middleware mounted *before* the RPC
middleware is not, and is therefore a CSRF hole: it will answer a form post from
any origin.

Two consequences to plan for:

- **`curl` and other headerless clients** get `403` unless you set
  `allowHeaderless: true`. A browser navigation sends `Origin`, so it is fine.
- **Behind a proxy, preserve `Host`.** `"self"` compares the origin's **host and
  port** against `Host`, so a proxy that rewrites `Host` to an internal name
  turns every check into a `403` — and native form submissions fail with
  `{"error":"Forbidden"}` and no other clue. `changeOrigin` defaults to `true` in
  `http-proxy-middleware`, and Vite's `preview.proxy` needs
  `changeOrigin: false` for exactly this reason. Where the ingress cannot
  preserve `Host`, name the public origins with `origin`.

See [Security — Origin Validation](./security.md) for the full policy.

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite`
- [Getting Started](./getting-started.md) — Installation, structure, first function
- [Configuration](./configuration.md) — `rpc.config.ts` and `vite.config.ts`
- [Server Functions](./server-functions.md) — `createServerFunction` and the `fallback` option
- [Middleware](./middleware.md) — Universal middleware via the request context
- [Native Form Fallback](./nojs-fallback.md) — This page
- [Client Usage](./client-usage.md) — Client-side usage and `unwrapEnvelope`
- [Wire Protocol](./wire-protocol.md) — The HTTP contract, including the `303`
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Origin validation and body limits
- [Best Practices](./best-practices.md) — Production patterns
