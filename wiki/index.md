# @thednp/rpc

A Vite plugin for creating server functions with automatic Remote Procedure Calls (RPC) generation. Server functions are defined in a dedicated file, auto-scanned, and transformed into client-side fetch modules — no manual API route setup required.

## Features

- File-level server code isolation without directives like `'use server'`
- System-wide configuration via `rpc.config.ts`
- Automatic RPC generation for server functions
- `AbortController` support for request cancellation
- Adapters for Express, Fastify, Hono, and Koa with unified API
- Framework-agnostic core
- TypeScript support
- Path-segment prefix matching prevents URL boundary bypass
- @tanstack/react-query integration for client-side caching and invalidation

## Table of Contents

- [Getting Started](getting-started.md) — Installation and quick start
- [Setup Guide](setup.md) — Project structure and configuration
- [Configuration](configuration.md) — Configuration reference
- [Server Functions](server-functions.md) — Creating server functions
- [Client Usage](client-usage.md) — Client-side usage
- [Adapters](adapters.md) — Framework adapters
- [Security](security.md) — Security hardening
- [Best Practices](best-practices.md) — Tips and best practices
