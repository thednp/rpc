# Progressive Enhancement: Native Form Fallback (nojs)

RPC endpoints can double as the `action` of a plain HTML `<form>`. A browser with JavaScript disabled (or a crawler, or a UA that hasn't run your bundle) submits the native way — a `POST` with `application/x-www-form-urlencoded` and `Accept: text/html` — and the server responds with a **303 redirect** instead of JSON. JavaScript users get the faster, richer fetch-based path; everyone else still works. This is the demo's contact form, and it's a pattern you can copy into your own app.

```
no JS?
  HTML <form action="/@demo/submit-contact" method="post">
    → POST, urlencoded, Accept: text/html
    → app-layer fallback middleware (mounted BEFORE the RPC middleware)
    → validate → 303 redirect
        ├─ ok  → Location: https://github.com/.../issues/new?…
        └─ bad → Location: /?name=..&errors=..   (page recovers values + shows errors)
```

## Why it works

Three features of this library make the pattern possible:

1. **Native form content type.** A function declared `multipart/form-data` also accepts `application/x-www-form-urlencoded` submissions — the two form encodings are interchangeable (see [Content-Type Enforcement](./security.md#content-type-enforcement)). The urlencoded branch parses `key=value&key2=value2` back into an object via `URLSearchParams`.
2. **The `redirect` helper.** The fallback answers with a **`303 See Other`** Post/Redirect/Get redirect, defaulting to the PRG-correct status code. The raw-node path works on every surface — Vite/Connect dev middleware, a custom `node:http` server, and Netlify's `serverless-http` mock (which lacks a native `.redirect()`). See [Redirects](./server-functions.md#redirects-redirect).
3. **Shared validation.** Validation isn't duplicated: the RPC server function and the nojs fallback both call the same schema/validator, so both paths produce identical error objects and identical issue URLs.

## The detection rule

The fallback middleware must distinguish a **native form navigation** from a **fetch-based RPC call** — only the former should be intercepted:

| Signature | Result |
| --------- | ------ |
| `POST` + path matches the function route + urlencoded body + `Accept: text/html` | Native navigation → intercept |
| `POST` + `multipart/form-data` (or JSON) — what the generated JS client sends | RPC call → skip, let the RPC middleware handle it |

The fetch client deliberately sends `multipart/form-data` with its default `Accept` of anything, so it never matches the fallback.

## Anatomy of `createFormFallback`

From `demo/src/lib/form-fallback.ts` — a factory that returns a Connect-compatible middleware for a given RPC route, mounted **before** the RPC middleware:

```ts
import { readBody, redirect } from "@thednp/rpc/express";

export const createFormFallback = ({ rpcPrefix, functionName }) => {
  const route = `/${rpcPrefix}/${functionName}`;

  return async (req, res, next) => {
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const accept = req.headers.accept ?? "";
    if (!isFormNavigation(req, contentType, accept, route)) return next?.();

    const { data } = await readBody(req);               // urlencoded → parsed object
    const fields = /* keep string values only */;

    const result = validateContactForm(fields);          // shared schema
    if (result.ok) {
      redirect(res, buildIssueUrl(result.output) + "#contact"); // 303
      return;
    }

    const search = new URLSearchParams(fields);
    search.set("errors", Object.keys(result.errors).join(","));
    redirect(res, `/?${search.toString()}`);              // 303 back to the form
  };
};
```

`readBody` parses the urlencoded stream (or uses the framework's pre-parsed body when a body parser already ran). `redirect` defaults to `303 See Other`.

## Recovering the form state

The failure redirect points the browser back at the same page with `?name=..&errors=..`. The server renderer and the client hydration both run `parseFormState(location.search)` — see `demo/src/lib/contact-form.ts`:

- Only **known field names** are read back from the query string (a whitelist), and
- error messages come from a **static map** — never from the URL.

So a crafted query string can't inject markup or arbitrary messages. The server-rendered page shows the red errors and re-fills the inputs; on the client the hydration step does the same, so there's no flash.

## Mounting it

The fallback is a plain Connect/Express middleware, so it mounts anywhere the RPC middleware can:

- **Vite dev server** — `server.middlewares.use(formFallback)` in a plugin's `configureServer` (see `demo/vite.config.ts`)
- **Your own `node:http` server** — in the request handler before the RPC middleware (see `demo/server.ts`)
- **serverless** — inside the function handler before `createRPCMiddleware` (see `demo/netlify/functions/rpc.ts`)

Order matters: **always mount the fallback before the RPC middleware**, so matched navigations never reach the JSON layer.

## Key takeaways

- Progressive enhancement is an app-layer concern: the library provides the pieces (`redirect`, lenient form content types, `readBody`, `createRPCMiddleware`), not a built-in fallback you have to configure.
- Intercept only real navigations (`POST` + urlencoded + `Accept: text/html`) so fetch calls flow through untouched.
- Validate with the **same schema** in both paths so errors stay identical.
- Recover state through a **whitelist + static error map** — never trust the query string.

> **Next:** [Client Usage](./client-usage.md) — calling the functions from your client code.

---

## Table of Contents

- [Quick Start](./quickstart.md) — Rebuild the Express SSR example from `create-vite` in under a minute
- [Getting Started](./getting-started.md) — Installation, project structure, and your first function
- [Configuration](./configuration.md) — Configuration reference
- [Server Functions](./server-functions.md) — Creating server functions
- [Native Form Fallback](./nojs-fallback.md) — Making RPC endpoints work as a no-JS `<form>` action (progressive enhancement)
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
- 