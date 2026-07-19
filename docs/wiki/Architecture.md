# Architecture

[[Home]] · related: [[Pipeline]] · [[Providers]] · [[Job-Runner]]

## Monorepo (Bun workspaces)

```
coji/
├── apps/
│   ├── api/          @coji/api  — Elysia + TypeScript (the server)
│   └── web/          @coji/web  — React + Vite (the SPA)
├── packages/
│   ├── shared/       @coji/shared — TypeBox schemas, provider seams, Eden client
│   └── render-spike/ isolated Remotion render workspace (excluded from default build)
├── docker-compose*.yml, apps/*/Dockerfile
└── docs/wiki/        ← this knowledge base
```

## Eden type spine (load-bearing)

`apps/api/src/app.ts` builds the app as a **literal `.use()` chain** and exports `export type App = typeof app`. `@coji/shared` wraps it with the Eden treaty client so the web gets end-to-end types with no codegen.

- **Never** build the chain with `reduce` / dynamic composition — it widens the type and breaks the spine.
- `server.ts` is the runtime entry (starts the listener + the [[Job-Runner|runner]]); `app.ts` has no `.listen()` so `app.handle()` tests never spawn a server or a runner.

## Module convention

```
apps/api/src/modules/<feature>/
  schema.ts    TypeBox — single source for routes + MCP tool generation
  service.ts   business logic behind a port interface (DB impl + in-memory fake)
  routes.ts    Elysia routes mounted on the spine
  *.test.ts    bun:test (app.handle integration + unit)
```

Feature modules in play: `projects` (incl. image/preview/animation/render stages), `jobs` (runner, applyJobResult, reconciler, webhook), `credits`, `billing`, `auth`, `files`, `mcp`.

## OpenAPI + MCP from one definition

TypeBox route schemas feed both `/openapi` and the in-house MCP plugin (`modules/mcp`). Only **GET** routes with `detail.mcp:true` become MCP tools; `^/api/auth`, `/api/me`, `/internal`, webhooks are deny-listed.

## Data model (Drizzle, `apps/api/src/db`)

`projects` → `frames` (0–3) → `clips` (1 per frame) → `renders`; plus `provider_jobs` (the async spine), `stage_prices` + `credit_ledger` ([[Credits]]), and Better Auth tables ([[Auth]]).

See [[Pipeline]] for the lifecycle FSM and [[Job-Runner]] for how async work is executed.
