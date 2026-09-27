# Changelog

## [0.3.7] - 2026-09-27

A correctness pass over the transport, found by auditing the codebase against its
own documentation. Two of the three headline bugs were found *by* that audit
being unable to corroborate the docs — they were documented, tested-adjacent, and
wrong.

**What was broken**

- **Hono's RPC returned `500` for every request on any runtime that is not
  `@hono/node-server`** — Workers, Bun, Deno, standalone serverless, and Hono's
  own `app.fetch()`. Three unguarded `c.env` reads, and a disconnect hook whose
  comment said "may be absent ... so guard the close hook" followed by
  `c.env.incoming?.`, which guards a null `incoming` rather than an absent
  `c.env`. The fixtures always set `env`, so nothing caught it.
- **A malformed declared-JSON body was answered `200` with the raw string handed
  to the handler** on Express, Koa and Fastify, and `500` on Hono and h3. The
  cause was a `readBody` ternary with no `isJSON` branch: text bodies also went
  through `JSON.parse`, so a malformed JSON body and a legitimate text body threw
  the same exception and were indistinguishable. The `200` failed *open*.
- **The documented global-prefix and serverless flows returned `404` on every
  adapter**, and `loadRPCConfig` skipped publishing the prefix on its most
  common code path.
- **Only the first scan in a process ran**, so a second RPC instance on its own
  prefix could never populate its map.
- **A CI gap let the export-surface test pass while the type it guards was
  deleted** — it is a build-output test, and the build step was commented out.

**What changed underneath**: a malformed request is now a `4xx` and never a
silent `200` or a `500`, via one shared rule used by all five adapters; the
prefix resolves through a single `resolveRPCPrefix()`; and two config options
that never did anything (`adapter`, and `rpcPrefix: false`) are gone, with the
one type that carries real meaning extracted as `AdapterName`.

This release **does** change the emitted bundles — `src/index.ts`,
`src/scanForServerFiles.ts`, `src/server-helpers.ts`, `src/getClientModules.ts`,
`src/constants.ts`, `src/options.ts`, `src/types.d.ts` and all five
`src/*/createMiddleware.ts` + `src/*/helpers.ts` files — so `dist/` is rebuilt
and must be committed with the source. **Breaking**: express/koa/fastify now
answer `400` where they answered `200` for a malformed body, and a config
carrying `adapter:` now fails typecheck rather than being ignored.

### ⚠️ Behaviour change — prefix resolution

- **The documented global-prefix and serverless flows returned 404 on all five adapters.** `createRPCMiddleware` merged `{ rpcPrefix: defaultRPCOptions.rpcPrefix }` into its options *before* resolving the prefix, so `rpcPrefix` was always the truthy `"__rpc"` and the trailing `rpcPrefix || getGlobalPrefix() || defaultPrefix` was unreachable. `createServerFunction` *does* honour the global prefix, so the two halves disagreed — with `setGlobalPrefix("@demo")`, a middleware built without an explicit prefix answered `next()` for `/@demo/greet` (falling through to the app) and `"Function not found"` for `/__rpc/greet`. `attachRPC` escaped this only because it threads the loaded config through explicitly, which is why every example passed.
  The default injection is gone, and all five adapters now resolve through a new `resolveRPCPrefix()` (`src/server-helpers.ts`) used in *both* the outer `createMiddleware` gate and the `createRPCMiddleware` dispatch, so parity is structural rather than a convention. **The change only affects states that were already returning 404:** with no global prefix set — every example and every other test — the resolved prefix is still `"__rpc"`, and an explicitly-passed prefix still wins. The boundary regex is built from the *resolved* prefix so gating is never dropped.
- **`loadRPCConfig` now publishes the global prefix on every return path.** It returned from inside its config-file search loop without calling `setGlobalPrefix`, while the explicit-`configFile` and no-config paths both did — so the common case (an `rpc.config.ts` exists) was the one that skipped it. Masked in the plugin path because `scanForServerFiles` re-resolves the prefix itself; exposed in the `attachRPC` / direct-import path.

Both bugs shipped at 100% coverage because every fixture in `tests/fixtures/*.ts` called `setGlobalPrefix(undefined)`, so the state the feature is *about* was never exercised. `tests/express.test.ts` now has a `global-prefix dispatch` block (6 tests) that sets a real prefix, and `tests/plugin.test.ts` has a file-level `afterEach` resetting it.

One related thing was investigated and deliberately left alone: a config file that throws still resets the `RPCConfig` cache to the defaults, because the "fall back to defaults" contract is asserted by tests. (The `rpcPrefix: false` phantom found by the same audit is handled below.)

### ⚠️ Breaking — the inert `adapter` config option is gone

- `RpcPluginOptions.adapter` (`'express' | 'hono' | 'h3' | 'fastify' | 'koa'`) was **never read by anything**. Exactly two places in the whole source touched its value: `src/index.ts` destructured it out and discarded it (`const { adapter: _adapter, ...rest } = options`), and passed it into `getClientModules`, which spread it into a helper's options and never looked at it. The adapter is determined entirely by which subpath you import — `@thednp/rpc/express`, `/hono`, `/koa`, `/h3`, `/fastify` — which is exactly how the type system already modelled it, each adapter hardcoding its own literal into `MiddlewareOptions<"express">` etc.
  A runtime value could therefore only ever *disagree* with the subpath actually mounted, and nothing read it to notice. Setting `adapter: "hono"` while mounting Express silently did nothing. The field is removed; the **union survives as the exported `AdapterName` type**, which is what keys `FrameworkHooks[A]["handler"]` at `src/types.d.ts:383` and is genuinely load-bearing.
  Removed alongside it: `adapter` from `RpcPluginOptionsInternal` (which is why `getClientModules` only ever needed `rpcPrefix`), from `defaultRPCOptions`, and the five `const { adapter: _adapter, ...options } = await loadRPCConfig()` workarounds in `src/*/helpers.ts` and the example servers — a phantom field that every consumer had to strip out by hand before the middleware would accept the config. `configuration.md` no longer lists it.
  Compile-time only: a config file still carrying `adapter:` now fails typecheck rather than being ignored.

- **Also removed (types only): `rpcPrefix: false`.**

  `MiddlewareOptions.rpcPrefix` was declared `string | false`, but `false` was **documented nowhere, tested nowhere, and handled nowhere**. Measured: it was byte-identical to omitting the option — `createRPCMiddleware({ rpcPrefix: false })` dispatched exactly like `createRPCMiddleware({})` for both `/__rpc/greet` (200) and `/anything/greet` (fall-through). A silent no-op that reads like "disable prefix gating" is worse than an absent option, so the type now says `string`. `resolveRPCPrefix()`'s signature was narrowed to match.
  This is a **compile-time-only** change: JavaScript callers passing `false` are unaffected at runtime, since the `||` chain still falls through to the global prefix and then the default. It only surfaces for TypeScript users who wrote `rpcPrefix: false` — and for them the error is the correction, because they had been running with full prefix gating while believing the gate was disabled.

### ⚠️ Behaviour change — malformed request bodies are now `400`, not `200` or `500`

- **A declared-JSON body that does not parse used to be answered `200` with the raw string handed to the handler** on Express, Koa and Fastify, and `500` on Hono and h3. Both outcomes were wrong, and the first was worse: it failed *open*. The cause was in `readBody`, where all three content-type branches fell through to a single `JSON.parse(body)` — so a `text/plain` body also went through `JSON.parse`, threw, and was "recovered" by a catch that resolved it as `text/plain`. A malformed JSON body and a legitimate text body were therefore indistinguishable, and the recovery path silently answered `200`.
  Only a *declared* JSON body is now parsed strictly; everything else keeps the lenient sniff, which is deliberate and load-bearing — a request with no `Content-Type` at all (curl, and the nojs form fallback) that happens to carry JSON must still arrive parsed. On failure the error is tagged with a `400` (`httpError`, new) and every adapter answers `{ error: "Bad Request" }`.
  This matches every supported host: Express `body-parser` (`entity.parse.failed` → 400), Fastify (`FST_ERR_CTP_INVALID_JSON_BODY` → 400), koa-bodyparser (400), and h3's own `readBody` (`HTTPError` 400, which rpc was discarding by parsing the body itself). Hono has no opinion here — its maintainers declined to own the case in honojs/hono#578 — so as the thing doing the parsing, rpc answers 400 for it.
- **Only the first scan in a process ran.** `scanForServerFiles` memoized with a single module-level boolean, so the *first* scan suppressed every subsequent one. The scan target is now keyed on the resolved `(scanRoot, serverFiles, rpcPrefix)` triple — everything that determines which files are read and where prefix-less functions register — so a repeat of the same scan is still skipped, but a second RPC instance on its own prefix now scans. Previously that instance asked for a lazy scan, got an early return, and answered `404` for every function it owned. Only reachable with a function declaring no `rpcPrefix` under a second middleware, i.e. a configuration that was already broken; it is now correct. Functions that declare their own prefix were never affected — one scan registers them all.
- **A malformed GET `?args=` is now `400` on all five adapters.** It previously threw out of the dispatch's `try` and was reported as a `500` — a cheap way for a client to generate server errors. The existing non-array case already answered `400`; only the malformed-syntax half was wrong.
- Client-error statuses are surfaced through one shared rule (`isClientHttpError` / `clientErrorStatus` / `clientErrorMessage` in `src/server-helpers.ts`) rather than per-adapter logic, so a host framework's signal and an rpc-raised one are handled identically. It reads both `status` (h3's `HTTPError`, rpc's `httpError`) and `statusCode` (the `http-errors` objects Express throws, Koa's `ctx.throw`), and the response body comes from a fixed table so no host-framework message is echoed back. `5xx` and unrecognised errors still go through `formatError`.

### Fixed

- **⚠️ Hono's RPC was broken on every runtime that is not `@hono/node-server`.** `readBody`, the client-disconnect hook and `viteMiddleware` each read `c.env` unguarded, so on Cloudflare Workers, Bun, Deno, standalone serverless adapters — and Hono's own `app.fetch()` — `c.env` is `undefined` and *every* request threw a `TypeError` and came back as a `500`, including a well-formed one. The disconnect hook even carried a comment saying the runtime adapter "may be absent ... so guard the close hook" and then wrote `c.env.incoming?.`, which guards a null `incoming` but not an undefined `c.env`. The existing fixtures always set `env`, so nothing caught it; four tests now drive a real `Hono` app through `app.fetch()` where `c.env` is genuinely absent.

- **h3 reported an oversized body as a `500` instead of a `413`.** h3's `bodyLimit`/`assertBodySize` enforces its cap in two places: an honest `Content-Length` over the limit is rejected up front, before rpc is reached, but a **chunked** body (no length to check) trips *while the stream is read* — which is inside the RPC dispatch's `try` block. The adapter's generic catch flattened h3's `413` into a `500`, so h3 was the only adapter that reported an oversize body as a server fault; the other four get their `413` from the host body parser before rpc runs. The h3 adapter now forwards h3's own `4xx` out of the dispatch `try` (`413` becomes `{ error: "Payload Too Large" }`), while `5xx` and unrecognised errors still go through `formatError`. Covered by a real-`H3` test that streams a body with no `Content-Length` and asserts `413`, verified to fail with the fix removed.

- **`loadRPCConfig({ silent: true })` silently discarded the config** (`src/index.ts`). The documented single-argument form passes the options bag where the signature expects a config path, so `resolve()` threw `ERR_INVALID_ARG_TYPE`, the `catch` swallowed it, and the call returned `defaultRPCOptions` instead of the project's real config — with only a `Failed to load RPC config` warning as evidence. This was the form shown in `wiki/configuration.md`. An object first argument is now normalised to the options bag, and both the two-argument and one-argument forms work.
- **Vite 10+ silently used the wrong transform pipeline** (`src/index.ts`). `isOxc` was derived from `Number(viteVersion[0]) >= 8`, which reads the first *character*: `"10.4.2"` yields `1`, fails the `>= 8` test, and routes every future double-digit Vite through `transformWithEsbuild` instead of `transformWithOxc`. Now parsed as an integer major.
- **An export-less module silently abandoned the rest of the scan** (`src/scanForServerFiles.ts`). A module with no exports warned and then `return`ed out of the whole function rather than `continue`ing to the next file, so in `serverFiles: "glob"` mode every file after it was dropped without a word. Any glob project with a helper or barrel file that exports nothing was affected, and the missing functions surfaced only as `404`s at request time.
- **h3's outer gate resolved its prefix differently from the other four adapters** (`src/h3/createMiddleware.ts`). It used the three-way `rpcPrefix || getGlobalPrefix() || defaultPrefix` where express/fastify/hono/koa use `rpcPrefix ?? defaultPrefix`, so the same setup could pass h3's gate and be rejected by the others. Normalised to match.
- **Scan fixtures could not compile** (`tests/fixtures/scan-api/src/api/users.server.ts`, `upload.server.mts`): both called `createServerFunction(handler)` with the required `name` argument missing, so neither file was valid against the real signature. This never surfaced because `scanForServerFiles` discovers server modules by *filename* and never imports them — a fixture that would fail to compile sat in the tree indefinitely. Both now match the real API.

### Tests

- **Regression tests for each runtime fix**, each verified to fail with the bug reintroduced. The Vite-version test asserts *which* transformer was called — the existing vite 7/8 tests only asserted the output was non-empty, and both mocked transformers return the input, which is why `Number(viteVersion[0])` survived. The scan test uses a fixture with two export-less modules and one populated, so it fails under any directory read order.
- New `tests/fixtures/scan-mixed/` (`a-empty.server.ts`, `b-loaded.server.ts`, `c-empty.server.ts`); `tests/fixtures/vite-mock.ts` gains `mockPlugin10Context` for the double-digit major version.
- **The Fastify reply mock now carries `redirect`** (`tests/fixtures/fastify.ts`): the v5-signature helper in `src/fastify/helpers.ts` calls `reply.redirect(location, status)`, so all four redirect tests had to attach the method to the double with a cast. The mock ships it instead. All four still assert on the call, so none became vacuous.
- Removed genuinely dead code from the suites: an unused `sendResponse` import (express, hono), an unused `app` binding (express), three unused `result` bindings (hono), an unused trailing `cb` parameter (h3), and a commented-out `origWarn` (scan).
- **17 pre-existing type errors in the test suite fixed.** None were reachable before — see the `check:tests` entry below.
- The `F1` finding was originally tracked as an `it.todo` in `tests/express.test.ts`; once fixed it became a six-test `global-prefix dispatch` block that sets a real global prefix. Three of the six fail with the bug reintroduced; the other three guard behaviour that must *not* change (default prefix with no global prefix set, explicit prefix winning over the global one, and boundary safety on a resolved prefix). `tests/plugin.test.ts` gained a file-level `afterEach` resetting the global prefix, since `loadRPCConfig` now publishes it and would otherwise leak into every later `createServerFunction` call.

### Chores

- **CI now builds before testing** (`.github/workflows/ci.yml`). `tests/adapter-exports.test.ts` is a build-output test that parses the emitted `dist/<adapter>/*.d.mts`, but the build step was commented out. Because `dist/` is committed the file exists on a fresh checkout, so the suite silently validated the *last committed bundle* rather than current source — demonstrated by deleting `ExpressApp` from `src/express/types.d.ts`, which passed 56/56 with no build and fails with one. That test exists to stop a type name "quietly disappearing in a refactor", and it could not do so.
- **CI checks formatting instead of rewriting it** (`format:check`, new script). The workflow ran `pnpm format`, which rewrites files in the runner with no `git diff --exit-code` afterward, so format drift never failed a build — it just got silently "fixed" somewhere nobody would notice. `deno fmt --check` exits non-zero with `Found N not formatted files`.
- **The test suite is now typechecked** (`tsconfig.tests.json`, `check:tests`): `tsc` only ever covered `src`, so none of the test files were typechecked despite being a large part of the tree. `lint` now runs a third step after `check:ts`.
  It is a **separate tsconfig on purpose**: `tsdown` emits declarations from `tsconfig.json`, and pulling `tests/fixtures` into that program raises TS2883 (*"inferred type cannot be named without a reference to 'Procedure' from `…/vitest/dist/…`"*) and fails the build. Under `noEmit` those errors do not occur, so tests are checked in their own program rather than the emit one.
- Removed dead and duplicated logic in the plugin entry: the unreachable third clause of the `transform` guard (`code.includes(...)` was already tested, and `typeof process === "undefined"` is always false inside a Node-hosted plugin), a per-call `await import("vite")` replaced by a static namespace import, a `(!initialCfg && !devServer) || !initialCfg` no-op, and the two duplicated config-merge blocks folded into one `mergeLoaded` helper.

### Docs

- **`wiki/comparison.md` re-verified against vendor source and documentation**, and it was wrong in a security-relevant direction. Next.js does **not** abort a request with no `Origin` — an absent header is let through with a dev warning, on the stated reasoning that a handcrafted request cannot carry unwilling victim credentials. That is the *same* fail-open posture `@thednp/rpc` takes for its curl/native hole, and the page had claimed rpc was uniquely permissive about it. TanStack was also overstated: it rejects a request carrying *no* signal at all, not specifically one lacking `Origin` (a no-`Origin` request with a same-origin `Referer` is allowed). Corrected, with a note recording what the earlier draft got wrong.
  Also updated: the `GHSA-mq59-m269-xvcx` entry with its CVE alias, severity, affected range (`16.0.1`–`16.1.6`) and fix version (`16.1.7`); SvelteKit's `trustedOrigins: ['*']`, which does **not** rescue a missing-`Origin` form POST, and the fact that PR #14795 was **closed unmerged** — remote functions are exempt from `trustedOrigins` by design, not awaiting a fix; a **removed** claim that `Referrer-Policy: no-referrer` causes SvelteKit CSRF false positives (SvelteKit reads only `Origin` and has no `Referer` fallback, so that mechanism does not exist); tRPC's POST `Content-Type` enforcement as a form-CSRF mitigation it does ship; `shield()` being dev-off by default; and verified versions for all five projects in the header and Sources.

### Docs

- **`AGENTS.md` — the URL-normalization note overclaimed.** It stated that *every* adapter parses the request URL through the shared `safeURL()` helper. In fact fastify/hono/koa call it directly, express reaches it through `getRequestDetails`, and **h3 does not call it at all** — it reads `event.url.pathname`, which h3 has already parsed, so the throw-on-malformed-target case is handled upstream by h3. There was never a security gap; the note claimed more than the code did. Corrected in both the security section and the threat-model table.
- **`AGENTS.md` — the deferred-findings section became a *Fixed in 0.3.7* section** once the two prefix bugs landed, so it now documents the guardrails instead of the open questions: `resolveRPCPrefix()` is the single resolution point and a local `a || b || c` in an adapter is a regression; the removed default injection is *why* the `|| getGlobalPrefix()` fallback was unreachable; the boundary regex must be built from the resolved prefix but still gated on an explicitly-supplied one, because building it unconditionally would start gating a bare `createMiddleware({ path, handler })`; and a throwing config file still resets the `RPCConfig` cache, deliberately. It also keeps the coverage lesson that let both bugs through at 100%.
- **`wiki/middleware.md` — the framework-agnostic alternative to the `locals` bridge.** The page documented per-adapter recipes for reaching pre-dispatch framework state, but on Fastify and Hono those are five separate code paths with no coverage, and Fastify has no per-request store to bridge at all. New *The Framework-Agnostic Alternative: Handler Wrappers* section documents the part of the contract that actually carries: `event.locals` is a mutable object rpc passes into the request context, so a handler wrapper can resolve per-request data and store it there — identically on all five adapters, with no framework imports and no new rpc API. Includes a signed-cookie session worked example, a "when to use which" split against the framework-middleware path, and the honest tradeoff (a wrapper runs per function call, so request-pipeline concerns still belong in real framework middleware). The Fastify/Hono note now points at it as the better default
- **New `wiki/comparison.md`** — the cross-origin / CSRF boundary compared against Next.js Server Actions, TanStack Start, SvelteKit, and tRPC, with a section covering Vike and Telefunc. Verified against vendor documentation on 2026-09-27 rather than written from memory, which changed several conclusions: TanStack's `createCsrfMiddleware` is auto-installed and **fails closed**; Next.js shipped `GHSA-mq59-m269-xvcx` for treating `origin: null` as missing (rpc rejects it by default); tRPC shipped `CVE-2025-68130` for prototype pollution via FormData keys (rpc's urlencoded path is verified immune). Measured against TanStack's documented algorithm, rpc is **stricter in three cases** — an untrusted `Origin` claiming `Sec-Fetch-Site: same-origin`, `Origin: null`, and lookalike hosts — because checking `Origin` first is what closes them, and more permissive in two, both deliberate (the allowlisted sibling, and the headerless curl case)
- Framed as *fail-open by default, strictest-once-configured, multi-origin without a proxy* — with `Where the trade costs you` keeping the real sharp edges (case-sensitive origin matching, literal origins only, no automatic input validation, deliberate `Referer` omission). Linked from all 13 other wiki pages, `wiki/index.md`, `AGENTS.md`, and `llms.txt`; the `AGENTS.md` entry warns future agents to read it before writing security copy
- Two broken wiki anchors fixed: `client-usage.md#native-http-clients--unwrapenvelopet` and the tier-order slug in `comparison.md`. A link/anchor pass validates all 47.

## [0.3.6] - 2026-09-27

Two independent changes: a **behaviour change** to origin validation, and an
additive expansion of the adapter type exports.

### ⚠️ Behaviour change — `Sec-Fetch-Site` fallback under `origin`

- **`isOriginRequestAllowed(allowed, origin, site)`** (`src/server-helpers.ts`, exported from `@thednp/rpc/server`): the origin check now consults `Sec-Fetch-Site` when `Origin` is missing, instead of treating a headerless request as an unchecked pass. Previously anything in the chain that stripped `Origin` — a proxy, a sanitising middleware, a misconfigured CDN — turned a precise allowlist check into a **no-op**. Four tiers, first signal wins:
  1. `origin` option unset → everything passes (unchanged; the check is opt-in)
  2. `Origin` present → the allowlist decides, exactly as before
  3. `Origin` absent, `Sec-Fetch-Site` present → allow only `same-origin` and `none`; anything else, including an unrecognised value, is **403**
  4. Both absent → passes. This is the deliberate, documented curl/native-client hole and it stays
- **All five adapters now pass both headers.** `Origin` still short-circuits ahead of `Sec-Fetch-Site`, and it has to: the allowlist exists precisely to admit a sibling subdomain, whose browser request carries `Sec-Fetch-Site: same-site` — a value tier 3 alone would reject. `Sec-Fetch-Site` is a coarse enum that cannot name a host, so it only earns a vote once the precise signal is gone, at which point it fails closed. A regression test pins the ordering
- **What changes:** only requests that (a) lack `Origin`, (b) carry `Sec-Fetch-Site`, and (c) claim anything other than `same-origin`/`none` move from *pass* to *403*. That class was the bug. Browsers never strip `Origin` themselves, so tier 3 only fires when something removed it — **no legitimate browser request can regress**
- **`isOriginAllowed` is unchanged and still exported** (public API since 0.3.5); it is now an internal building block
- **No new option.** Setting `origin` remains the only opt-in, so the surface is frozen — the plan's stated default. An app with `origin` set gets the stronger check by upgrading, with no code change
- **Empty header values count as absent.** Adapters disagree on what their accessor returns for a missing header (Node yields `undefined`, Hono's `c.req.header()` yields `""`), and an empty `Sec-Fetch-Site` is not a real browser signal. Normalising in the shared helper keeps all five behaving identically instead of inheriting each framework's convention
- `origin` JSDoc in `MiddlewareOptions` rewritten — it no longer promises unconditional headerless passthrough

### Added — adapter type exports for wrappers

Wrapper libraries must be able to annotate apps, requests, responses, `next` functions and middleware **without depending on the framework**. The 0.3.2 re-exports were incomplete and irregular, so each adapter exposed a different shape. Now uniform and additive:

| Adapter  | App (new)   | Request (new)             | Response (new)                | `next` (new)                       |
| -------- | ----------- | ------------------------- | ----------------------------- | ---------------------------------- |
| express  | `ExpressApp` | — (`ExpressRequest`)       | — (`ExpressResponse`)         | — (`ExpressNext`)                  |
| fastify  | `FastifyApp` | — (`FastifyRequest`)      | `FastifyResponse`             | `FastifyNext`                      |
| hono     | `HonoApp`    | `HonoRequest`             | `HonoResponse`                | `HonoNext`                         |
| koa      | `KoaApp`     | `KoaRequest`              | `KoaResponse`                 | — (`KoaNext`)                      |
| h3       | — (`H3App`) | `H3Request`               | `H3Response`                  | `H3Next`                           |

- **`next` was missing on 3 of 5 adapters** — `createMiddleware` accepts a `HookHandlerDoneFunction` (Fastify), a `Next` (Hono) and a `next` callback (h3), and none of those types were exported, so a wrapper could not type a composed handler
- **Hono had no request type.** Only `HonoContext` was exported, forcing consumers to cast the request object structurally
- **`RequestDetails` / `ResponseDetails` were express-only** despite containing no Express-specific types. They now live in `src/adapter-types.ts` and are re-exported from **all five** adapters, so one helper can be written across all frameworks. Still importable from `@thednp/rpc/express`
- **`Koa` re-export moved** from `src/koa/index.ts` into `src/koa/types.d.ts` beside its siblings (it is the only type that lived in a barrel). `src/koa/helpers.ts` now takes the type from `types.d.ts` instead of the barrel, removing an index→helpers import cycle
- **Purely additive.** No existing export renamed, removed or narrowed — `Express`, `Fastify`, `Hono`, `Koa`, `H3Event`, `HonoContext`, `KoaContext` all keep working. Type-only, so emitted `.mjs` is unchanged

### Tests

- **Adapter export-surface contract suite** (`tests/adapter-exports.test.ts`): asserts every adapter's emitted declaration exports the full required name set, plus a back-compat assertion for the pre-0.3.6 names. Type-only exports are erased from the `.mjs`, so the suite parses `dist/<adapter>/<adapter>.d.mts` — the thing a consumer actually resolves. Verified non-vacuous: renaming any required name in a copy makes it fail
- `isOriginRequestAllowed`: every row of the behaviour matrix verbatim, the sibling-subdomain ordering regression, the empty/whitespace-value normalisation, and case-sensitivity
- Per adapter: `Sec-Fetch-Site: cross-site` with no `Origin` → `403`, `same-origin` → `200`, and the sibling-subdomain regression (`allowlisted Origin` + `same-site` → `200`)
- Fixed a fidelity bug in the Hono test fixture — `header()` returned `""` for a missing header where real Hono returns `undefined`, which had masked the empty-value normalisation
- **556 tests, 100% on all metrics**

### Chores

- Bump version to `0.3.6` (`package.json`, `deno.json`)

## [0.3.5] - 2026-09-26

### Features

- **Multi-origin allowlist for the `origin` option**: `createRPCMiddleware({ origin })` now accepts a single origin string *or* an array of them, so a deployment can serve several trusted origins (e.g. `["https://app.example.com", "https://admin.example.com"]`) without a proxy in front. A request is rejected with `403` only when it carries an `Origin` header that matches **none** of the entries; headerless requests (curl, native clients) still pass through, and an unset `origin` still performs no validation. **Backward compatible** — a string behaves exactly as before, and a one-element array is equivalent to that string, so this is a minor rather than a breaking bump
- **`isOriginAllowed(allowed, requestOrigin)` shared helper** (`src/server-helpers.ts`, exported from `@thednp/rpc/server`): the origin rule lived as a copy-pasted 6-line block in all five adapters; it now lives in one place, so the five can't drift. Non-exported from the client entry — it is server-side only
- **Origin matching is exact, not prefix-based**: `https://app.example.com.evil.com` and `https://app.example.com:443` are both rejected, so a lookalike host cannot ride in on a substring match

### Refactor

- All five adapters (`src/{express,fastify,hono,koa,h3}/createMiddleware.ts`) call the shared `isOriginAllowed` instead of inlining the check; the per-adapter comment blocks shrank to a single line. Behavior is unchanged for existing single-string configurations

### Tests

- **Full 5-case × 5-adapter matrix** for the origin rule, per the BartJS change request: single-string match → `200` (back-compat), non-matching → `403`, headerless → passes, allowlist-array match → `200`, allowlist-array miss → `403`, plus `Origin: null` → `403`. Three adapters (Fastify, Hono, Koa) were missing the single-string back-compat case and now have it
- `isOriginAllowed` unit suite: unset allowlist, headerless request, exact single-string match, multi-entry array match, one-element-array equivalence, `Origin: null` rejection, prefix/substring non-matching, case-sensitivity, empty-allowlist behavior, and an assertion that the helper is reachable from the `@thednp/rpc/server` barrel (which is how BartJS will import it)
- **475 tests, 100% on all metrics**

### Chores

- Bump version to `0.3.5` (`package.json`, `deno.json`)

## [0.3.4] - 2026-09-26

### Fixed

- **`unwrapEnvelope` now honors the error contract it was documented as having** (`src/client-helpers.ts`, exported from `@thednp/rpc/helpers`): the helper added in 0.3.3 was a pure property accessor — it returned `json.data` when present and otherwise passed the input through **unchanged**, with no `error` check and no status-code awareness. Given a 403 or 500 body it returned the error object as though it were a result, so a native client that checked the unwrapped value but not `res.ok` treated an authorization failure as a success — a fail-open error swallow in a helper whose entire purpose is native-client ergonomics. It now throws on a **top-level** `error` key (which the server emits only for `400`/`404`/`405`/`415`/`500`), matching the sibling `handleResponse` in the same module, which always checked `result.error`. Discriminating on *error present **and** data absent* preserves the validation-as-data contract: `{ data: { error } }` is a `200` carrying a validation outcome and still resolves normally. Falsy-value unwrapping is preserved because the test is `"data" in envelope`, not truthiness. It remains status-code agnostic, so the `res.ok` check is still required and is now documented
- **h3 adapter now honors the global prefix fallback** (`src/h3/createMiddleware.ts:128`): `createRPCMiddleware` resolved its dispatch prefix as `rpcPrefix || defaultPrefix` while the other four adapters — and h3's own outer gate at line 88 — use `rpcPrefix || getGlobalPrefix() || defaultPrefix`. With a global prefix set and no explicit middleware option, h3 matched the prefix in the outer gate but then looked the function up in the `__rpc` map and returned 404. Fail-closed (a wrong prefix yields 404, never a cross-prefix dispatch), so this was an availability bug rather than an authorization bypass — but a real trap for multi-prefix setups on h3
- **SPA example enforces its body cap while streaming** (`examples/spa/body-limit.ts`): the middleware called `readBody` — fully buffering the request — and only then measured the result, so its 1 MB limit provided no protection against memory exhaustion, despite `wiki/security.md` prescribing enforcement *while streaming*. An unauthenticated client could stream an arbitrarily large body and the server would accumulate all of it before rejecting. The rewrite measures each chunk as it arrives, retains nothing past the cap, and drains-and-discards the remainder rather than closing on the spot — with a drain ceiling so the discard cannot become an unbounded slowloris. **The guarantee is a bounded memory footprint**: 5 MB, 20 MB, 50 MB and 60 MB uploads all peak at baseline heap (~9 MB) instead of buffering their payload. A clean `413` is delivered for moderately oversized requests by draining first; a client still streaming a very large body may see a connection reset instead, which is normal HTTP behavior — the primary win is that the payload is never resident

### Docs

- **`unwrapEnvelope` documentation corrected** (`CHANGELOG.md`, `llms.txt`, `wiki/client-usage.md`, `wiki/security.md`, `wiki/wire-protocol.md`): the 0.3.3 docs claimed the helper "re-throws `RPCError` on `{ error }` bodies" and shipped an example importing `RPCError` from `@thednp/rpc/helpers`, where it does not exist — that entry ships only `getClientStub`, `handleResponse`, `innerModule`, and `unwrapEnvelope`. The documented snippet degraded to `err instanceof undefined`, i.e. `TypeError: Right-hand side of 'instanceof' is not callable`, throwing a confusing `TypeError` precisely when handling a failure. `RPCError` is a **server-side** export (`@thednp/rpc/server`) and its `code`/`data` are stripped from production responses regardless; all docs now say so
- `wiki/security.md` — Koa-only "URL Normalization" section generalized to all adapters and the shared `safeURL()` helper, including why it must never throw; new `?args=` Must Be a JSON Array section; new "Native Clients: `unwrapEnvelope`" contract section; Origin Validation gains a "Residual Gaps" subsection covering the unconsulted `Sec-Fetch-Site` header (with a drop-in middleware snippet) and why top-level `GET` navigations bypass the check entirely; Content-Type Enforcement now states explicitly that a JSON-declared function does **not** accept form bodies — the leniency is one-directional, and the previous wording overstated it in both directions
- Fixed a broken anchor link to the `unwrapEnvelope` section in `wiki/wire-protocol.md`
- `AGENTS.md` — security posture section updated: `safeURL` normalization (all adapters), `?args=` array validation, one-directional content-type strictness, the shared client error contract, the streaming body-limit requirement, and a prefix-parity note to keep the five adapters in sync; threat-model table row corrected
- `llms.txt` — `unwrapEnvelope` contract, `400` added to the status-code list, content-type leniency direction

### Tests

- `unwrapEnvelope` gains coverage for the error contract: top-level `error` throws, non-string `error` stringifies, `{ data: { error } }` resolves (the validation-as-data regression guard), falsy `data` values (`false`/`0`/`""`) unwrap, and non-envelope objects pass through — **447 tests, 100% on all metrics**

### Chores

- Bump version to `0.3.4` (`package.json`, `deno.json`)

## [0.3.3] - 2026-09-15

### Features

- **Relaxed `JsonValue` constraint on `createServerFunction`** (`src/types.d.ts`, `src/createFunction.ts`): the generic `TResult` parameter of `ClientFunction`, `ServerFunction`, `ServerFunctionInit`, and `createServerFunction` no longer requires `extends JsonValue`. Only `getClientStub` and the internal `innerModule` retain the constraint for wire protocol safety. This eliminates double-casts and `LooseClientFunction` workarounds in wrapper libraries that define server functions with non-JSON return types
- **Hono header fallback in `getRequestMeta`** (`src/context.ts:218`): `getRequestMeta` now reads `req?.raw?.headers` as a fallback when `req?.headers` is undefined, matching Hono's internal request structure where native `Headers` live on `req.raw`. All other adapters pass headers via `req.headers` and are unaffected
- **`viteMiddleware` for Fastify** (`src/fastify/helpers.ts:40-68`): new `viteMiddleware(vite)` export returning an `onRequest` hook handler with `reply.hijack()` for streaming. Consistent with h3 and Hono's `viteMiddleware` — all three adapters now export a standalone middleware factory for custom Vite setups
- **`unwrapEnvelope<T>(json)` client helper** (`src/client-helpers.ts:44-55`, exported from `@thednp/rpc/helpers`): typed helper to unwrap `{ data }` wire protocol responses. For native HTTP clients or non-Vite toolchains that don't use the auto-generated fetch stubs. Added as a pure envelope accessor with no error handling — the fail-open error swallow and the accompanying documentation error were corrected in [0.3.4](#034---2026-09-26)
- **`silent` option on `loadRPCConfig` / `rpcPlugin`** (`src/config.ts:45`, `src/types.d.ts:239`, `src/index.ts:166`): new `silent?: boolean` suppresses the `NO_CONFIG_FOUND` warning. The plugin passes `devOptions.silent` through to `loadRPCConfig`, allowing wrapper plugins to define server functions directly without a config file

### Chores

- Bump version to `0.3.3` (`package.json`, `deno.json`)

## [0.3.2] - 2026-08-25

### Features

- **Adapter framework type re-exports** (`src/{express,fastify,h3,hono,koa}/types.d.ts`): each adapter now re-exports its framework's core types so consumers can annotate apps/handlers without a direct `express`/`fastify`/`h3`/`hono`/`koa` devDependency — `Express`/`ExpressRequest`/`ExpressResponse`/`ExpressNext` (`src/express/types.d.ts:84`), `Fastify`/`FastifyRequest`/`FastifyReply` (`src/fastify/types.d.ts:73`), `H3`/`H3Event`/`H3Middleware` (`src/h3/types.d.ts:44`), `Hono`/`HonoContext`/`HonoMiddlewareHandler` (`src/hono/types.d.ts:35`), `KoaContext`/`KoaNext` (`src/koa/types.d.ts:46`). Rebuilt `dist/*/*.d.mts` updated; no runtime change, pure type ergonomics

### Chores

- Bump version to `0.3.2` (`package.json`, `deno.json`)
- Dep bumps: `hono ^4.13.3` → `^4.13.4`, `@types/node ^26.2.0` → `^26.3.0`; `pnpm-workspace.yaml` adds `@types/node@26.3.0` to `minimumReleaseAgeExclude`
- `pnpm-lock.yaml` / `deno.lock` refreshed; `dist/*/*.d.mts.map` rebuilt

## [0.3.1] - 2026-08-21

### Breaking Changes

- **`defineConfig` moved to `@thednp/rpc/config`**: the config helper no longer ships from the main plugin entry. `@thednp/rpc` statically imports Vite (it *is* a Vite plugin), so any server-side file importing it — including a serverless function bundle that merely reads your `rpc.config.ts` — would emit a runtime `require("vite")` and crash at cold start on platforms where Vite isn't installed (Netlify: `Runtime.ImportModuleError: Cannot find module 'vite'` → 502). The new `/config` subpath has zero dependencies, making serverless deployments behave like any other Express server. Update one import line in `rpc.config.ts`: `import { defineConfig } from "@thednp/rpc/config"`. All examples and the demo updated; `tests/fixtures/*` configs now import from source to stay resolution-safe before publish
- **demo Netlify function hardened** (`demo/netlify/functions/rpc.ts`): URL rewrite reconstructs the path from `cfg.rpcPrefix` instead of a hardcoded `"/@demo/"`; `serverless-http` moved from devDependencies to dependencies (it is runtime code inside the function bundle)

### Added

- **Vite-free `defineConfig` module** (`src/config.ts`, built to `dist/config/config.mjs`): merges partial config over `defaultRPCOptions`, skipping explicitly `undefined` values so callers can't accidentally blank out defaults; zero runtime dependencies (type-only import erased at build)
- **`./config` subpath export**: wired into `package.json` exports and `deno.json` exports/imports maps; new tsdown build entry alongside the existing adapter/helper entries

### Removed

- **`ensurePrefixFromGlobal` deleted** (`src/functionsMap.ts`) together with its call sites across all five adapter `createMiddleware` files — the copy-from-default-prefix fallback is superseded by the explicit prefix bootstrap below; also removed dead commented `setGlobalPrefix` calls from the adapters and `src/index.ts`
- **Serverless prefix bootstrap made explicit**: `setGlobalPrefix(cfg.rpcPrefix)` at the top of `src/api/server.ts` replaces implicit framework magic — static-import hoisting guarantees it runs before any `createServerFunction`, regardless of import order in the host function bundle (`demo/src/api/server.ts`)

### Docs

- `wiki/adapters.md` **Serverless section rewritten** around two rules: (1) import `defineConfig` from `@thednp/rpc/config`, never the main entry, with the cold-start crash explained; (2) set the prefix at the top of `src/api/server.ts`; references the working [demo/netlify/functions/rpc.ts](../demo/netlify/functions/rpc.ts) and keeps `netlify.toml external_node_modules = ["vite"]` documented as a size optimization
- `wiki/configuration.md` — `defineConfig` section documents the `/config` subpath and why the main entry must never be imported server-side
- `README.md`, `wiki/quickstart.md`, `wiki/getting-started.md` — all `rpc.config.ts` snippets switched to `@thednp/rpc/config`
- `AGENTS.md` — h3 added to the adapter list and body-size-limits row (`bodyLimit`/`assertBodySize`); build output table gains `dist/config/config.mjs`
- `llms.txt` — config section notes the vite-free subpath and its serverless rationale

### Tests

- Fixtures (`tests/fixtures/*.config.ts`) import `defineConfig` from source instead of the main entry, keeping `loadRPCConfig` suites green before publish
- "load config from file" suite targets `examples/advanced/rpc.config.ts` (the `link:../..` example) so it resolves current source including the unpublished `./config` export
- New coverage: `defineConfig` skips explicitly `undefined` values back to defaults — **428 tests, 100% on all metrics**

### Fixed

- **Graceful scan without Vite** (`src/scanForServerFiles.ts`): the lazy `import("vite")` is now wrapped in try/catch — when Vite isn't installed (serverless bundles where it's externalized or absent), the scan exits silently instead of crashing the host cold start with `Runtime.ImportModuleError: Cannot find module 'vite'` → 502. Defense-in-depth for deployments whose function bundle doesn't import its server module directly; covered by a new suite that mocks Vite as missing (`tests/scan.test.ts`) — **429 tests, 100% on all metrics**
- **demo `rpc.config.ts` restored to `defineConfig`**: the plain-object workaround from the Netlify debugging session is retired — the config file now uses the documented `defineConfig({ rpcPrefix: "@demo" })` from `@thednp/rpc/config`, proving the vite-free subpath works end-to-end inside the live Netlify function bundle

## [0.3.0] - 2026-08-21

### Features

- **Multi-prefix support**: `createServerFunction` accepts a per-function `rpcPrefix` option (`{ rpcPrefix: "v1:rpc" }`) so multiple RPC instances can coexist in parallel — versioned APIs, namespaced endpoints, and API segregation without function-name collisions. The server functions map is now scoped by prefix (`getFunctionsForPrefix(prefix)`), the plugin generates client stubs per prefix (`getClientModules` reads only the requested prefix's map), and all five adapters (Express, Fastify, Hono, Koa, h3) look functions up in the prefix-scoped map instead of a single global map. Functions default to `"__rpc"` for full backward compatibility; the same registered name under different prefixes is no longer a duplicate, while same-prefix duplicates still throw in dev / warn in production
- **`getFunctionsForPrefix(prefix)`**: new exported server helper returning (and lazily creating) the `Map<name, ServerFnEntry>` for a given RPC prefix; `serverFunctionsMap` remains as the backward-compatible proxy for the default `"__rpc"` prefix
- **`defaultPrefix` constant**: the default `"__rpc"` prefix is now a named export from `@thednp/rpc/server`, used consistently across the scan, adapters, and function registration instead of a hardcoded string
- **Prefix charset widened**: `validatePathSegment` now permits `:` (and `@` in the first position) so versioned prefixes like `v1:rpc` / `v2:rpc` pass validation; `.` remains disallowed to keep path-traversal rejection (`foo..bar`, `foo/../bar`) intact
- **`getClientStub` helper** (`@thednp/rpc/helpers`): manual typed client stub factory for privileged prefixes not emitted in the public bundle — `getClientStub("admin:rpc","get-user")` (also curried `getClientStub("admin:rpc")("get-user")`) returns the same `{data,cancel}` shape as auto-generated stubs, with `method`/`credentials`/`contentType` options; code-splittable so `admin:rpc` literals never appear in the public chunk when `await import`-ed only inside `/admin` routes
- **Advanced example auth**: `examples/advanced` now has cookie-session auth (`HttpOnly; SameSite=Lax` `sid` via `Symbol.for("thednp.rpc.advanced.session")`), `public:rpc/login`/`logout`/`me`, `admin:rpc` guarded by `requireAdminSession` (403 without admin role), and SSR guard for `/admin` → `403` in `server.js` — demonstrates that `admin:rpc` isolation is not obscurity and that `getClientStub` must be used with real auth

### Fixes

- **Cross-bundle map sharing**: `serverFunctionsByPrefix` now on `globalThis[Symbol.for("thednp.rpc.functionsMap")]` (`src/functionsMap.ts:12`) like `requestContext` — plugin scan (`dist/index.mjs`) and adapter dispatch (`dist/express/*.mjs`) share one map instead of per-bundle copies (dev 404 fix)
- **Config fallback**: scan fallback `exportValue.options?.rpcPrefix || config.rpcPrefix || defaultPrefix` (`src/scanForServerFiles.ts:138`) and `ScanConfig.rpcPrefix` (`src/types.d.ts:217`) propagated from `vite.config.ts`/`rpc.config.ts` via `src/index.ts:193` and lazy `src/*/*createMiddleware.ts:107` — existing examples without per-function `rpcPrefix` now register under the config prefix instead of `__rpc`
- **Glob scan in prod**: `MiddlewareOptions.serverFiles/scanRoot` (`src/types.d.ts:333`) now forwarded to lazy `scanForServerFiles` in all five adapters, and `examples/advanced/server.js:25` `admin:rpc` mounts with `serverFiles:"glob"` — prod `preview` finds `*.server.ts` files instead of defaulting to `exact`
- **Client generation DRY**: `src/getClientModules.ts:47` now emits `getClientStub("prefix","name",{...})` via `src/client-helpers.ts:32` `makeStub` instead of duplicating `body`/`headers` per function

### Docs

- New `wiki/multi-prefix-guide.md` — parallel RPC instances: versioned/public/admin API layouts, per-prefix middleware wiring, canary deployments, origin validation per instance, and backward compatibility; added **Security: Do Not Trust the Prefix** section
- `wiki/security.md:92` **Multi-Prefix Client Isolation** — `getClientModules` virtual modules (`src/index.ts:221`), no disk files, only config prefix emitted, prefix is not a secret, must use `requireAdminSession`/`sendResponse(403)`
- `wiki/index.md` TOC + cross-links from `wiki/configuration.md` and `wiki/adapters.md` to the multi-prefix guide
- `AGENTS.md`, `llms.txt`, and `README.md` updated for the multi-prefix feature, `defaultPrefix` constant, `getClientStub`, and `dev:advanced`/`test:dev`/`test:prod` scripts
- `examples/advanced/README.md` rewritten for auth + multi-prefix demo

### Tests

- Multi-prefix coverage: `createServerFunction` registers under a custom prefix (isolated from the default map), `getClientModules` generates `getClientStub` stubs only for the requested prefix, and the scan registers functions under their declared prefix without name collision
- Adapter middleware tests updated to register functions in the prefix-scoped map for non-default prefixes
- `getClientStub` coverage: curried `getClientStub("admin:rpc")("get-user")` and direct `getClientStub("admin:rpc","get-user")` plus `GET`/`text/plain`/`urlencoded`/`multipart` branches (`tests/client-helpers.test.ts:198`)
- **100% coverage**: all metrics (statements, branches, functions, lines) at 100% — 427 tests

### Chores

- `pnpm test` now `vitest run --coverage`; new `pnpm test:watch` `vitest --watch --coverage`; `pnpm test:dev`/`test:prod` now `test:dev`/`test:prod` with colon; `pnpm clean` and `pnpm audit:src` documented; `scripts/update-examples.js:33` skips `advanced` (`link:../..`)

## [0.2.1] - 2026-08-10

### Features

- **`send` on the request context**: `RequestEvent.send(status, body, headers?)` (plus the `sent` flag) lets middleware and server functions short-circuit the RPC dispatch with a full HTTP response instead of the `{ data }` envelope, mirroring the existing `redirect`/`redirected` pair. All five adapters bind it and skip their JSON send when `sent` is set: Express (via `getResponseDetails().sendResponse`), Fastify (`reply.header()` loop + `reply.status().send()`), Koa (`ctx.set()` loop + `ctx.status`/`ctx.body`), Hono (records only — the post-dispatch handler returns `c.body(JSON.stringify(body), status, { "content-type": "application/json", ...headers })`), and h3 (records only — the post-dispatch handler sets `event.res.status` and `event.res.headers` then returns the body)
- **`functionName` on the request context**: `RequestEvent.functionName` exposes the dispatched function name so universal middleware can branch per function (e.g. rate limits, per-function authorization)
- **`sendResponse` helper**: a `sendResponse(status, body, headers?)` context helper, the response counterpart to the `redirect` helper, delegating to the same adapter-bound write path
- **`getRequestMeta(event)`**: a normalized request reader returning `{ method, pathname, search, searchParams, headers, host, ip, protocol }`, duck-typed across all five adapter request shapes — feature-detects fetch-like `Headers` (h3/Hono) vs plain maps (Express/Fastify/Koa), resolves the URL from `originalUrl ?? url ?? path`, and derives `host`/`protocol`/`ip` with safe fallbacks

### Examples

- **h3 example**: extract `middleware/bodyLimit.js` — delegates to h3's native `assertBodySize`, which swaps `event.req` for a bounded stream so the cap is enforced while streaming (never fully buffered) and the RPC `readBody` can still consume it afterwards; oversized bodies reject with `413` JSON. Extract `middleware/serveStatic.js` — aliases h3's `serveStatic` from `h3/node`, adds `Content-Length`, `Last-Modified`, and `Cache-Control: public, max-age=31536000, immutable`, and is registered **after** `createRPCMiddleware()` so asset requests never reach server functions; missing files fall through to the SSR handler
- **demo**: the prerender plugin now writes the app content between `<!-- app-content -->` markers and gains a `configurePreviewServer` middleware that re-renders just that region from the URL query — nojs form state (values + errors) is recovered in `vite preview`, where the baked `dist/index.html` shell otherwise skips `transformIndexHtml`
- **demo**: `body-limit.ts` stashes multipart bodies as `{ raw: body }` to mirror `@thednp/rpc/express`'s `readBody` streaming semantics; the render page and `getLibraryInfo` now count 9 examples and list the h3 adapter; the features grid grows to 9 cards (3×3) with request-context, no-JS form-fallback, and boundary-enforcement entries
- **fastify example**: switch the production server to `@fastify/compress` (gzip) for the RPC endpoint and static HTML. `@fastify/compress` attaches its per-route `onSend` hook via `onRoute`, which never fires for the RPC plugin's global `preHandler` handling, so the example registers a scoped `app.post("/_server/*")` catch-all route — the RPC `preHandler` short-circuits before the handler runs, letting compress's hook attach to RPC POSTs while non-RPC POSTs still get a 404. Verified with curl: HTML and RPC POST responses (200 and 404) compress (gzip) with byte-identical decompression (md5 match), and non-RPC POSTs keep their 404
- Sync all 9 examples to `@thednp/rpc ^0.2.0`
- **advanced example** (`examples/advanced`): Express SSR showcase of the multi-prefix model and universal middleware — the same `get-user` function name is registered under both `public:rpc` (rate-limited, 5 req/10s, returns public user data) and `admin:rpc` (guarded by a `x-admin-token` header check, returns full record), served by two `createRPCMiddleware` instances mounted in `server.js` while the client stubs are generated only for the config `public:rpc` prefix; a `middleware.ts` module (`rateLimit`, `auditLog`, `requireAdmin`) built on `getRequestContext`/`getRequestMeta`/`sendResponse` is shared across both prefixes. Dev mode mounts the admin middleware explicitly since the Vite plugin only auto-mounts the configured prefix; `scripts/dev-test.js` PREFIX_MAP includes `advanced: "public:rpc"` and the root `dev:advanced` script runs it

### Docs

- **New `wiki/middleware.md`** — universal adapter-agnostic middleware via the request context: the `locals` bridge table (Express `res.locals`, Koa `ctx.state`, h3 `event.context`, Fastify/Hono `{}` with `decorateRequest`/`c.set` workarounds), `getRequestMeta`, `functionName`, `sendResponse` per-adapter mapping, and wrap recipes for official framework middleware (Express session, Koa `ctx.state`, h3 `event.context`, Fastify `decorateRequest`, Hono `c.set`/`c.get`)
- TOC sweep: `- [Middleware](./middleware.md)` entry added to all 11 wiki pages after Server Functions; cross-linked from `server-functions.md` (RequestEvent shape + "Writing Universal Middleware" section), `best-practices.md` (Authentication, Rate Limiting), and `adapters.md`; `wiki/index.md` updated
- Update `wiki/server-functions.md` RequestEvent reference for `send`/`sent`/`functionName` and re-point its "Next" pointer to `middleware.md`
- `wiki/nojs-fallback.md`: explain the form markup and detection rule without embedding the whole `createFormFallback` implementation (now links to `demo/src/lib/form-fallback.ts`)
- `wiki/adapters.md`: replace the h3 body-limit snippet with h3's native `assertBodySize` pattern (bounded stream, never buffered) and add a **Static Assets** section for the extracted `serveStatic` middleware; `wiki/best-practices.md` h3 body limit now recommends `assertBodySize` and warns against iterating `event.req` (which breaks the RPC `readBody` with "Body is unusable")
- Update `AGENTS.md` (9 examples, h3 adapter, test files table), `llms.txt`, and `README.md` (five adapters, 10 test files, `nojs-fallback` doc link, `pmpm` → `pnpm` typo) for the new adapter, examples, and context API
- Example READMEs: add the `wiki/middleware.md` resource link to all 9 example READMEs; rewrite `examples/solid-query/README.md` (was a copy-paste of the react-query README — now describes Solid's `createQuery`/`createMutation`, `renderToStringAsync` SSR, and the disabled-query gotcha); expand the h3 example README's production flow for the extracted `bodyLimit`/`serveStatic` middleware

### Tests

- **100% coverage across all adapters**: 1001/1001 statements, 608/608 branches, 155/155 functions, 981/981 lines (412 tests)
- Add `send` short-circuit tests to the Express, Fastify, and Koa suites — both with headers (asserting the `headers` loop) and without (covering the `if (headers)` false branch that had dropped branch coverage below 100%)
- Add `tests/context.test.ts` suite: `sendResponse` delegation (with/without headers, outside-request throw), `getRequestMeta` normalization (Express-style, fetch-like `Headers`, `ip`/`protocol` derivation, bare request, plain-map headers, array-valued header, URL protocol fallback), and `functionName` passthrough
- Adapter suites assert `functionName` exposure via `getRequestContext()` and `send` short-circuits the JSON dispatch on all five adapters
- Add `?args=` non-array rejection tests (400 Bad Request) and bare-GET (no `?args=`) dispatch tests to all five adapter suites — **100/100% coverage, 412 tests**

### Security

- **`safeURL` defensive URL parsing**: `getRequestDetails()` and every adapter's inline `new URL(rawUrl, ...)` call now parse through `safeURL` (`src/server-helpers.ts`), which never throws — a malformed request-target like `/\` or `//` used to trigger an unhandled `TypeError: Invalid URL` rejection outside the dispatch `try` block and **crash raw `node:http` hosts** (and Express 4). Malformed URLs now fall back to a safe root pathname that never matches the RPC prefix, so the request degrades to `next()`/404 instead of crashing the process (High)
- **GET `?args=` is now validated as a JSON array**: a non-array value (e.g. `?args={"a":1}`) previously spread into `handler(...args)` and threw a confusing `TypeError: object is not iterable` 500; all five adapters now reject it with `400 { error: "Bad Request" }` before dispatch
- **`wiki/security.md` enumeration claim corrected**: the "prevents function enumeration" wording was overstated — the status code still distinguishes unknown (`404`) from known (`405`/`415`/`403`) functions. Documented that enumeration is mitigated against *message* disclosure only; function names ship in the client bundle so they are not secret. `AGENTS.md` and `llms.txt` updated to match
- Full source security audit recorded in `SECURITY-AUDIT.md` (High crash finding fixed; remaining findings are LOW/INFO/design notes)

### Chores

- Bump version to `0.2.1` (package.json + deno.json)
- Add `@thednp/rpc@0.2.0` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`

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
