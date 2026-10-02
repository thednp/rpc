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
function createServerFunction<TArgs extends JsonArray, TResult>(
  name: string,
  handler: ServerFunctionInit<TArgs, TResult>,
  options?: {
    contentType?: 'application/json' | 'text/plain' | 'application/x-www-form-urlencoded' | 'multipart/form-data',
    credentials?: "same-origin" | "include" | "omit",
    method?: "GET" | "POST",
    rpcPrefix?: string,
      fallback?: string | FormFallbackOptions,
  }
): ClientFunction<TArgs, TResult>;
```

`ClientFunction` is what you get back — the `{ data, cancel }` handle described above. It is a different type from `ServerFunctionInit`, which is the *handler* signature. `TArgs` defaults to `JsonArray` and the handler is `ServerFunctionInit<TArgs, TResult>` (an `AbortSignal` followed by your arguments).

> **Note:** `TResult` is unconstrained (no `extends JsonValue` requirement). The actual wire protocol serialization still uses JSON, but the relaxed type allows wrapper libraries to define server functions with non-JSON return types without double-casts.

### Parameters

- **`name`** (`string`) — The registered name used in RPC routing.
- **`handler`** (`(signal: AbortSignal, ...args: JsonArray) => Promise<T>`) — The actual implementation. The first argument is always an `AbortSignal`; remaining arguments come from the client. The return value must be JSON-serializable.
- **`options`** — Optional credentials, serialization strategy, HTTP method, and RPC prefix
  * `contentType?: 'application/json' | 'text/plain' | 'application/x-www-form-urlencoded' | 'multipart/form-data'` - Defaults to `'application/json'`.
  * `credentials?: "include" | "same-origin" | "omit"` - Defaults to `'same-origin'`.
  * `fallback?: string | { to: string | (outcome) => string; replay?: string[] }` —
    enables the no-JS `<form>` flow for this function. Absent by default.
    See [No-JS Form Fallback](#no-js-form-fallback-fallback).
  * `method?: "GET" | "POST"` - Defaults to `'POST'`.
  * `rpcPrefix?: string` - Registers the function under a custom prefix so multiple RPC instances can coexist (versioned/namespaced APIs) — the same name may be reused under different prefixes. Omitted, it resolves to the **global prefix** (whatever `setGlobalPrefix` / `loadRPCConfig` published) and only then to `'__rpc'`, so the effective default follows your config rather than being hard-coded. Every adapter resolves its dispatch prefix the same way, so a registered function is always reachable. See [Multi-Prefix Support](./multi-prefix-guide.md) and [Configuration](./configuration.md#loadrpcconfig).

### Content Types

- `'application/json'` (default) — arguments travel as a JSON array in the request body.
- `'text/plain'` — the single argument (or `JSON.stringify` of the args array) travels as plain text.
- `'application/x-www-form-urlencoded'` — designed for native HTML forms: the generated client serializes the single object argument with `new URLSearchParams(args[0]).toString()`, so a `<form>` can POST straight to your RPC endpoint without client-side serialization. Server-side, the adapters parse `key=value&key2=value2` into an object with `URLSearchParams`; if you register your framework's urlencoded parser (`express.urlencoded()`, `@fastify/formbody`, `koa-body`) **before** the RPC middleware, the pre-parsed object is used directly. Each value is a string (repeated keys collapse — see [Wire Protocol — urlencoded](./wire-protocol.md#post--applicationx-www-form-urlencoded)).
- `'multipart/form-data'` — designed for file uploads. The generated client sends the `FormData` you pass as the first argument (the browser sets the boundary — never set `Content-Type` yourself). Server-side, Node has no built-in multipart parser: register your framework's parser middleware (`multer`/`express-fileupload`, `@fastify/multipart`, `koa-body`, or Hono's `hono/body-limit` + `formData` helpers) **before** the RPC middleware, and the adapter forwards the parsed fields object as the function's argument. Without a parser, the raw multipart body arrives as `{ raw: <string> }` — parse it inside the handler with `busboy` or `formidable` (see [Wire Protocol — Multipart](./wire-protocol.md#post--multipartform-data)).

> **`multipart/form-data` and `schema` cannot be combined today.** They are each
> documented on their own, and together they cannot work: a `schema` validates
> `args[0]`, and for multipart `args[0]` is the `{ raw: <string> }` object rpc
> hands through, so any schema describing your fields rejects it with a `422` on
> the path `raw`. Pinned as current behaviour in `examples/advanced/verify.mjs`
> (section D), so that changing it is a deliberate decision rather than an
> accident. Workarounds: register a host multipart parser **before** the RPC
> middleware, which makes the pre-parsed fields object the argument and the
> schema then applies normally; or use `application/x-www-form-urlencoded`, which
> rpc parses itself.

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

Server functions receive raw, untrusted client data. Pass a `schema` and rpc validates **before the handler is entered** — a rejected input is a `422`, never a call into your code with garbage.

### The `schema` option

`schema` accepts any [Standard Schema](https://standardschema.dev) — zod, valibot, arktype, effect `Schema`, or a hand-rolled `{ "~standard": … }` object. There is no adapter and no per-library branch anywhere in rpc — see [How rpc runs it](#how-rpc-runs-it) for what that means in practice.

```ts
import { z } from "zod";
import { createServerFunction } from "@thednp/rpc/server";

const AddSchema = z.object({
  a: z.union([z.string(), z.number()]),
  b: z.union([z.string(), z.number()]),
});

export const add = createServerFunction(
  "add",
  async (signal, { a, b }) => Number(a) + Number(b),
  {
    schema: AddSchema,
    // A form sends strings; say so once, instead of at every call site.
    hint: "a and b are numbers; the form sends strings",
  },
);
```

The same option, three syntaxes:

| validator | declaration | note |
| --- | --- | --- |
| **zod** | `z.object({ a: z.number() })` | builder chain |
| **valibot** | `v.object({ a: v.number() })` | value-first, composes with `v.pipe` for coercion |
| **arktype** | `type({ a: "number" })` | type-first |

### How rpc runs it

`schema` **delegates**. rpc does not re-implement validation, and does not
re-interpret your library's rules: it reads `schema["~standard"]` and calls that
library's own `validate`. So everything your validator can express is enforced —
coercion, refinements, `.transform()`, brand checks, custom issues, and
asynchronous rules — because it is the *same function* that runs.

The whole interface rpc depends on is this:

```ts
{
  "~standard": {
    version: 1,
    vendor: "zod",                      // a label; rpc branches on nothing
    validate: (value: unknown) => ({ value }) | ({ issues }),
  };
}
```

Four consequences worth knowing, because each is a way a naive integration
silently does the wrong thing:

- **It is version-pinned to `1`**, and throws on anything else. Honouring an
  interface rpc does not understand is precisely what would make "any Standard
  Schema validator" false, so it refuses rather than guesses.
- **The result is awaited.** The spec permits a Promise, and a runner that read it
  synchronously would see `issues === undefined` *on the Promise object*,
  conclude the input was valid, and hand your handler the Promise — skipping
  validation entirely, with no error. Effect's adapter is async, so this is
  load-bearing rather than theoretical.
- **Success is a falsy `issues`,** per the spec, not `=== undefined`. Every
  conforming library is handled by the same rule.
- **The returned `value` replaces `args[0]`,** which is why a transform runs on
  both the HTTP path and a direct call. The two cannot drift.

Issue `path`s arrive as the spec's `PropertyKey[]` and are **normalised to a
string** — `address.city`, `tags[0]` — so one body shape drives `fieldErrors`,
the no-JS flash and a client resolver regardless of which library produced it.

No vendor is privileged. The test suite pins this by running the same contract
through mocks shaped like each library's real output — including one that echoes
the rejected value into its message and one that validates asynchronously — and
asserting the results are identical, so a future `if (vendor === "zod")` in the
dispatch fails the build.

### Input is not Output

Standard Schema splits the two, and rpc honours the split:

- the **client stub** is typed from the schema's **Input** — what the browser may send;
- the **handler parameter** is typed from the schema's **Output** — what arrives after transforms.

So a coercing schema lets the client send `"2"` while the handler receives `2`, with no cast. That is the entire reason the spec distinguishes the two, and `v.pipe(v.string(), v.transform(Number), v.number())` is the canonical example.

### What a rejection looks like

The status is **`422`** in both environments. The body differs:

```jsonc
// development
{
  "error": "Validation failed",
  "code": "VALIDATION",
  "data": { "issues": [ { "path": "email", "message": "expected a string", "hint": "the address you signed up with" } ] },
  "hint": "input did not match the function's schema; see wiki/server-functions.md#input-validation"
}

// production
{
  "error": "Unprocessable Content",
  "code": "VALIDATION",
  "data": { "issues": [ { "path": "email", "hint": "the address you signed up with" } ] },
  "hint": "input did not match the function's schema; see wiki/server-functions.md#input-validation"
}
```

**Why `422` and not `400`.** `400` means the request could not be understood — a body that does not parse, a `?args=` that is not an array. A validation failure is not that: the body parsed fine and the *fields* are wrong. Before 0.4.0 both were `400`, so a client could not tell a broken request from a rejected one without reading prose. `422 Unprocessable Content` is the widely-understood code for exactly this, and it makes the status a usable discriminator: branch on `res.status` and you do not have to parse anything. Elysia answers `422` for the same reason.

**What production keeps, and what it drops.** The split is drawn on *authorship*, not on the environment alone. Production keeps every string that rpc or you wrote — the reason phrase, the `code`, each issue's `path`, each `hint` — and drops the one string the validator library wrote, `message`.

- `path` is safe because it names a field the caller itself supplied, and can already see in the form it loaded or the client bundle.
- `hint` is safe because you wrote it in `ServerFunctionOptions`, so disclosing it was a deliberate act.
- `message` is neither, and it is **not safe to send** — because some libraries interpolate the value that failed into it. Measured through `~standard.validate`, the same path rpc uses, with `name: 12345`:

  | library | default message | echoes the value? |
  | --- | --- | --- |
  | valibot | `Invalid type: Expected string but received 12345` | **yes** |
  | zod | `Invalid input: expected string, received number` | no |
  | arktype | `name must be a string (was a number)` | no |

  Whether a message is safe depends on which library you picked, which cannot be reasoned about portably — so it is withheld structurally rather than by a rule each author has to remember. Depending on a vendor message also couples your error text to that library's release cycle, which is a second reason not to.

So an author who writes `hints` gets them in production automatically, and an author who writes none still gets *which field* failed. Neither needs to configure anything.

> **Never encode an existence check in a schema.** `~standard.validate` may be async, so a refinement that hits your database can put "already registered" into an issue — and a `path` and a `hint` are both sent in production. Do existence checks in the handler and throw one neutral `RPCError`. For a login, answer identically for "no such account" and "wrong password"; `NotFoundError` and `ForbiddenError` are the wrong pair there, and a status-code difference enumerates accounts on its own.

The client's `data` promise rejects with an `RPCResponseError`, which carries `status`, `body`, and — in both environments — `issues` and `hint` as getters. The `issues` an issue carries in production simply have no `message` key:

```ts
import { RPCResponseError } from "@thednp/rpc/helpers";

try {
  const { data } = add({ a: 1, b: 2 });
  await data;
} catch (err) {
  if (err instanceof RPCResponseError && err.status === 422) {
    err.issues?.forEach((i) => console.error(i.path, i.message, i.hint));
  }
}
```

Both getters return `undefined` for any other status, so you can branch without inspecting the shape.

### Hints

A validator's message says what is wrong; a hint says what to do about it. Hints are **dev-only** (they live in the stripped body) and are never inferred — you write them, because only you know the intent.

- `hint: "…"` — one string for the whole function. rpc appends its own docs pointer, so you don't have to.
- `hints: { email: "…", "profile.email": "…" }` — per rendered path, for when one message needs different advice per field.
- `field.string({ hint: "…" })` — declared on an rpc builder schema, where it stays next to the rule it describes.

### No validator dependency

`schema()` builds one from rpc's own primitives — useful when you want a contract without a dependency, and stricter than the libraries (see the limits below).

```ts
import { createServerFunction, schema, field, optional, array } from "@thednp/rpc/server";

const UserSchema = schema({
  email: field.string({ hint: "the address you signed up with" }),
  name: optional(field.string()),
  tags: array(field.string()),
});

export const update = createServerFunction(
  "update",
  async (signal, user) => user.email,
  { schema: UserSchema },
);
```

Primitives: `field.string`, `field.number` (rejects `NaN`/`Infinity`), `field.boolean`, plus `optional`, `nullable`, `array`, `record`, and `field.custom(inner)` to wrap any Standard Schema as a leaf.

The builder checks **types and structure, not ranges**. `field.string()` accepts `""` and `field.number()` accepts `0` and `-1` — that is the literal reading of the type, and expressing "at least 1 character" needs `field.custom(z.string().min(1))` or a real library. Likewise the builder is **structural only**: no `transform`, no coercion. Reach for zod/valibot/arktype when you need a constraint or a conversion; use the builder when you need a contract and no dependency.

### The inference boundary (`schema.from`)

`schema.from(vendorSchema)` returns the **same object**, typed as the plain spec interface. It validates nothing and converts nothing — every decision about what counts as valid still belongs to the library. What it changes is *where TypeScript does the work*.

```ts
import { createServerFunction, schema } from '@thednp/rpc/server';
import { type } from 'arktype';

const s = schema.from(
  type('string <= 64').narrow((v, ctx) =>
    v.trim().length >= 1 ? true : ctx.mustBe('a non-empty user id')),
);

export const getUser = createServerFunction('get-user', async (signal, id) => id, {
  schema: s,
});
```

Without the wrapper that call fails with `TS2589: Type instantiation is excessively deep and possibly infinite` on TypeScript 5.x, and compiles on 7.x — the same code, the same schema, the same compiler version being the only variable. The instantiation budget is **per inference site**, so the wrapper splits one expensive inference into two cheap ones: the deep structural match happens at `schema.from`, and `createServerFunction` only ever sees `StandardSchemaV1<in, out>`.

Three things worth knowing:

- **It is transparent, deliberately.** It does not check whether the object conforms, so a non-conforming validator still fails loudly at the first call with a clear message — the wrapper cannot launder a schema it knows nothing about.
- **It is a boundary, not a guarantee.** A genuinely pathological type could exhaust the budget *at the wrapper*. For that case annotate explicitly instead: `const s: StandardSchemaV1<string, string> = type(...)`, which is equally type-only and pins the types.
- **It is not needed for rpc's own builder**, whose types are already small. Reach for it when a vendor type is heavy — measured: arktype's `.narrow()` and its function pipes, zod and valibot not.

### Limits worth knowing

| | |
| --- | --- |
| **An array payload is refused, by name.** | `schema` describes one argument as *named fields*, and everything downstream — `fieldErrors`, the no-JS flash, a client resolver — keys off those names. A root array could only report positional issues (`items[0].sku`), which cannot label an input, so `z.array()` / `v.array()` as a whole payload throws. Wrap it: `{ items: field.custom(z.array(Item)) }`. |
| **Only the first argument is validated.** | The schema describes `args[0]`, after the `AbortSignal`. `login(username, password)` validates the username and not the password — restructure to one object argument if both need checking. A schema on a handler declaring more than one argument logs a development warning rather than failing silently, but a default or rest parameter makes the check blind. |

### Validated functions take a single payload argument

`schema` validates **`args[0]`** — the first argument after the `AbortSignal`, and
nothing else. This is the one structural rule worth knowing before you design a
function's signature, because it decides the shape of every validated function.

```ts
// ✅ the validated shape: one object, named fields, errors that map to inputs
createServerFunction("login", async (signal, input: { user: string; pass: string }) => {
  // input.user / input.pass are validated and, for a coercing schema, transformed
}, { schema: schema({ user: field.string(), pass: field.string() }) });

// ⚠️ positional: not validated at all
createServerFunction("add", async (signal, a: number, b: number) => a + b);
```

So `login(user, pass)` and `add(a, b)` **cannot** be validated. There is no
per-argument option, and no way to describe "validate each of my three arguments"
— the wire format is a positional array (`[a, 1, 2]`) and rpc hands the schema
element `0`.

**Array payloads are refused.** An array `args[0]` throws, by name, on both call
paths:

```
rpc: `schema` validates a single object argument, so an array payload is not
supported. Send one object — `fn({ a: 1, b: 2 })` — and describe any nested
array with `field.custom(z.array(...))`.
```

The rule is about the **root**. An array-valued *field* is the supported way to
express a field array; an array as the *entire* payload is not.

### `z.array()` / `v.array()` are unsupported as a root schema

```ts
schema: z.array(Item)     // ❌ refused — array payload
schema: v.array(Item)     // ❌ refused — same
schema: { items: field.custom(z.array(Item)) }   // ✅ wrap it in an object
```

**The limitation, stated plainly.** `schema` validates one argument and describes
it as a set of **named fields**, because everything downstream needs names:

- `fieldErrors(err)` returns a record keyed by field name, so a form can mark the
  input that failed.
- The no-JS fallback's flash carries `errors` as a record, re-rendered server-side
  from the same names.
- A client resolver maps issues back onto inputs for the same reason.

A root array can only produce **positional** issues — `items[0].sku` — and a
position cannot label an input, a form field, or a `setError` call. Supporting it
would mean inventing a second, index-keyed error shape beside the record one
everything else already consumes, so the root is refused instead. That is a
deliberate narrowing, not an oversight.

Two further reasons it is refused rather than tolerated:

- **It is indistinguishable from a wrong signature.** `schema: z.tuple([...])`
  against `add(a, b)` looks correct and is not — the schema is handed `a` alone
  and rejects with "expected array, received number". Refusing arrays outright
  names the real problem instead of reporting it as bad data.
- **Positional arguments are not validated anyway.** `login(user, pass)` and
  `add(a, b)` cannot use `schema` at all, so an array root is either a redundant
  single argument or a mistaken attempt at positional validation. Send one
  object: `add({ a, b })`.

**The trap worth naming.** A tuple schema *looks* like it should work and does not:

```ts
schema: z.tuple([z.number(), z.number()])   // against add(1, 2)
```

`args[0]` is `1`, so the tuple is asked to validate a number and rejects with
"expected array, received number" — a message that describes a wiring mistake as
a data error. If you want positional arguments, call the function with the tuple
as one value: `add([1, 2])`, which validates correctly.

**Why one payload is the right default anyway.** A form *is* one object, so
validation errors map to named inputs rather than positions — which is what
`fieldErrors`, the no-JS fallback's flash, and a client-side resolver all need. A
position in an array is not something you can label. Positional args remain
available and are the right choice for small, internal, trusted helpers; they
simply are not validated.


| **Unknown keys: rpc rejects, the libraries ignore.** | Measured on the same input, `schema({ a })` **rejected** `{ a: 1, b: "x" }`, while zod, valibot and arktype all passed it (zod strips, the others ignore). The builder is deliberately the strict one; strictness is not configurable. |
| **A no-JS `<form>` submission renders the `422`, not JSON.** | A native form gets a `303` with the failure flashed, *provided* the function sets `fallback` and the failure is client-facing. Without `fallback` the browser shows the `422` body raw, so a form that must work without JavaScript needs either `fallback` or validation returned as data. See [Native Form Fallback](./nojs-fallback.md). |
| **Heavy vendor types can exhaust TS 5.x.** | `createServerFunction` infers the handler's input by structurally matching the schema's type. arktype's `.narrow()` and its morph pipes produce a graph older TypeScript cannot walk within its instantiation budget, failing with `TS2589` on a call that passes on newer TS. Reach for [`schema.from`](#the-inference-boundary-schemafrom) — type-only, and it changes nothing at runtime. |
| **A schema failure and a malformed body used to be both `400`.** | **Fixed in 0.4.0** — a schema failure is `422`, a malformed body is `400`, so the status alone separates them. |

### Validation as data

The `schema` option is the right default, but it is not the only way to validate — and for some endpoints it is the wrong one. Returning the outcome as data is a `200`, so it travels as a normal result the client can render:

```ts
import * as v from 'valibot';

const SignupSchema = v.object({ email: v.pipe(v.string(), v.email()) });

export const submit = createServerFunction(
  "submit",
  async (signal, raw) => {
    const parsed = v.safeParse(SignupSchema, raw);
    if (parsed.issues) {
      // Resolves with the outcome rather than rejecting: the client gets a `200`
      // carrying the field errors, which is what lets a form re-render them.
      return { error: v.flatten(parsed.issues).nested };
    }
    return { ok: true, email: parsed.output.email };
  },
  { contentType: "application/x-www-form-urlencoded" },
);
```

The middleware wraps every result in `{ data: ... }`, so this arrives as **resolved data** — check `'error' in result`; the promise does not reject. Only non-`ok` transport failures (`400`/`403`/`404`/`405`/`409`/`413`/`415`/`422`/`500`, or a network error) reject.

Choose it when the outcome is a normal result the client should render (a nojs form re-rendering with field errors, a multi-step flow), or when the endpoint deliberately accepts a union of shapes. Choose `schema` when bad input is a client bug you want stopped at the boundary.

The two are not interchangeable, and the difference is the **status code**, not the body: `schema` gives a `422` and the client's `data` promise rejects, while returning `{ error }` gives a `200` and resolves. Migrating one to the other changes the client's control flow.

::: warning Prefer `schema` unless you have a reason
Validation-as-data is the *pre-0.4.0* pattern and most endpoints should move to `schema`: it stops bad input at the boundary instead of inside your handler, it applies the schema's transforms, and it produces per-field paths a client can render with one helper. Reach for validation-as-data when the outcome is genuinely a result. With a per-function `fallback`, a `schema` rejection can also re-render HTML: the native `<form>` gets a `303` redirect carrying structured field errors, and a bare `422` JSON body is only what a caller without `fallback` sees.
:::

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

`RPCError` is exported by the `@thednp/rpc/server` barrel (as is `formatError`, used by the adapters). Its constructor is `new RPCError(message: string, code?: string, data?: unknown, hint?: string)`.

### The `hint` argument

A **message** says what went wrong. A **hint** says what to do about it — and it is the difference between a failure that teaches and one that merely complains:

```ts
throw new RPCError(
  'User not found',
  'USER_NOT_FOUND',
  { userId },
  'ids look like u-42; the demo table is seeded with three of them',
);
```

`hint` is **developer-facing and dev-only**, stripped in production for the same reason `code` and `data` are: it describes the server's internals, and shipping it maps them. On the client, read it from `err.hint` on an `RPCResponseError` — see [Client Usage](./client-usage.md#field-errors).

### Typed subclasses

Three cases are common enough to have a class, and each one is a **teaching** error, so `hint` is **required** rather than optional — a class whose whole purpose is to explain a failure should not be constructible without the explanation.

```ts
import {
  ConflictError,
  createServerFunction,
  ForbiddenError,
  NotFoundError,
} from '@thednp/rpc/server';

export const rename = createServerFunction('rename', async (signal, next) => {
  if (await taken(next)) {
    throw new ConflictError('Name already taken', 'pick another, or append -2');
  }
  if (!allowed(next)) {
    throw new ForbiddenError('Not your tenant', 'pass a token for the right tenant');
  }
  if (!(await exists(next))) {
    throw new NotFoundError('No such user', 'ids look like u-42');
  }
  return rename_(next);
});
```

| class | status | code |
| --- | --- | --- |
| `NotFoundError(message, hint, data?)` | `404` | `NOT_FOUND` |
| `ForbiddenError(message, hint, data?)` | `403` | `FORBIDDEN` |
| `ConflictError(message, hint, data?)` | `409` | `CONFLICT` |

Each carries a `status`, so an adapter answers that status instead of a `500` — a thrown `NotFoundError` is a `404` with `{ error: "Not Found" }` in production, and with the message, `code`, `data` and `hint` in development. That is a real improvement over a bare `RPCError`, which is always a `500`: a missing resource is not a server fault. The reason phrase comes from the status, never from the author's message.

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

There are two different `redirect` functions with different signatures. Which one you want depends on whether you are inside a server function or holding a response object.

**Inside a server function — `redirect(location, status?)` from `@thednp/rpc/server`.** This is the one to reach for in almost every case: it reads the adapter-bound `redirect` from the request context, so it works from anywhere inside the dispatch with no `res` threading. It **takes no response argument** — passing one would silently send it as the `location`.

```ts
// src/api/submit.ts
import { createServerFunction, redirect } from "@thednp/rpc/server";

export const submit = createServerFunction("submit", async (signal, form) => {
  await save(form);
  redirect("/thanks");           // → POST /__rpc/submit answers 303 Location: /thanks
});
```

It throws if called outside a request, so it only works during dispatch.

**Holding a response object — the per-adapter `redirect(res, location, status?)`.** Use this from raw middleware, or when you already have the framework's response in hand. Each takes that framework's native object as the first argument:

```ts
import { redirect } from '@thednp/rpc/express';      // Express Response or raw ServerResponse
import { redirect } from '@thednp/rpc/fastify';      // FastifyReply
import { redirect } from '@thednp/rpc/koa';          // Koa Context
import { redirect } from '@thednp/rpc/hono';         // Hono Context
import { redirect } from '@thednp/rpc/h3';           // (location, status) — no response arg
```

The Express variant prefers a native `.redirect()` when the response has one and otherwise writes `Location` + status directly, so it also works on Connect-style and serverless responses that lack the method. Note **h3 is the exception among the adapters** — its `redirect` also takes no response argument, since `event.res` is reachable from the context.

All variants default to **`303 See Other`** — the semantically correct code for "the POST succeeded, now GET this page". Fastify's native API takes the URL first (`reply.redirect(url, status)`), Koa requires setting `ctx.status` *after* `ctx.redirect()` (Koa ignores a status set before it, see [koajs/koa#857](https://github.com/koajs/koa/issues/857)), and Hono's must be **returned** from the handler (`return redirect(c, url)`).

### A redirect applies to *every* caller, not just form navigations

`redirect()` is unconditional: the adapter answers `303` to whichever client made the request, including the generated stub's `fetch`. That is what you want for a plain no-JS `<form>` (PRG as designed), but a JS caller behaves differently — its `fetch` **follows** the `303`:

- **Same-origin target** — the caller receives the *target's* response (usually HTML) instead of your function's `{ data }`, which is never what the caller that awaited `data` expected.
- **Off-origin target** — the browser follows to a third-party host that sends no `Access-Control-Allow-Origin` for you, and the caller fails with a CORS error in the console. The redirect was issued correctly; the failure is on the *second*, cross-origin request.

If a function should PRG for native navigations but still answer `{ data }` to `fetch`, gate the redirect with `isNativeFormNavigation` — the same discriminator the [no-JS fallback](./nojs-fallback.md) uses internally, fed from the normalized request metadata:

```ts
import {
  createServerFunction,
  getRequestContext,
  getRequestMeta,
  isNativeFormNavigation,
  redirect,
} from "@thednp/rpc/server";

export const submit = createServerFunction("submit", async (signal, form) => {
  await save(form);

  const meta = getRequestMeta(getRequestContext());
  const header = (name: string) => {
    const value = meta.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const navigation = isNativeFormNavigation({
    method: meta.method,
    contentType: header("content-type"),
    accept: header("accept"),
    secFetchDest: header("sec-fetch-dest"),
    secFetchMode: header("sec-fetch-mode"),
  });

  if (navigation) redirect("/thanks");
  // a stub fetch falls through and receives the normal { data } response
});
```

Note this is a **caller** concern, not a security one: the location is authored by you, not taken from the request, and the request-influenced redirect paths (`fallback.to` and the replay params) are already gated and passed through `sanitizeRedirect` — see [No-JS Fallback](./nojs-fallback.md). Only gate the handler's own redirect when both caller types share the function; if the function is only ever reached by a native form, plain `redirect()` is correct and simpler.

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

> **Next:** [Multi-Prefix Support](./multi-prefix-guide.md) — run parallel RPC instances with versioned/namespaced prefixes.

---

## No-JS Form Fallback (`fallback`)

Setting `fallback` makes the function usable as a plain HTML `<form action>` with
JavaScript disabled. A native submission is answered with a Post/Redirect/Get
`303` and the failure flashed, instead of a JSON body the browser would render
raw.

```ts
createServerFunction("contact", handler, {
  contentType: "application/x-www-form-urlencoded",
  schema: schema({ email: field.string() }),
  fallback: { to: "/contact", replay: ["email"] },
});
```

- **`to`** — where the redirect goes. Treated as untrusted and restricted to
  root-relative paths, so a field or `Referer` value cannot turn it into an open
  redirect. For an off-origin target, call `redirect()` from the request context
  in the handler instead; a handler redirect takes precedence.
- **`replay`** — field names permitted in the redirect URL. **Empty by default**,
  so nothing is replayed unless named, because a URL reaches history, `Referer`
  and access logs.
- A bare string (`fallback: "/contact"`) is shorthand for one path and no replay.
- A function receives `{ status, errors?, message? }` and picks a target per
  outcome.

Detection is whether the request is a **document navigation**, not its content
type — a form-declared function is called by two clients that both send form
encodings. Only a navigation redirects; a `fetch` from the generated stub still
gets its `422`. A `JSON`-declared function still answers `415` for a form body.

Read the flash in the browser with `decodeFormFlash` from `@thednp/rpc/flash`,
which is client-safe. The full walkthrough, including the origin-check
consequences and the 4 KiB flash bound, is in
[Native Form Fallback](./nojs-fallback.md).

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
