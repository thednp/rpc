# Wire Protocol

What actually goes over the network. Useful when debugging with `curl`, building native clients, or writing tests — the generated client modules handle all of this for you, but knowing the contract helps you verify and reason about your RPC layer.

## Endpoint Shape

Every server function is reachable at:

```
/{rpcPrefix}/{functionName}
```

- `rpcPrefix` — the resolved prefix, always the first path segment. Resolution order is the explicit option → the global prefix published by `setGlobalPrefix` / `loadRPCConfig` → `__rpc`, so a global prefix changes the endpoint with no change to `rpc.config.ts`.
- `functionName` — the registered name from `createServerFunction("some-name", ...)`.

**Express:** `POST /__rpc/add-numbers` · `GET /__rpc/get-server-time`
**Hono/Fastify/Koa adapters:** use the same shape.

## HTTP Methods

| Method | When                          | Arguments location                                                                              |
|---------|--------------------------------|--------------------------------------------------------------------------------------------------|
| `POST`  | Default for all functions.      | JSON array in the request body.<br/>`text/plain` functions send the single first argument as raw text.<br/>`application/x-www-form-urlencoded` functions send the single object argument as `key=value&...`. |
| `GET`   | Only when `{ method: 'GET' }`.  | `?args=<url-encoded JSON array>` query parameter (no body allowed on `GET`).                        |

Requests whose method doesn't match the function's configured method are rejected with `405 Method Not Allowed`.

## Request Encodings

### POST + `application/json` (default)

The request body is a **bare JSON array of positional arguments** — `JSON.stringify(args)`:

```bash
# sayHi(name)  →  POST /__rpc/say-hi  body: ["World"]
curl -s -X POST http://localhost:5173/__rpc/say-hi \
  -H 'Content-Type: application/json' \
  -d '["World"]'
```

> The body is the array itself, **not** `{"args":[...]}` or `{"data":[...]}`. This is the most common mistake when hand-writing requests — the client sends `JSON.stringify(args)`.

### POST + `text/plain`

Only the first argument is sent, as a raw string:

```bash
# sayHi(name) with { contentType: 'text/plain' }  →  body: World
curl -s -X POST http://localhost:5173/__rpc/say-hi \
  -H 'Content-Type: text/plain' \
  -d 'World'
```

### POST + `application/x-www-form-urlencoded`

Designed for native HTML forms. The generated client serializes the single object argument with `new URLSearchParams(args[0]).toString()`:

```ts
// createUser({ name: "artae", job: "developer" })
//   with { contentType: 'application/x-www-form-urlencoded' }
//   →  POST /__rpc/create-user  body: name=artae&job=developer
const { data } = await createUser({ name: "artae", job: "developer" });
```

The adapters parse `key=value&key2=value2` into an object using `URLSearchParams` — every value arrives as a **string** (`"artae"`, `"42"`), and repeated keys collapse to the last value. If your framework's urlencoded parser (`express.urlencoded()`, `@fastify/formbody`, `koa-body`) runs **before** the RPC middleware, its pre-parsed object is used directly:

```bash
# createUser(fields) →  args[0] = { name: "artae", job: "developer" }
curl -s -X POST http://localhost:5173/__rpc/create-user \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'name=artae&job=developer'
```

> Use `multipart/form-data` for anything beyond flat string fields (file uploads, nested values); urlencoded is the lightweight option for simple text forms.

#### Content-Type enforcement

The middleware validates the request's `Content-Type` against the function's declared `contentType` **before** parsing the body. Mismatches are rejected with `415 Unsupported Media Type` so a body is never parsed with the wrong encoding:

- **JSON and text functions are enforced strictly** — the declared type must match exactly (case-insensitive, after stripping `charset`/`boundary` parameters). A `curl` call with a wrong header is rejected instead of silently mis-parsing.
- **Form functions are lenient**: `multipart/form-data` and `application/x-www-form-urlencoded` are interchangeable, so a native urlencoded `<form>` submission reaches a multipart-declared endpoint (progressive-enhancement nojs flow) without a 415.
- **Requests without a `Content-Type` header are exempt** (url bar, `GET`, legacy clients) — enforcement only kicks in when the header is actually present.

```bash
# json-declared function → 415
curl -s -X POST http://localhost:5173/__rpc/say-hi \
  -H 'Content-Type: text/plain' -d 'World'
# {"error":"Unsupported Media Type"}

# multipart-declared function accepts a native urlencoded form submission
curl -s -X POST http://localhost:5173/__rpc/submit-contact \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'name=artae&message=Hello'
```

### POST + `multipart/form-data`

Used for file uploads. The generated client sends the first argument — a `FormData` instance — as the request body; the browser sets the boundary, so the client never sets `Content-Type`:

```ts
const form = new FormData();
form.append("file", fileInput.files[0]);
const { data } = await uploadFile(form); // → POST /__rpc/upload-file (multipart/form-data)
```

Server-side, the body must be parsed into fields before your handler sees them (Node has no built-in multipart parser). Two paths:

**1. Framework parser middleware (recommended)** — register it **before** the RPC middleware, and the adapter forwards the parser's output as the function argument.

> **Know where your parser puts the file.** The adapter forwards `req.body` only. `multer` writes uploads to `req.file` / `req.files`, **not** `req.body`, so `args[0]` contains your *text fields* and no file — read `req.file` off the request yourself (via the request context) rather than expecting it in the argument. Parsers that put everything in one object (Koa's `koa-body`, Hono's `formData()`, Fastify's `@fastify/multipart` with an injected fields object) do arrive intact.

```ts
// Express + multer: the file is on req.file, the text fields in args[0]
import multer from "multer";
import { getRequestContext } from "@thednp/rpc/server";

app.use(multer().single("file"));            // before the RPC middleware
app.use(createRPCMiddleware({}));

export const uploadFile = createServerFunction("upload-file", async (signal, fields) => {
  const { req } = getRequestContext();
  const file = (req as Express.Request).file; // NOT in `fields`
  return { name: file?.originalname, caption: fields.caption };
});
```

```bash
curl -s -X POST http://localhost:5173/__rpc/upload-file \
  -H 'Content-Type: multipart/form-data; boundary=----xyz' \
  -F 'file=@./photo.jpg' -F 'caption=hello'
```

Note `hono/body-limit` is a request-size **limiter**, not a multipart parser — Hono reads multipart with `c.req.formData()`. Use one to cap size, the other to parse.

**2. Raw body (`{ raw: "<multipart text>" }`)** — without a parser registered, the raw body is passed as `{ raw: <string> }`. Parse it inside your handler with a battle-tested parser — for plain `node:http` servers, [`busboy`](https://github.com/mscdex/busboy) (streaming, powers `multer`) or [`formidable`](https://github.com/node-formidable/formidable) work on the raw string:

```ts
import busboy from "busboy";

export const uploadFile = createServerFunction(
  "upload-file",
  async (_signal, payload: FormData & { raw: string }) => {
    const boundary = payload.raw.match(/^--([^\r\n]+)/)?.[1];
    const bb = busboy({
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    const fields: Record<string, string> = {};
    bb.on("field", (name, val) => { fields[name] = val; }); // file parts → bb.on("file", ...)
    bb.end(payload.raw);
    await new Promise((res) => bb.on("close", res));
    return fields;
  },
  { contentType: "multipart/form-data" },
);
```

> For **text-only forms** a small hand-rolled parser (split on the boundary) is fine — that's what the SPA example does. For **untrusted file uploads**, always use a battle-tested parser; hand-rolling multipart parsing for files is a security liability.

### GET + `?args=`

Arguments URL-encode to a JSON array in the query string:

```bash
# getServerTime(locale) with { method: 'GET' }  →  ?args=["en-US"]
curl -s 'http://localhost:5173/__rpc/get-server-time?args=%5B%22en-US%22%5D'
```

## Response Envelope

A successful call always returns `{ "data": <result> }`:

```json
{ "data": { "locale": "en-US", "time": "1:23:45 PM", "iso": "2026-08-05T17:23:45.000Z" } }
```

The generated client unwraps it — `await data` resolves to `<result>`.

For native HTTP clients (Deno, Bun, curl-equivalent), use the `unwrapEnvelope<T>` helper from `@thednp/rpc/helpers` to parse the response:

```ts
import { unwrapEnvelope } from '@thednp/rpc/helpers';

const json = await res.json();
if (!res.ok) throw new Error(json.error);  // transport-level failure
const result = unwrapEnvelope<string>(json);
```

`unwrapEnvelope` also throws on a top-level `error` body (the shape returned for `400`/`403`/`404`/`405`/`415`/`500`), but resolves normally for `{ data: { error } }` — a `200` carrying a validation outcome as its result.

See [Client Usage — Native HTTP Clients](./client-usage.md#native-http-clients--unwrapenvelopet) for the full pattern.

## Malformed Bodies

A body that arrives with `Content-Type: application/json` but does not parse is a **client error**: every adapter answers `400 Bad Request` with `{ error: "Bad Request" }`.

The distinction that matters is *declared* versus *undeclared*:

- **Declared JSON** — parsed strictly. Invalid JSON is a `400`, never a silent success. This is what every supported host does: Express `body-parser` (`entity.parse.failed`), Fastify (`FST_ERR_CTP_INVALID_JSON_BODY`), koa-bodyparser, and h3's own `readBody`. Hono has no opinion (see [honojs/hono#578](https://github.com/honojs/hono/pull/578)), so rpc answers `400` on its behalf when it does the parsing.
- **No `Content-Type` header, or a non-JSON one** — sniffed leniently: the body is parsed if it happens to be valid JSON, and otherwise passed through as text. This is deliberate, so `curl` and the nojs `<form>` fallback keep working when they send JSON without declaring it.

## Error Responses

| Status | Meaning                                    | Body                              |
|---------|---------------------------------------------|------------------------------------|
| `200`   | Success (with `{ data }`), **or** a function that returned `{ error: ... }` as its result. | `{ data: ... }` / `{ data: { error: ... } }` |
| `403`   | The optional `origin` allowlist rejected the request (see [Security — Origin Validation](./security.md#origin-validation)). **Checked before the function lookup**, so it also answers for unknown function names. Only reachable when `origin` is configured. | `{ error: "Forbidden" }` |
| `404`   | Function not registered.                    | `{ error: "Function not found" }` |
| `405`   | Method doesn't match (`POST` vs `GET`).     | `{ error: "Method Not Allowed" }` |
| `415`   | Request `Content-Type` doesn't match the function's declared `contentType` (json/text functions). | `{ error: "Unsupported Media Type" }` |
| `400`   | The request is malformed: a declared-JSON body that does not parse, or a GET `?args=` that is either not valid JSON or not an array (GET functions only). | `{ error: "Bad Request" }` |
| `413`   | Request body exceeded the host's configured size limit. Only reachable when a body-limit middleware is registered (e.g. `express.json({ limit })`, `hono/body-limit`, h3's `bodyLimit`). | `{ error: "Payload Too Large" }` |
| `500`   | Handler threw.                              | `{ error: "Internal Server Error" }` — always, even in development, for unexpected exceptions; in development `RPCError` payloads include `code`/`data` |

### Validation errors are data, not status codes

When you validate input inside a function and return `{ error: ... }`, it's a **200 with `{ data: { error: ... } }`** — the validation outcome travels as data so it can carry structured details (e.g. valibot's field-level errors):

```bash
# addNumbers with invalid payload → 200, error inside data
curl -s -X POST http://localhost:5173/__rpc/add-numbers \
  -H 'Content-Type: application/json' \
  -d '["{\"a\":\"x\",\"b\":3}"]'
# {"data":{"error":{"a":["Invalid type: Expected number but received \"x\""]}}}
```

The client's `handleResponse` returns this as the resolved `data` — you inspect `result.error` in your code. Only **transport failures** (403/404/405/415/500, network errors) reject the `data` promise.

## Cancellation

1. The client calls `cancel("reason")` → aborts the `AbortController` bound to that fetch — the browser cancels the request.
2. The server function's `AbortSignal` fires → `signal.aborted` / `signal.throwIfAborted()` respond.

Client-side and server-side cancellation are the same signal object, connected over HTTP/1.1 by the browser closing the request:

```ts
const { data, cancel } = longTask("node-1");
cancel("user aborted");  // aborts the fetch; server sees signal.aborted = true
```

On a client disconnect (tab closed, request torn down), the middleware calls `cancel(CLIENT_DISCONNECTED)` server-side so long-running handlers stop promptly instead of grinding on.

## Testing with curl (complete example)

```bash
# POST + JSON args (default)
curl -s -X POST http://localhost:5173/__rpc/add-numbers \
  -H 'Content-Type: application/json' \
  -d '["{\"a\":2,\"b\":3}"]'

# POST + text/plain
curl -s -X POST http://localhost:5173/__rpc/say-hi \
  -H 'Content-Type: text/plain' \
  -d 'World'

# GET with args in the query string
curl -s 'http://localhost:5173/__rpc/get-server-time?args=%5B%22en-US%22%5D'
```

To build the `?args=` value: `encodeURIComponent(JSON.stringify(["en-US"]))` → `%5B%22en-US%22%5D`.

## Related

- [Client Usage](./client-usage.md) — the generated `{ data, cancel }` API
- [Server Functions](./server-functions.md) — methods, content types, and `createServerFunction` options
- [Security](./security.md) — method enforcement, prefix boundaries, origin checks

> **Next:** [Adapters](./adapters.md) — mounting the RPC middleware on your framework of choice.

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
- [Comparison](./comparison.md) — How the cross-origin boundary compares to Next.js, TanStack Start, and tRPC
- [Best Practices](./best-practices.md) — Tips and best practices
