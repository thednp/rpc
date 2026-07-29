# Changelog

## [0.0.2] - 2026-07-29

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

### Fixes

- Publish workflow: remove `--provenance`, fix AGENTS.md express command, fix Koa adapter docs
- README GitHub URLs: `rpcv` → `rpc`
- Proper pnpm workspace setup for StackBlitz
- StackBlitz compatibility for examples
- Remove `prepare` script to prevent rolldown native binding error on StackBlitz

### Docs

- Expand Authentication section in best-practices with Basic Authorization + Per-Function Authorization examples
- Add CONTRIBUTING section to README
- Update all wiki docs to use `rpcPrefix`
- Clarify isomorphic nature of server functions in wiki
- Add README.md to each example
- Use full wiki URLs in example READMEs

### Chores

- Create CHANGELOG.md
- Update `dist/` with latest builds
- Update examples dependencies
- Bump version to `0.0.2`

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
