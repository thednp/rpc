# @thednp/rpc

## Dev Commands

```bash
pnpm dev # Run examples/spa dev server
pnpm dev:advanced # Run examples/advanced dev server
pnpm dev:express # Run examples/express dev server
pnpm dev:fastify # Run examples/fastify dev server
pnpm dev:h3 # Run examples/h3 dev server
pnpm dev:hono # Run examples/hono dev server
pnpm dev:koa # Run examples/koa dev server
pnpm dev:react-query # Run examples/react-query dev server
pnpm dev:solid-query # Run examples/solid-query dev server
pnpm dev:ssr # Run examples/ssr dev server
pnpm lint # Lint + typecheck (deno lint + tsc src + tsc tests)
pnpm test # Run tests once with coverage (vitest run --coverage)
pnpm test:watch # Run tests in watch mode with coverage
pnpm test:ui # Run tests with UI
pnpm test:dev # Run examples in dev mode (scripts/dev-test)
pnpm test:prod # Run examples in prod preview (scripts/dev-test --mode=preview)
pnpm lint:ts # deno lint src
pnpm fix:ts # deno lint src --fix
pnpm check:ts # tsc -noEmit
pnpm format # deno fmt src tests examples/**/src
pnpm format:check # deno fmt --check (what CI runs — never rewrites)
pnpm clean # Remove build artifacts and caches
pnpm build # tsdown (outputs to dist/)
pnpm up:examples # Update all example deps (to latest published @thednp/rpc + latest example deps)
pnpm up:examples:lib # Sync examples to the latest published @thednp/rpc version
pnpm up:root # Update root deps
pnpm up:deno # deno update + sync deno.json deps
pnpm upd # Update all deps (up:examples + up:examples:lib + up:root)
pnpm audit:src # Audit src deps
pnpm prepareOnly # upd + up:deno + lint + format + audit:src + build
pnpm release # Publish npm + jsr (scripts/release.js)
```

## Build Order

`lint -> check:ts -> format -> build` (verified in `prepareOnly`)

## Examples

The `examples/` directory contains 10 example apps:

| Example       | Adapter                                                           | Type | Run Command            | Config                               |
| ---------------| -------------------------------------------------------------------| ------| ------------------------| --------------------------------------|
| `spa`         | Vite dev server (no adapter)                                      | SPA  | `pnpm dev`             | `examples/spa/rpc.config.ts`         |
| `express`     | Express                                                           | SSR  | `pnpm dev:express`     | `examples/express/rpc.config.ts`     |
| `advanced`    | Express                                                           | SSR  | `pnpm dev:advanced`    | `examples/advanced/rpc.config.ts`    |
| `fastify`     | Fastify                                                           | SSR  | `pnpm dev:fastify`     | `examples/fastify/rpc.config.ts`     |
| `h3`          | h3                                                                | SSR  | `pnpm dev:h3`          | `examples/h3/rpc.config.ts`          |
| `hono`        | Hono                                                              | SSR  | `pnpm dev:hono`        | `examples/hono/rpc.config.ts`        |
| `koa`         | Koa                                                               | SSR  | `pnpm dev:koa`         | `examples/koa/rpc.config.ts`         |
| `react-query` | Express (React + @tanstack/react-query SSR)                       | SSR  | `pnpm dev:react-query` | `examples/react-query/rpc.config.ts` |
| `solid-query` | Express (Solid + @tanstack/solid-query SSR)                       | SSR  | `pnpm dev:solid-query` | `examples/solid-query/rpc.config.ts` |
| `ssr`         | Custom `http-express.ts` (Express-compatible `node:http` server ) | SSR  | `pnpm dev:ssr`         | `examples/ssr/rpc.config.ts`         |

> `demo/` is a product showcase, not an `examples/` app: it uses the built-in no-JS fallback rather than duplicating it.

Each example follows the same structure:

- `server.js` / `server.ts` — production server with Vite middleware in dev, static serving in prod
- `src/api/server.ts` — RPC server functions (auto-scanned by the plugin)
- `src/entry-server.ts` / `src/entry-server.tsx` — SSR entry (hydrates on client)
- `src/entry-client.ts` / `src/entry-client.tsx` — Client entry
- `vite.config.ts` + `rpc.config.ts` — Configuration files

> Note: the `react-query` example is SSR with React 19 + `@tanstack/react-query` (Express adapter). It prefetches queries in `entry-server.tsx`, dehydrates them into `window.__REACT_QUERY_STATE__`, and hydrates on the client via `HydrationBoundary`.
>
> Note: the `solid-query` example is SSR with Solid + `@tanstack/solid-query` (Express adapter). The greeting is prefetched and serialized with `renderToStringAsync`; the GET form does **not** use a disabled `createQuery` (which would hang SSR — see `wiki/client-usage.md`), it calls `queryClient.fetchQuery()` on submit instead.

## Key Directories

- `src/` — source for all packages (vite plugin, server, express, fastify, h3, hono, koa adapters)
- `dist/` — tracked build output (tsdown generates it, and it is committed)
- `tests/` — test files (one per adapter + plugin + helpers)
- `tests/fixtures/` — test fixtures (config files, vite-mock.ts)
- `examples/` — example apps (spa, express, fastify, h3, hono, koa, react-query, solid-query, ssr, advanced)
- `demo/` — separate product showcase wired to the built-in no-JS fallback; not one of the 10 `examples/` apps

## Build Output (tsdown)

The tsdown.config.ts produces multiple entries:

- `dist/index.mjs` — main Vite plugin
- `dist/config/config.mjs` — vite-free `defineConfig` (safe for serverless bundles)
- `dist/server/server.mjs` — standalone server
- `dist/express/express.mjs` — Express middleware
- `dist/fastify/fastify.mjs` — Fastify middleware
- `dist/fastify/plugin/fastify/plugin.mjs` — Fastify plugin entry
- `dist/h3/h3.mjs` — h3 middleware
- `dist/hono/hono.mjs` — Hono middleware
- `dist/koa/koa.mjs` — Koa middleware
- `dist/helpers/helpers.mjs` — client helpers
- `dist/flash/flash.mjs` — client-safe flash codec, importable in a browser

## Test Files

| File                            | Tests                                                              |     |
| ---------------------------------| --------------------------------------------------------------------| -----|
| `tests/plugin.test.ts`          | Plugin init, loadRPCConfig, createServerFunction, getClientModules |     |
| `tests/scan.test.ts`            | scanForServerFiles (real scan, skip, devServer, error handling)    |     |
| `tests/server-helpers.test.ts`  | RPCError, formatError, redirect, glob walking, origin allowlist (`isOriginAllowed`) and the four-tier `isOriginRequestAllowed` behaviour matrix |     |
| `tests/client-helpers.test.ts`  | Client fetch stubs, retrieval helpers, `unwrapEnvelope` error contract |     |
| `tests/body.test.ts`            | Body parsing, content-type branching, streamed limits              |     |
| `tests/schema.test.ts`          | Standard Schema validation, vendor mocks, dev/production issue bodies |     |
| `tests/execution-log.test.ts`   | Dispatch records, redaction, throwing-hook behaviour               |     |
| `tests/form-fallback.test.ts`   | Native navigation detection, redirect safety, flash encode/decode and replay policy |     |
| `tests/context.test.ts`         | provideRequestContext / getRequestContext (AsyncLocalStorage)       |     |
| `tests/adapter-exports.test.ts` | Export-surface contract: asserts each adapter's emitted `.d.mts` exports the required type names (build-output test — run `pnpm build` first) |     |
| `tests/express.test.ts`         | Express helpers, createMiddleware, createRPCMiddleware             |     |
| `tests/fastify.test.ts`         | Fastify helpers, plugin, createMiddleware, createRPCMiddleware     |     |
| `tests/h3.test.ts`              | h3 helpers, viteMiddleware, createMiddleware, createRPCMiddleware  |     |
| `tests/hono.test.ts`            | Hono helpers, createMiddleware, createRPCMiddleware                |     |
| `tests/hono-scan.test.ts`       | Bare Hono middleware scans with the resolved global prefix         |     |
| `tests/koa.test.ts`             | Koa helpers, createMiddleware, createRPCMiddleware                 |     |

Run `pnpm build` before `pnpm test` — `tests/adapter-exports.test.ts` reads the emitted declarations and hard-fails without them, and the adapters themselves import `@thednp/rpc/server` (aliased to `src/server.ts` under vitest, so only that one suite needs the build). CI now builds first: `dist/` is **committed**, so without that step the suite silently validated the last-committed bundle and a type export removed or renamed in `src/` went unnoticed (demonstrated: deleting `ExpressApp` from `src/express/types.d.ts` passed 56/56 with no build, fails with one). `tsc` has no `paths` mapping for `@thednp/rpc/server`, so it type-checks against `dist/` — a source change that adds an export needs a rebuild before `pnpm lint` will accept it.

## Important Notes

- In dev mode, **only** the Vite dev server ([Connect](https://github.com/senchalabs/connect) powered) and Express middleware are available, which means adapters don't work in DEV mode
- Uses `deno` for linting and formatting (not eslint/prettier)
- Uses `tsdown` for bundling (not rollup/vite directly)
- Uses `vitest` for testing with `istanbul` coverage
- The `scannedTargets` memo in `scanForServerFiles.ts` persists across tests — reset modules to bypass, or vary the `(scanRoot, serverFiles, rpcPrefix)` triple. It is keyed per target rather than being one process-wide boolean, which is what lets a second prefix be scanned after the first; do not collapse it back to a single flag
- **`pnpm check:ts5` type-checks the examples under a pinned TypeScript 5.9.3** (`typescript-5` npm alias, invoked by path so it cannot collide with the root `tsc`). It exists because the project's own TS 7 passes code that an editor bundling TS 5.x rejects, and it is **not** part of `pnpm lint`: the examples resolve `@thednp/rpc` through their installed `node_modules`, so the check only works while they point at the repo. Run it **before** reverting `examples/*` off `link:../..`, and in CI before publish. Verified to catch the failure it exists for — deleting `schema.from` from the arktype profile yields `TS2589: Type instantiation is excessively deep and possibly infinite` at the **`createServerFunction` call site** in `public.server.ts`, not in the file declaring the schema. Note that a `as never` on the schema masks it entirely (the cast collapses the inference), so a "clean" result after adding a cast is not evidence
- **Coverage measures line execution, not feature correctness.** Two bugs shipped at 100% coverage because every fixture in `tests/fixtures/*.ts` calls `setGlobalPrefix(undefined)`, so the only state the global-prefix path cares about was never exercised. When adding a test, assert *which* code path ran — not just that output is non-empty (the vite 7/8 transform tests did the latter, which is why the `Number(viteVersion[0])` bug hid)
- `setGlobalPrefix` is stored on `globalThis[Symbol.for("thednp.rpc.globalPrefix")]`, so probes can read it without importing the module
- **A heavy vendor schema type can blow `createServerFunction`'s inference budget on TS 5.x.** The handler input is derived via `InferOutput<TSchema>` / `InferInput<TSchema>`, which are *structural* matches against the schema's own type. arktype's `.narrow()` returns a morph-bearing `Type` whose graph exceeds the 100-instantiation budget, so the call fails with TS2589 ("Type instantiation is excessively deep and possibly infinite") on TS 5.9 while passing on the project's own TS 7.0.2 — **a green `pnpm lint` does not mean an editor bundling TS 5.x is clean.** Measured: arktype `.narrow()` fails, arktype `type("string")` passes, valibot and zod pass. Fix by annotating the schema as the spec interface it already satisfies (`const s: StandardSchemaV1<string, string> = type(...)`), which collapses the walk to one cheap comparison and is type-only — runtime behaviour is identical. Do not "fix" this by dropping a validation rule. Reproduce with `node <ts5>/node_modules/typescript/bin/tsc --noEmit -p examples/advanced/tsconfig.json`, and note the probe needs `paths`, not `baseUrl` (removed in TS7)

## Fixed in 0.3.7 — prefix resolution

A 2026-09-27 audit found the global prefix and the dispatch prefix were resolved by two independent pieces of logic that could disagree. Both are now fixed; the notes below are the guardrails.

- **`resolveRPCPrefix(rpcPrefix?)` (`src/server-helpers.ts`) is the single resolution point** — explicit argument → `getGlobalPrefix()` → `defaultPrefix`. All five adapters call it in *both* places they need it (the outer `createMiddleware` gate and the `createRPCMiddleware` dispatch), so parity is structural rather than a convention. Do not reintroduce a local `a || b || c` in an adapter
- **`createRPCMiddleware` no longer injects `{ rpcPrefix: defaultRPCOptions.rpcPrefix }`.** That default is what made the `|| getGlobalPrefix()` fallback unreachable: `rpcPrefix` was always the truthy `"__rpc"`, so with `setGlobalPrefix("@demo")` a function registered under `@demo` (via `createServerFunction`, which does honour the global prefix) was unreachable — `/@demo/greet` got `next()` and `/__rpc/greet` got `"Function not found"`. The resolved prefix is now passed down from `createRPCMiddleware` to the gate as an explicit value
- **The boundary regex is built from the resolved prefix, and only when a prefix is supplied.** Two traps here: building it unconditionally would start prefix-gating a bare `createMiddleware({ path, handler })`, which has never gated; building it from the *raw* argument would make it `null` and silently disable gating. The gate gates on `rpcPrefix ? ... : null`; the value is the resolved prefix
- **`loadRPCConfig` publishes the global prefix on every return path**, including the default config-file discovery loop — that is the common case, and it used to be the one path that skipped the call
- **Known, deliberately unchanged:** a config file that throws resets the module-level `RPCConfig` cache to the defaults. The "fall back to defaults" contract is asserted by tests, so a failed load downgrades a previously loaded config for the rest of the process. `MiddlewareOptions.rpcPrefix` also declared a `false` that was documented nowhere, tested nowhere, and handled nowhere — measured as byte-identical to omitting the option. Removed from the type in the same release; do not reintroduce it without implementing and documenting what it does, since a `false` that reads like "disable prefix gating" while gating on the default is the more dangerous shape
- **The coverage lesson stands:** both bugs shipped at 100% coverage because every fixture in `tests/fixtures/*.ts` called `setGlobalPrefix(undefined)`, so the state the feature is *about* was never exercised. `tests/express.test.ts` now has a `global-prefix dispatch` block that sets a real prefix, and `tests/plugin.test.ts` has a file-level `afterEach` resetting it — do not remove either

## Framework

- Vite plugin for creating server functions with automatic RPC generation
- Server functions return `{ data: Promise<T>, cancel: (reason?: string) => void }` shape
- Framework-agnostic core with adapters for Express, Fastify, Hono, Koa, and h3
- Client modules are auto-generated with `AbortController` support for cancellation
- Server-side caching must be handled by third party tools (e.g. `@tanstack/react-query`)
- **Input validation via `schema`** (`src/schema.ts`): any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, effect) or the dependency-free `schema()`/`field` builder. Validated in each adapter's dispatch **before the handler is entered**, against `args[0]` only. The client stub types from the schema's **Input**, the handler from its **Output**, so a coercing schema crosses the wire uncast. The status is **`422`** in both environments (it was `400` through 0.3.x, which made a malformed request and a rejected input indistinguishable by status). The production body **keeps** each issue's `path` and any author-written `hint`, and **drops** the validator library's `message`; the *body* is development-only (`{ error: "Validation failed", code: "VALIDATION", data: { issues }, hint }`) and is stripped to `{ error: "Bad Request" }` in production — the issue list would otherwise map the input contract. `hint`/`hints` are author-written and dev-only; the builder is the strict one (rejects unknown keys) where the libraries ignore them, and it checks types/structure only, not ranges — `field.string()` accepts `""`. The nojs `<form>` fallback deliberately does **not** use `schema`: a `400` JSON body cannot re-render HTML with errors, so it hand-rolls validation and returns the errors as data
- **The production body drops the vendor `message` for a measured reason, not a cautious one.** Going through `~standard.validate`, valibot returns `"Invalid type: Expected string but received 12345"` for a failed `name: 12345`, while zod returns `"Invalid input: expected string, received number"` and arktype `"name must be a string (was a number)"`. Whether a message is safe to send therefore depends on which library the author chose, which cannot be reasoned about portably — hence it is withheld structurally. A `path` is safe (the caller supplied the field) and a `hint` is safe (the author wrote it), so **both survive into production**, and `fieldErrors`/`fieldErrorText` must keep working with no `message` to read. `tests/schema.test.ts` has the echo regression test; it is what catches the reasoning going wrong in either direction
- **A `schema` is enforced on BOTH call paths, and it must stay that way.** The adapters validate in dispatch, and `createServerFunction`'s returned function validates too — because that function is also called **directly** by SSR, server-to-server code and tests, and those bypass the middleware entirely. The two bugs this prevents, both shipped and both measured: a direct call ran the handler on unchecked input, and the schema's **transforms never ran on that path at all** — `add({ a: "2", b: "40" })` returned `"240"` directly and `42` over HTTP, because only the schema's output ever replaced the raw argument. If you add a call path, it needs `runValidation`, or a function's behaviour depends on how it was invoked
- **Per-request middleware cannot run in a direct call.** `auditLog()` / `rateLimit()` wrappers read `getRequestContext()`, which exists only inside a dispatch, so calling such a function outside a request throws `RequestEvent is not available outside of a request`. That is correct — those functions are HTTP-only by construction — but it means an example with per-request middleware cannot demonstrate the direct path
- **`onDispatch` is a hook, not a logging library.** It emits one `DispatchContext` per dispatch and **retains nothing** — no buffer, no ring, no TTL. A library-owned store was built and cut, because holding request data in the library is the exact risk the hook avoids. Two non-obvious requirements: `argShape` must describe arguments and never capture values (args routinely carry passwords; it is depth/key bounded and cycle-safe), and a throwing hook must be ignored, since a logger that takes down the request it is describing is worse than one that loses a record. The correlation `id` goes on failure bodies **only when a hook is registered**, so with no hook the error body is byte-for-byte unchanged
- **Multi-prefix support**: `createServerFunction(..., { rpcPrefix })` registers functions in a prefix-scoped map (`getFunctionsForPrefix`), so multiple RPC instances can coexist (versioned/namespaced APIs). All five adapters dispatch via `getFunctionsForPrefix(prefix)` where `prefix = rpcPrefix || getGlobalPrefix() || defaultPrefix`; `serverFunctionsMap` is a backward-compatible proxy for the default `"__rpc"` prefix (`defaultPrefix`)

## Security & Hardening

- **Prefix boundary check**: All adapters use `new RegExp(\`^/${escapeRegExp(rpcPrefix)}/\`)` instead of `startsWith` to prevent path segment bypassing (e.g., `/__rpc-evil/foo` no longer matches prefix `"__rpc"`)
- **Prefix regex injection prevention**: `rpcPrefix` config string is escaped via `escapeRegExp()` before being embedded in the boundary regex, preventing ReDoS or unintended matching from metacharacters in the prefix
- **Regex compilation hoisted**: All prefix/path regexes are compiled once at middleware creation time (not per-request), eliminating per-request regex overhead
- **Koa URL normalization** → **URL normalization (all adapters)**: every adapter normalizes the request URL before prefix checking. `safeURL()` (`src/server-helpers.ts`) **never throws** — malformed request-targets (`/\`, `//`, `/\/`) make the WHATWG parser raise `TypeError: Invalid URL`, and the adapters parse the URL *before* their dispatch `try` block, so an unguarded throw became an unhandled rejection that crashed raw `node:http` hosts and Express 4. On failure it falls back to the base root, so the pathname never matches the prefix and the request degrades to `next()`/404. The call site differs per adapter, so "all adapters use `safeURL`" is only *nearly* true: **fastify/hono/koa** call it directly, **express** reaches it through `getRequestDetails(req)` in `src/express/helpers.ts`, and **h3 does not call it at all** — it reads `event.url.pathname`, which h3 has already parsed, so the throw-on-malformed-target case is handled upstream by h3 rather than by `safeURL`
- **GET `?args=` array validation**: all five adapters `JSON.parse` the query value and reject anything that is not an array with `400 Bad Request` before dispatch. Without the guard, `?args={"a":1}` spread an object into `handler(...args)` (`TypeError`) and `?args="abc"` spread a string into characters — confusing 500s on attacker-controlled input
- **Code injection prevention in client module generation**: `getClientModules.ts` validates all interpolated identifiers (`fnName`, `fnEntry`, `rpcPrefix`) against `/^[A-Za-z_$][A-Za-z0-9_$]*$/` (and a path-safe variant allowing `/`, `@`, `:`, `-`) before interpolating into the generated client bundle. This prevents code injection via malicious export names or prefixes containing template literal interpolations (`${...}`), backticks, or `</script>` sequences.
- **Body size limits**: rpc enforces a **10 MiB default cap** of its own (`bodyLimit`, `0` disables) on the paths it reads itself — `readStream` for the Node-stream adapters (express/fastify/koa) and `readWebBody` for the Web-`Request` ones (h3/hono). This is not redundant with a host framework's limit, and the reason was measured: `express.json({ limit: "1mb" })` **declines** urlencoded and multipart, leaves them on the stream, and rpc read that stream uncapped — a 20 MB multipart POST returned `200` with 20,971,594 bytes buffered. **A `Content-Length` pre-check is not a cap**: a `Request` built in JavaScript carries no `Content-Length` at all (absent for chunked requests), which is the normal case for `app.fetch()`, Workers, Bun, Deno, and serverless. Per-adapter coverage is tabulated in wiki/security.md; note **Fastify is effectively exempt** because its own parser (or its own 415) always answers first. **Enforce any cap while streaming, never after buffering**: the obvious `readBody`-then-check shape provides no memory-exhaustion protection at all. Past the cap, drain-and-discard with a drain ceiling so the 413 is deliverable (closing a socket with unread request data makes Node emit RST) without becoming an unbounded slowloris **Enforce any custom cap while streaming, never after buffering**: `examples/spa/body-limit.ts` measures each chunk as it arrives, retains nothing past the cap, then drains-and-discards so the `413` is deliverable (closing a socket with unread request data makes Node emit `RST`) with a drain ceiling so the discard can't become an unbounded slowloris. Buffering first and measuring after — the obvious `readBody`-then-check shape — provides no memory-exhaustion protection at all
- **A malformed request is a `4xx`, never a `500`, and never a silent `200`**: a declared-JSON body that does not parse answers `400`, as does a GET `?args=` that is malformed or not an array. Three helpers in `src/server-helpers.ts` implement this once for all five adapters — `httpError(status, message)` tags an error for the dispatch, `isClientHttpError(err)` decides the class, and `clientErrorMessage(status)` picks the body from a fixed table. Read **both** `status` and `statusCode`: h3's `HTTPError` and `httpError` use the former, the `http-errors` objects Express's `body-parser` throws and Koa's `ctx.throw` use the latter. `readBody` must only `JSON.parse` when the content type actually declared JSON — the lenient sniff for undeclared bodies is deliberate (curl and the nojs fallback send JSON with no `Content-Type`) and an earlier version had all three branches fall through to one `JSON.parse`, so a text body threw and was "recovered" as `text/plain`, which made malformed JSON indistinguishable from a text body and answered `200`
- - **The `bodyLimit` cap lives on `readWebBody` only, so anything that reads the body another way is uncapped.** Hono had exactly that: `readBody` returned early for declared-JSON via `c.req.json()`, so JSON bypassed the cap while every other content type and h3's identical body were capped — and JSON is what every client stub sends. It shipped at 100% line coverage because `tests/hono.test.ts` had **no** `bodyLimit` test; coverage measured that the branch ran, not that it bounded anything. Two buffered-body paths legitimately cannot be capped, because the body is already read: `@hono/node-server`'s `c.env.incoming`, and Hono's `c.req.bodyCache` when a host middleware got there first. Note the cache is keyed by *body form* and `c.req.json()` stores **raw text** under `text` and parses it itself, so dispatch on the form, not the key — treating that text as pre-parsed returns a string and silently loses the object
- **Hono's `c.env` is optional**: only `@hono/node-server` populates it. Workers, Bun, Deno, serverless adapters and `app.fetch()` all leave it `undefined`, so every `c.env` read needs `?.` — `c.env.incoming?.` is not enough, since that guards a null `incoming`, not an absent `c.env`. `tests/hono.test.ts` drives a real `Hono` app through `app.fetch()` for this reason
- **Content-type strictness is one-directional**: JSON- and text-declared functions are strict (a form body is rejected with `415`); form-declared functions accept either form encoding, which is what makes the nojs `<form>` fallback work. The leniency does not run the other way
- **Generic 404 responses**: Error messages never echo the requested function name (no message-based function enumeration). Note the status code still distinguishes unknown (`404`/`400`) from known functions (`405`/`415`/`403`); function names ship in the client bundle so they are not secret — see `wiki/security.md`
- **Client error contract is shared, not fail-open**: `handleResponse` (used by generated stubs) and `unwrapEnvelope` (exported for native clients) agree — a top-level `error` key throws, `{ data: { error } }` resolves normally so validation-as-data keeps working. `unwrapEnvelope` is status-code agnostic, so callers must keep the `res.ok` check. `RPCError` is server-side only (`@thednp/rpc/server`); it is not a client export and its `code`/`data` are stripped in production regardless
- **Origin check is shared, not copy-pasted, and is ON BY DEFAULT (0.4.0)**: the `origin` option accepts `"self"` (default), a single string, or an array; an array **widens** self rather than replacing it. Three tiers, first signal wins: `Origin` present → the policy decides (`"self"` compares the origin's **host and port** against `Host`, with *default* ports normalised — so TLS termination needs no action, but a proxy that rewrites `Host` to another port `403`s every check (preserve `Host`, or name the public origin in `origin`)); `Origin` absent but `Sec-Fetch-Site` present → allow only `same-origin`/`none`, so a stripped `Origin` fails closed rather than degrading to a no-op; both absent → **403 unless `allowHeaderless: true`** (the opt-in for curl/native calls; a browser's native `<form>` navigation supplies `Origin`, so the built-in fallback is checked normally). The default was flipped from opt-in in 0.4.0 — a check nobody turns on protects nobody. `Origin` **must** short-circuit ahead of `Sec-Fetch-Site` — the allowlist exists to admit a sibling subdomain, whose request carries `Sec-Fetch-Site: same-site`, which tier 2 alone would reject. Empty/whitespace header values count as absent, because adapters disagree on what a missing header yields (Node `undefined`, Hono `c.req.header()` `""`). `isOriginAllowed` (literal match) and `isSelfOrigin` (host **and port**) are both public API; the rule lives once in `isOriginRequestAllowed` (`src/server-helpers.ts`), used by all five adapters. **No forwarded header is ever trusted and there is no `trustProxy` option** — `X-Forwarded-Host` is attacker-influenceable, so an ingress that rewrites `Host` is fixed by naming the public origin in `origin`, which is a statement of what the operator trusts rather than a switch someone can flip. `isOriginRequestAllowed` takes an `OriginCheck` object rather than positional args on purpose: in a function that decides whether a request is a forgery, a transposed `site`/`host` is a real failure mode. **The secure default is enforced twice** — `defaultMiddlewareOptions.origin = "self"` *and* `isOriginRequestAllowed` resolves `allowed ?? "self"` itself, because `Object.assign(defaults, options)` copies an explicit `origin: undefined` over the default. Do not remove either guard

- **Adapter type exports are uniform**: every adapter re-exports `<Fw>App` / `<Fw>Request` / `<Fw>Response` / `<Fw>Next` / `<Fw>MiddlewareFn` / `<Fw>MiddlewareOptions` / `<Fw>MiddlewareHooks`, plus the shared `RequestDetails` / `ResponseDetails` (defined once in `src/adapter-types.ts`, re-exported by all five), so a wrapper can annotate without depending on the framework. Additive only — legacy names (`Express`, `Fastify`, `Hono`, `Koa`, `H3Event`, `HonoContext`, `KoaContext`) still resolve. `tests/adapter-exports.test.ts` parses the emitted `dist/<adapter>/<adapter>.d.mts` to guard this, because type-only exports are erased from the `.mjs` and invisible to a runtime check
- **Auth is middleware's responsibility**: Authentication should be handled by middleware registered before `createRPCMiddleware()`. The middleware chain naturally composes — no built-in auth hook is needed.
- **No client-side secrets or stack traces**: Error responses always return `"Internal Server Error"` regardless of the underlying error; `console.error(String(err))` is server-side only for debugging and does not surface internals to the client
- **There is no `adapter` config option, by design.** The adapter is the subpath you import. A runtime value could only disagree with the subpath actually mounted, and nothing read it — it was inert for its whole life. The union survives only as the exported `AdapterName` type, which keys `FrameworkHooks[A]["handler"]`; each adapter hardcodes its own literal into `MiddlewareOptions<"…">`. Do not reintroduce a config field that selects it. The generated client stubs are plain `fetch` calls, so `getClientModules` needs only the prefix
- **Prefix parity across adapters**: enforced by `resolveRPCPrefix()`, not by convention — see *Fixed in 0.3.7*. A mismatch would be fail-closed (404, never a cross-prefix dispatch) but still a bug

## Threat Model

The framework's security boundary is the **RPC prefix-gated HTTP endpoint**. Inputs:

| Input                 | Source                        | Trust Level         | Hardening Applied                                                        |
| -----------------------| -------------------------------| ---------------------| --------------------------------------------------------------------------|
| `rpcPrefix` (config) | `rpc.config.ts` / dev options | Developer-trusted   | Escaped before regex; validated before code gen                          |
| Function export name  | `src/api/server.ts` exports   | Developer-trusted   | Validated against identifier regex before client codegen                 |
| HTTP request URL      | Untrusted client              | Boundary-filtered   | Prefix regex (escaped, anchored, hoisted); non-throwing URL normalization (`safeURL()` on fastify/hono/koa, via `getRequestDetails` on express, pre-parsed `event.url` on h3) |
| HTTP request headers (`Origin`, `Sec-Fetch-Site`) | Untrusted client | Boundary-filtered | Exact-match allowlist; `Origin` short-circuits ahead of `Sec-Fetch-Site`; fails closed when only the coarse signal survives; empty values treated as absent |
| HTTP request body | Untrusted client | Capped by framework | Framework body parsers cap JSON and raw bodies |

**Attackers cannot**:
- Inject code via the prefix or function names (validated identifiers)
- Bypass the prefix via segment-prefixing tricks (anchored regex, not `startsWith`)
- Trigger ReDoS via prefix metacharacters (escaped before compilation)
- Exhaust memory via large raw text bodies (framework body parsers enforce limits)
- Sneak past the origin allowlist with a lookalike host (`https://app.example.com.evil.com` is rejected — matching is exact, never a prefix test)
- Downgrade the origin check by stripping `Origin` and leaving `Sec-Fetch-Site: cross-site` (that combination is `403`; only `same-origin`/`none` pass once the precise signal is gone)

**Attackers are expected to**:
- Be free to send as many requests as the host allows (no rate limiting — host's responsibility)
- Be free to hit any URL (no auth — host's responsibility via prior middleware)
- Be rejected with generic error bodies (no function-name disclosure in messages, no stack traces); status-code differential still reveals existence — see `wiki/security.md`

## Release mechanics

- **`dist/` is tracked and must be committed with the source.** `tsc` has no `paths` mapping for `@thednp/rpc/server`, so it type-checks against `dist/` — a stale bundle silently validates the wrong types. `tests/adapter-exports.test.ts` parses the emitted `.d.mts`, so a source change that adds or renames a type export needs `pnpm build` before `pnpm lint` will accept it
- **`scripts/release.js` guards on the tag matching `package.json`**, so the version in `package.json` and `deno.json` must agree with the tag or the release refuses rather than misbehaving. Both files carry the version
- **`wiki/migration.md` is a release artifact, not a one-off.** It documents the two 0.4.0 default changes as symptoms a reader will actually hit (`403` for headerless clients, `413` for oversized bodies) plus the Hono JSON cap change, which nobody asked for and everybody on Hono will see. When a release changes a default, that guide is where the symptom-to-cause table goes — a `CHANGELOG` entry describes the change, the migration guide describes the *experience* of it. Keep the two from drifting
- **The wiki and `llms.txt` carry security claims that must stay true.** `wiki/security.md` documents a per-adapter cap table asserting measured behaviour, and it was wrong for Hono — it claimed a "real cap" the code did not provide. Treat a table like that as a test, not prose: if the code changes, re-measure and update the number
- **The example `link:../..` dependencies are reverted by hand before publishing.** They point the examples at this repo so `pnpm check:ts5` resolves `@thednp/rpc`; a published `0.4.0` must not

## Workflow notes (important!)

- **Harness folders**: when scaffolding a minimal repro/harness to debug the Vite plugin or an adapter, create it inside the repo (e.g. `TEMP/`) — **never** in the root or in OS temp dirs. Root-level harness files break `tsdown`/`vitest` path resolution, and temp dirs outside the project get swept by OS cleaners and leave stale `node_modules`/`.vite` state that corrupts the next run.
- **Never delete files**: do not `rm` source/test files. If a file must be removed from the tree, **rename it to `<name>-bak.<ext>`** (e.g. `foo.ts` → `foo-bak.ts`) and leave it in place. The `-bak` suffix is the only sanctioned way to retire a file; the repo may be scanned for history or references later.


## Documentation

- `wiki/quickstart.md` — Rebuild the Express SSR example from `create-vite` in under a minute (copy-paste)
- `wiki/getting-started.md` — Installation, project structure, auto-scanning, and your first function
- `wiki/configuration.md` — Configuration reference (`rpc.config.ts`, `vite.config.ts`, options)
- `wiki/server-functions.md` — `createServerFunction` API, methods, validation, **request context (`getRequestContext`/`provideRequestContext`)** for per-request data access across async call stacks
- `wiki/multi-prefix-guide.md` — Parallel RPC instances: versioned/public/admin API layouts, per-prefix middleware, canary deployments, origin validation per instance
- `wiki/middleware.md` — universal adapter-agnostic middleware via the request context (`locals` bridge, `getRequestMeta`, `sendResponse`, `functionName`), plus **handler wrappers** — the portable way to populate `event.locals` that works on all five adapters (including Fastify, which has no per-request store to bridge). Prefer the wrapper pattern over per-adapter reads when documenting middleware
- `wiki/nojs-fallback.md` — native (no-JS) `<form>` fallback / progressive enhancement pattern
- `wiki/client-usage.md` — Client-side usage, type safety, react-query integration, native clients via `unwrapEnvelope`
- `wiki/wire-protocol.md` — HTTP contract, request/response bodies, curl debugging
- `wiki/adapters.md` — Framework adapters (Express, Fastify, Hono, Koa, h3) and the re-exported framework type contract
- `wiki/security.md` — Security hardening
- `wiki/comparison.md` — How the cross-origin/CSRF boundary compares to Next.js Server Actions, TanStack Start, SvelteKit, tRPC, and (in a section) Vike/Telefunc. **Read this before writing any security copy.** The framing is *secure by default, strictest-once-configured, multi-origin without a proxy* — measured, not asserted: with `origin` set, rpc rejects an untrusted `Origin` even when `Sec-Fetch-Site: same-origin` claims otherwise, which TanStack's tier order waves through. Do **not** soften this into "as secure as" or "more secure than" — the page's own numbers (3 stricter, 2 more lenient, both deliberate) are the honest shape, and a reader who knows the tools will check. The `Where the trade costs you` section keeps rpc's real sharp edges (case-sensitive origin matching, literal origins only, opt-in-only input validation whose detail is stripped in production, deliberate `Referer` omission)
- `wiki/best-practices.md` — Production patterns (auth, rate limiting, body limits, CSRF)
- `wiki/index.md` — Documentation index / table of contents
