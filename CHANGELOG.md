# Changelog

## [0.2.0] - 2026-08-09

### Features

- **h3 adapter**: new `@thednp/rpc/h3` adapter with `createRPCMiddleware`, `viteMiddleware`, `attachRPC`, `attachVite`, `readBody`, `redirect` — fully typed, 100% test coverage, SSR example at `examples/h3`
- **Request Context API**: `provideRequestContext(init, cb)` / `getRequestContext()` — per-request `AsyncLocalStorage` context available to all server function code; `RequestEvent` includes `nativeEvent`, `locals`, adapter-bound `redirect`; works across Express, Fastify, Hono, Koa, and h3
- **`redirect` helper**: a new `redirect(res, location, status?)` server utility exported from `@thednp/rpc/server` and every adapter. It defaults to `303 See Other` for Post/Redirect/Get flows. The core version accepts an Express `Response` or a raw Node `ServerResponse`, delegating to native `res.redirect()` when available and otherwise writing the status code and `Location` header directly — the raw path is safe on Connect-compatible middlewares and serverless adapters (e.g. Netlify's `serverless-http` mock). Each adapter exports a redirect typed for its response object: Fastify `reply.redirect(location, status)` (v5 URL-first), Koa `ctx.redirect(location)` then `ctx.status = status` (setting status *after*, per koajs/koa#857), and Hono `return redirect(c, location, status)` (the `Response` is returned from the handler)

- **`application/x-www-form-urlencoded` content type**: the `contentType` option and `BodyResult` now include urlencoded. The generated client serializes the single object argument with `new URLSearchParams(args[0]).toString()`, so native HTML forms can POST straight to an RPC endpoint without client-side serialization. Adapters parse `key=value&key2=value2` into an object via `URLSearchParams` (every value arrives as a string; repeated keys collapse to the last value) and use the framework's pre-parsed body (`express.urlencoded()`, `@fastify/formbody`, `koa-body`) when one ran first
- **Content-type enforcement**: the RPC middleware now validates the request's `Content-Type` against the function's declared `contentType` before parsing the body, rejecting mismatches with `415 Unsupported Media Type` on all four adapters. JSON and text functions are enforced strictly (exact match wins after stripping `charset`/`boundary` parameters); form functions (`multipart/form-data` or `application/x-www-form-urlencoded`) are lenient between the two encodings so native urlencoded form submissions keep working on multipart-declared endpoints. Requests without a `Content-Type` header (curl, GET, legacy clients) are exempt from enforcement. The check lives in the new `hasContentTypeMismatch`/`isFormContentType` helpers exported from `@thednp/rpc/server`

### Examples

- Add the `h3` example (`examples/h3`): SSR with [h3](https://h3.unjs.io/) using `createRPCMiddleware`, `serveStatic`, `toNodeListener`, and `viteMiddleware`. Dev mode bridges Vite's connect stack; prod serves static assets via `serveStatic` and falls through to SSR.
- The `demo` form-fallback middleware now uses the new `redirect` helper from `@thednp/rpc/express` instead of hand-writing the `303` + `Location` response
- Add a nojs fallback to the `demo` contact form (progressive enhancement): the form now carries native `action="/@demo/submit-contact" method="post"` attributes, and a small app-layer `createFormFallback` middleware (mounted before the RPC middleware) intercepts browser form navigations — recognized by `POST` + `application/x-www-form-urlencoded` + `Accept: text/html`, which the JS client never sends. Valid submissions get a `303` redirect to the pre-filled GitHub issue URL; invalid ones get a `303` redirect back to `/?name=..&errors=..`, where the server-rendered page (and hydration) recover the form values and show the same field-level error messages the RPC path would have returned. Validation, issue-URL building, and field lists are shared with the server function via the new `demo/src/lib/contact-form.ts`, and the server function now normalizes both multipart (`{ raw }`) and plain-object (urlencoded/JSON-with-fields) payloads
- Add the `react-query` example (Express + React 19 + `@tanstack/react-query` SSR): prefetches the greeting in `entry-server.tsx`, dehydrates it into `window.__REACT_QUERY_STATE__`, and hydrates on the client via `HydrationBoundary`
- Add the `solid-query` example (Express + Solid + `@tanstack/solid-query` SSR): prefetches the greeting, serializes it with `renderToStringAsync`, and documents the disabled-query SSR gotcha — a disabled `createQuery` hangs `renderToStringAsync` because the observer result carries a never-settling `promise` (from `experimental_prefetchInRender`) that seroval awaits forever; the example calls `queryClient.fetchQuery()` on submit instead

### Docs

- Document Request Context API (`provideRequestContext`/`getRequestContext`) in `wiki/server-functions.md` — per-request `AsyncLocalStorage` context with `nativeEvent`, `locals`, adapter-bound `redirect` across all 5 adapters
- Document urlencoded content type in `wiki/server-functions.md` and `wiki/wire-protocol.md` (new `POST + application/x-www-form-urlencoded` section)
- Document the `415 Unsupported Media Type` response and content-type enforcement rules in `wiki/wire-protocol.md`
- Document the strict/lenient content-type behavior in `wiki/server-functions.md`
- Add a "Content-Type Enforcement" section to `wiki/security.md`
- Document the `redirect` helper in `wiki/server-functions.md` (new "Redirects (`redirect`)" section) and cross-reference it from `wiki/adapters.md`
- Add h3 adapter section to `wiki/adapters.md` (installation, usage, body limits)
- Add h3 body limits to `wiki/best-practices.md` (Content-Length fast path + streaming cap via `for await (const chunk of event.req.body)`)
- Update `llms.txt`, `AGENTS.md`, and `README.md` for the new adapter, examples, content type, enforcement behavior, redirect helper, and request context

### Tests

- **100% coverage achieved** across all adapters (express, fastify, h3, hono, koa) — 920/920 statements, 559/559 branches, 144/144 functions, 898/898 lines
- Add h3 adapter test suite (`tests/h3.test.ts`): viteMiddleware (node/web runtime paths, settle-twice guard), createMiddleware (prefix/path filtering, name deduplication), createRPCMiddleware (dispatch, content-type enforcement, origin check, redirect default 303, cancel on close, error handling)
- Add redirect default-status tests to Express, Fastify, Hono, and Koa adapter suites (covers `status = 303` default param branch)
- Add urlencoded `readBody` tests for all four adapters (pre-parsed and raw stream paths), a urlencoded client-module codegen test in `plugin.test.ts`, and an end-to-end RPC middleware dispatch test
- Add content-type enforcement tests to the Express, Fastify, Hono, and Koa adapter suites (415 on json↔urlencoded/text↔json mismatch, lenient acceptance of urlencoded on multipart-declared functions) and unit tests for `hasContentTypeMismatch`/`isFormContentType` (parameter stripping, case insensitivity, no-header exemption, form leniency both directions)
- Add `redirect` tests: raw `ServerResponse` write path and native `.redirect()` delegation in `server-helpers.test.ts`, plus per-adapter suites asserting each framework API (Express `res.redirect(status, url)` vs raw write, Fastify URL-first `reply.redirect`, Koa status-after-`ctx.redirect`, Hono returning `c.redirect`'s `Response`)
- Fix `scripts/dev-test.js` to verify the query-framework examples' dynamically rendered greeting (`Hello Jane!`) instead of only the static `Hello World!` SSR marker; register the `solid-query` example prefix

### Chores

- Bump version to `0.2.0`
- Sync `deno.json` version with `package.json`

### Security

- **Content-type check moved before body read**: all four adapters now evaluate `hasContentTypeMismatch` *before* calling `readBody`, so mismatched requests are rejected with `415 Unsupported Media Type` without ever buffering/parsing the body (previously the body was read first, contradicting the documented behavior)
- **Streaming body-limit in the demo**: `demo/body-limit.ts` no longer buffers the entire body via `readBody` before checking the cap. It enforces the 1MB limit while the request stream is being read (dropping buffered chunks and destroying the request on overflow) and adds a `Content-Length` fast-path for obviously oversized requests — closing a memory-exhaustion gap on the demo's raw `node:http` and Netlify entry points
- **Netlify URL rewrite tightened**: `demo/netlify/functions/rpc.ts` now matches the `/.netlify/functions/rpc/` marker against the parsed `pathname` only (prefix match), instead of `indexOf` on the raw URL which could match inside a query string and rewrite unintended requests
- **`@hono/node-server` dedupe**: add a workspace `overrides: { '@hono/node-server': '>=2.0.5' }` in `pnpm-workspace.yaml` to collapse the vulnerable `1.19.17` transitive dependency (via `@hono/vite-dev-server`, which pins `^1.19.11`) onto the already-used patched `2.1.0`. `pnpm audit` is now clean

## [0.1.1] - 2026-08-07

### Security

- Unexpected exceptions no longer expose their message in development responses: `formatError` returns the generic `{ error: "Internal Server Error" }` for any non-`RPCError` error in every environment. `RPCError` payloads (developer-authored `message`, `code`, optional `data`) are still included in development so client-side error handling keeps working, while diagnostics stay server-side via the middleware's `console.error` logging (addresses the GitHub CodeQL `js/exception-information-leak` finding)

### Refactor

- `scanForServerFiles` lazy-imports Vite inside the scan function instead of importing it statically at the top of the module — the standalone server entry no longer carries a static Vite dependency, so serverless function bundles that register API modules directly no longer drag Vite's node chunk (which imports esbuild, absent with Vite 8's rolldown) into the bundle
- Drop the redundant `config as ScanConfig` casts in `scanForServerFiles` (the merged config is already typed)

### Fixes

- Netlify serverless deployment: externalize Vite from the function bundle via `[functions] external_node_modules = ["vite"]` in `netlify.toml`, so `@netlify/zip-it-and-ship-it` no longer fails with "Could not resolve 'esbuild'" when bundling the RPC function
- Fix broken documentation links in all 6 example READMEs (`wiki/setup.md` → `wiki/wire-protocol.md`, the former never existed)
- Remove stale `demo/src/render-bak.ts`; clean up the pnpm lockfile

### Docs

- Update `wiki/security.md`, `wiki/wire-protocol.md`, `README.md`, and `llms.txt` to reflect that unexpected exception details never reach clients — only `RPCError` payloads, and only in development

### Tests

- `formatError` dev-mode tests updated to assert the generic message for unexpected exceptions (plain `Error` and non-`Error` values), keeping the `RPCError` payload assertions

### Chores

- Sync demo and all 6 examples to `@thednp/rpc ^0.1.0`
- Remove the leftover `0.0.14` changelog header (its entry was merged into `0.1.0`)

## [0.1.0] - 2026-08-06

### Features

- **Typed errors with env-aware responses**: new `RPCError` class (`message` + `code` + optional `data`) and `formatError` helper. All adapters now return `{ error: "Internal Server Error" }` in production (no message/stack leak) and include the error message (plus `code`/`data` for `RPCError`) in development
- **Duplicate server function detection**: the scan throws in development when two files export functions with the same registered name, so the conflict surfaces at dev-server startup; in production it warns and keeps the first registration
- **Glob server file scanning**: new `serverFiles: "glob"` option recursively matches `*.server.{ts,js,mjs,mts}` under the scan root, complementing the classic exact `server.ts|js|mjs|mts` names
- **`scanRoot` option**: point scanning at any directory (relative to the Vite root), e.g. a shared RPC package in a monorepo
- **`multipart/form-data` content type**: the `contentType` option and `BodyResult` now include multipart; adapters detect multipart bodies from framework parsers (`multer`, `@fastify/multipart`, `koa-body`, Hono form helpers) and pass the parsed fields as the function argument, falling back to `{ raw: <body> }` on the raw stream path

### Refactor

- `src/index.ts` imports `scanForServerFiles`/`getClientModules`/`serverFunctionsMap` from source modules instead of the `@thednp/rpc/server` self-reference (which resolved to stale `dist/` types during type-checking)
- Plugin `options` initialized from `defaultRPCOptions` at creation time, so hooks can be invoked without `configResolved` having run

### Tests

- `formatError` unit tests (production vs development, `RPCError` code/data)
- Multipart `readBody` tests for all four adapters (pre-parsed and raw stream paths)
- Scan tests: glob mode (recursive + explicit `scanRoot`), duplicate detection (throw in dev, warn in production)

### Chores

- Rename the `prepublishOnly` script to `prepareOnly` in `package.json` (keeping `prepublishOnly_` as a non-triggering alias) so `npm publish` inside the release script no longer auto-runs the full pipeline
- Import `createRPCMiddleware` from the `@thednp/rpc/express` subpath export in `src/index.ts` instead of the relative `./express/createMiddleware.ts`; add `@thednp/rpc/express` to the tsdown externals and the vitest alias map
- Refactor `getClientModules` to build the generated client modules into a local `entries` const before assembling the output
- Publish workflow: remove the npm debug-log diagnostic step
- Sync all 6 examples to `@thednp/rpc ^0.0.13`; bump `@fastify/compress` to `^9.1.1` in the fastify example and add it to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`

## [0.0.13] - 2026-08-04

### Chores

- Bump version to `0.0.13`
- Add `hono@4.13.0` and `@hono/node-server@2.1.0` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` so pnpm 11's default 1-day minimum release age doesn't hold back the freshly published versions
- Update dependencies: `hono ^4.13.0`, `@hono/node-server ^2.1.0`, `fastify ^5.11.2`; sync all 6 examples to `@thednp/rpc ^0.0.12`
- Restore the `prepublishOnly` script name in `package.json`

### Docs

- Clarify `wiki/client-usage.md` and `wiki/security.md`, `README.md`, and `tsdown.config.ts` comments

## [0.0.12] - 2026-08-03

### Chores

- Bump version to `0.0.12`
- Publish workflow: drop `--provenance` from the npm publish step to match the vite-style publish flow (npm 11 auto-attaches provenance in trusted-publishing mode; the raw well-formed PUT fallback remains the working publish path)
- Add `scripts/update-examples.js` — syncs all examples to the latest published `@thednp/rpc` version — wired as `up:examples:lib` and included in `up:examples`
- Update all 6 examples to `@thednp/rpc ^0.0.11`

## [0.0.11] - 2026-08-02

### Chores

- Bump version to `0.0.11`
- Publish workflow: use npm only

## [0.0.10] - 2026-08-02

### Chores

- Bump version to `0.0.10`
- Publish workflow: pin `npm i -g npm@latest` (verified against npm 12.0.2 — OIDC token exchange `201` + sigstore provenance still published, but the `npm publish` PUT remains masked-403), strip the diagnostic capture/bisect steps and the `debug_403` dispatch input, and move `scripts/npm-request-recorder.js` to `experiments/`

## [0.0.9] - 2026-08-02

### Chores

- Bump version to `0.0.9`
- Publish workflow: drop `--allow-slow-types` from the jsr publish step (verified clean via `deno publish --dry-run`, no slow-types diagnostics)

## [0.0.8] - 2026-08-02

### Chores

- Bump version to `0.0.8`
- Publish workflow: move the header bisect diagnostic after the raw PUT fallback so probes always replay against the already-published version (never publish a fresh one); add a jsr version guard so release-triggered re-runs are no-ops

## [0.0.7] - 2026-08-02

### Chores

- Bump version to `0.0.7`
- Publish workflow: attempt plain `npm publish --provenance` (OIDC trusted publishing with provenance enabled) before falling back to the raw well-formed PUT; gate the CLI-403 diagnostic steps (request capture + header bisect) behind a `debug_403` workflow_dispatch input so release runs stay clean

## [0.0.6] - 2026-08-02

### Docs

- Add a **Body Size Limits** section to each framework's section in `wiki/adapters.md` (Express `express.json({ limit })`, Fastify `bodyLimit`, Hono `hono/body-limit`, Koa `koaBody({ jsonLimit })`), each matching its `examples/<framework>/server.js` implementation
- Clarify in `wiki/security.md` that Koa's official `koa-body` and Hono's built-in `hono/body-limit` middleware are the body size limiting enforcement points

### Chores

- Bump version to `0.0.6`
- Add `scripts/npm-request-recorder.js` — an in-process HTTP(S) request/response recorder injected into `npm publish` via `NODE_OPTIONS="--import"` that dumps the exact request headers/body and the server response to diagnose the CLI's masked 403 publish error
- Publish workflow: skip the CLI publish if the version already exists on the registry, add a "Capture CLI 403 (diagnostic)" step, and move `npm pack` output to `/tmp` so the git tree stays clean

## [0.0.5] - 2026-08-02

### TypeScript

- Export the `InnerModReturn` helper type from `src/types.d.ts` instead of declaring it locally in `src/helpers.ts`, so consumers can reference the `{ data, cancel }` return shape of `innerModule`
- Move all remaining module-local type/interface definitions into their closest `types.d.ts`, exporting them: `ScanConfig` and `RpcPluginOptionsInternal` → `src/types.d.ts`, `FastifyRPCPlugin`/`FastifyPlugin`/`RegisteredFastifyRPCPlugin` → `src/fastify/types.d.ts`, `IncomingWithBody` → `src/hono/types.d.ts`; removed now-unused imports (`ResolvedConfig`, `FastifyInstance`, `FastifyPlugin`) from their origin files

### Docs

- Update all 6 examples (`spa`, `express`, `fastify`, `hono`, `koa`, `ssr`) to `@thednp/rpc ^0.0.4`
- Clarify in the README "Why this exists" section the niche `@thednp/rpc` targets: RPC without the weight of an entire framework (Vite sites, static SPAs, single-middleware servers) — no meta-framework, full-stack router, or vendor required

### Chores

- Bump version to `0.0.5`
- `scripts/dev-test.js`: the default `@thednp/rpc` version used when restoring example deps is now read from the root `package.json` (as `^<version>`) instead of removing the dependency when no original value was saved
- Rebuild `dist/` to pick up the exported types

## [0.0.4] - 2026-08-02

### Breaking

- Restrict RPC dispatch to configured HTTP methods: server functions default to `POST` and are now rejected with `405 Method Not Allowed` on any other method (previously any method was accepted)

### Features

- Add `method` option to `ServerFunctionOptions` (`"GET" | "POST"`, default `"POST"`) for per-function HTTP method control
- Add `origin` option to `MiddlewareOptions` — when set, requests with a mismatching `Origin` header are rejected with `403 Forbidden` (requests without an `Origin` header, e.g. curl, pass)
- GET function dispatch: generated client modules send args as a URL-encoded `?args=` JSON query parameter (no request body)

### Security

- Enforce method + origin checks in all 4 adapters (Express, Fastify, Hono, Koa) with anchored prefix matching already in place
- Hono adapter: guard `env.incoming` with optional chaining so bare serverless environments without an incoming stream no longer crash

### Fixes

- Scan server files by exact filename (`.ts`/`.mjs`/`.cjs` in the configured directory) instead of substring matching, so files like `server.tsx` are no longer picked up
- Bump `@hono/node-server` to `^2.0.5` via `pnpm-workspace.yaml` override (fixes GHSA-frvp-7c67-39w9 audit advisory pulled in transitively by `@hono/vite-dev-server`)

### Docs

- Add `wiki/best-practices.md` sections on rate limiting and Origin/CSRF protection with framework-specific middleware snippets
- Document the `method` option in `wiki/server-functions.md`
- Add Method Enforcement and Origin Validation sections to `wiki/security.md`
- Document exact scan filename matching in `wiki/setup.md`
- Add an "HTTP Method" section to `wiki/server-functions.md` explaining why only GET and POST are supported (RPC has no resource semantics, OPTIONS is reserved for CORS preflight, minimal attack surface)
- Add a method-restriction security note (GET/POST only) to the README security section

### Chores

- Bump version to `0.0.4`
- Add test coverage for method dispatch (POST default, GET with `?args=`, 405 enforcement), origin validation (mismatch 403, absent origin passes), and exact scan matching
- Reach 100% test coverage (232 tests): add `validateMethod` suite, GET client-module fetch test, and GET dispatch coverage for Hono and Koa
- Add a GET server function demo (`getServerTime`) with a "Get time" UI and shareable link to all 6 examples; add `tsconfig.json` to the `ssr` example and `types: ["vite/client"]` to example tsconfigs
- Move `dev-test.js` to `scripts/dev-test.js` and enhance it: switch examples to `link:../..` before testing and restore the published version afterwards, verify GET dispatch, install with `--no-frozen-lockfile`
- Add `scripts/audit-src.js` — audits only the root package's dependencies in a temp project (344 deps vs 413 for the full workspace) — wired into `prepublishOnly` as `audit:src`
- Add `scripts/update-deno.js` to sync JSR metadata (`version`, `description`, `keywords`, `license`) from `package.json` into `deno.json`; add `up:deno` task
- Refactor `deno.json` tasks to `deno task` self-references; `prepublishOnly` is now `upd` + `lint` + `format` + `audit:src` + `build`
- Run `pnpm audit` in CI and trigger workflows on `pnpm-workspace.yaml` changes
- Sync `deno.json` keywords with `package.json` (`vite`, `vite-plugin` added)

## [0.0.3] - 2026-07-30

### Docs

- Add comprehensive JSDoc to all exported functions across the codebase (~50 symbols) with `@param` and `@returns` tags
- Add `@module` JSDoc to all 8 entrypoints for JSR documentation generation
- Add JSDoc to all exported types, interfaces, and their properties (framework hooks, middleware options, JSON types, adapter types) for JSR documentation scoring

### Chores

- Add `description`, `author`, and `keywords` to `deno.json` for JSR metadata
- Add `imports` map to `deno.json` for JSR self-referencing resolution
- Bump version to `0.0.3`

## [0.0.2] - 2026-07-30

### Breaking

- Rename `rpcPreffix` → `rpcPrefix` across all configs, adapters, types, and docs (the old typo is no longer recognized)

### Features

- Add `credentials` option to `ServerFunctionOptions` (`"same-origin" | "include" | "omit"`, default `"same-origin"`)
- Add `validateCredentials()` to validate the credentials option at build time
- Rename `rpcPreffix` internal variable consistently to `rpcPrefix`
- Thread `credentials` through generated client modules and `innerModule`

### Refactor

- Centralize all error/warning messages into `src/constants.ts`
- Extract validation functions (`validateIdentifier`, `validatePathSegment`) into `src/validate.ts` with 100% test coverage
- Move safe-identifier regex patterns from `constants.ts` to `validate.ts` (implementation detail)
- Add explicit return types to all adapter helpers and core functions
- Add `RequestDetails` and `ResponseDetails` types to Express adapter
- Add `InnerModReturn` helper type to `helpers.ts`
- Fully type Fastify plugin with explicit interface
- Type `serverFunctionsMap` explicitly in `functionsMap.ts`
- Convert `defineConfig` and `loadRPCConfig` to typed arrow functions

### Fixes

- Publish workflow: remove `--provenance`, Node version 24
- Fix AGENTS.md express command, fix Koa adapter docs
- README GitHub URLs: `rpcv` → `rpc`
- Proper pnpm workspace setup for StackBlitz
- StackBlitz compatibility for examples
- Remove `prepare` script to prevent rolldown native binding error on StackBlitz
- SPA proxy server: cast `createRPCMiddleware` options for type safety
- Move adapter deps from `devDependencies` to `dependencies` for correct runtime resolution

### Docs

- Expand Authentication section in best-practices with Basic Authorization + Per-Function Authorization examples
- Add CONTRIBUTING section to README
- Update all wiki docs to use `rpcPrefix`
- Clarify isomorphic nature of server functions in wiki
- Add README.md to each example
- Use full wiki URLs in example READMEs
- Fix broken link in security.md (`best-practives.md` → `best-practices.md`)
- Fix cancellation description in client-usage.md to match actual behavior

### Chores

- Create CHANGELOG.md
- Update `dist/` with latest builds
- Update examples dependencies
- Bump version to `0.0.2`
- Add `keywords` field to package.json
- Move `picocolors` from root to examples/spa

## [0.0.1] - 2026-07-28

### Initial Release

- Vite plugin for automatic RPC generation
- Framework-agnostic core with adapters for Express, Fastify, Hono, and Koa
- Auto-scanning of server functions via `scanForServerFiles`
- Client-side module generation at build time
- Request cancellation via `AbortController`
- Prefix-gated RPC endpoint with regex boundary protection
- Code injection prevention in client module generation
- SSR and SPA support
- Configuration via `rpc.config.ts`
