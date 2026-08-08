# Wire Protocol

What actually goes over the network. Useful when debugging with `curl`, building native clients, or writing tests — the generated client modules handle all of this for you, but knowing the contract helps you verify and reason about your RPC layer.

## Endpoint Shape

Every server function is reachable at:

```
/{rpcPrefix}/{functionName}
```

- `rpcPrefix` — the prefix from `rpc.config.ts` (default `__rpc`).
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

### POST + `multipart/form-data`

Used for file uploads. The generated client sends the first argument — a `FormData` instance — as the request body; the browser sets the boundary, so the client never sets `Content-Type`:

```ts
const form = new FormData();
form.append("file", fileInput.files[0]);
const { data } = await uploadFile(form); // → POST /__rpc/upload-file (multipart/form-data)
```

Server-side, the body must be parsed into fields before your handler sees them (Node has no built-in multipart parser). Two paths:

**1. Framework parser middleware (recommended)** — register it **before** the RPC middleware (Express: `multer`; Fastify: `@fastify/multipart`; Koa: `koa-body`; Hono: `hono/body-limit` helpers). The adapter forwards the parser's fields object as the function argument:

```bash
# uploadFile(fields) with a multer-parsed body  →  args[0] = { file: <File> }
curl -s -X POST http://localhost:5173/__rpc/upload-file \
  -H 'Content-Type: multipart/form-data; boundary=----xyz' \
  -F 'file=@./photo.jpg'
```

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

## Error Responses

| Status | Meaning                                    | Body                              |
|---------|---------------------------------------------|------------------------------------|
| `200`   | Success (with `{ data }`), **or** a function that returned `{ error: ... }` as its result. | `{ data: ... }` / `{ data: { error: ... } }` |
| `404`   | Function not registered.                    | `{ error: "Function not found" }` |
| `405`   | Method doesn't match (`POST` vs `GET`).     | `{ error: "Method not allowed" }` |
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

The client's `handleResponse` returns this as the resolved `data` — you inspect `result.error` in your code. Only **transport failures** (404/405/500, network errors) reject the `data` promise.

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
- [Client Usage](./client-usage.md) — Client-side usage
- [Wire Protocol](./wire-protocol.md) — The HTTP contract behind the generated clients (curl debugging)
- [Adapters](./adapters.md) — Framework adapters
- [Security](./security.md) — Security hardening
- [Best Practices](./best-practices.md) — Tips and best practices
