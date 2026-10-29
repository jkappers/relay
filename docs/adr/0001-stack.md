# ADR 0001: Stack

Status: accepted (M1)

## Decision

TypeScript on Node 24, run directly with tsx. pnpm workspaces. One server process and one worker process. Postgres holds both data and the queue.

## Runtime dependencies

| Package | Version | Why |
|---|---|---|
| `hono` | 4.13 | Small web framework on the Web `Request`/`Response` API. `c.req.text()` gives the raw body for HMAC checks. |
| `@hono/node-server` | 2.1 | Runs Hono on Node's HTTP server. |
| `@hono/zod-validator` | 0.9 | Validates query and body input with zod schemas on routes. |
| `zod` | 4.6 | Validates env config, provider payloads, the envelope, and API responses. |
| `drizzle-orm` | 0.45 | Typed SQL and schema. Its transactions can carry pg-boss sends. |
| `postgres` | 3.4 | postgres.js driver used by Drizzle. |
| `pg-boss` | 12.38 | Postgres-backed job queue. `send` can join a Drizzle transaction through `fromDrizzle`, so an event insert and its job commit together. |
| `libsodium-wrappers` | 0.8 | `crypto_secretbox` (XSalsa20-Poly1305) for tokens and secrets at rest. Ships its own types. |

## Dev dependencies

| Package | Version | Why |
|---|---|---|
| `typescript` | 7.0 | Type checking (`tsc --noEmit`). Nothing is compiled to JS. |
| `tsx` | 4.23 | Runs TypeScript directly (`node --import tsx`). |
| `vitest` | 5.0 | Test runner. |
| `drizzle-kit` | 0.31 | Generates migrations from the schema and checks them. Migrations come only from here. |
| `@types/node` | 24 | Node types. |

`@types/libsodium-wrappers` is not needed, because the package ships its own types.

## Transitive peers that pnpm installs automatically

- `@opentelemetry/api`: a required peer of `pg-boss` 12. It's imported at load time.
- `vite`: a required peer of `vitest` 5.
- `pg`: a dependency of `pg-boss`. pg-boss keeps its own connection pool.

## Not used

- `@slack/*` SDKs. Plain `fetch` covers the one OAuth call.
- A metrics library. `packages/core/src/metrics.ts` is a small counter registry that prints Prometheus text.
