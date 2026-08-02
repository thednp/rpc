# Changelog

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
