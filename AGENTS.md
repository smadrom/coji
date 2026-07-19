# AGENTS.md — coji

Guidance for coding agents (Codex, Claude, Gemini, etc.) working in this repo.
This mirrors **[[CLAUDE.md]]**; the full knowledge base lives in **[[docs/wiki/Home]]**.

---

## What this is

`coji` — an AI video-generation SaaS. Pipeline:

> **prompt → 4 images (Gemini/OpenRouter) → preview gate → compose N talking-video clips (HeyGen) → editor → export**

Each prompt = a **Project** (UUID + PostgreSQL). See [[docs/wiki/Pipeline]].

## Stack

- **Bun** runtime (not Node), **Elysia** API (`apps/api`), **React + Vite** web (`apps/web`), `packages/shared` (TypeBox + Eden client + provider seams), **Drizzle + PostgreSQL**.
- Monorepo workspaces: `apps/*`, `packages/*`.

## Build / test / lint (use Bun)

```bash
bun install
bun run typecheck      # all typed @coji workspaces
bun run test           # bun:test scoped to apps/packages — NOT vitest
bun run lint           # biome
bun run db:migrate     # drizzle-kit
```

Web typecheck needs `NODE_OPTIONS=--max-old-space-size=4096` (Eden deep instantiation) — already in the script.

## Conventions (must follow)

1. Keep the **Eden type spine**: literal `.use()` chain in `apps/api/src/app.ts`, `export type App = typeof app`. See [[docs/wiki/Architecture]].
2. Feature modules: `apps/api/src/modules/<feature>/{schema,service,routes,...}.ts`. TypeBox schema is the single source for routes + MCP.
3. New external integrations go behind a **provider seam** in `packages/shared/src/providers` with a Noop/local fake. CI must stay free of paid calls. See [[docs/wiki/Providers]].
4. All provider-job-driven state changes go through **`applyJobResult`** only. See [[docs/wiki/Job-Runner]].
5. Tests use `bun:test`. DB-backed tests are gated on `TEST_DATABASE_URL`/`DATABASE_URL` and skipped without a Postgres (CI-deferred).

## Footguns (learned the hard way) — read [[docs/wiki/Gotchas]]

- Bun nests some workspace devDeps → Docker images must `bun install` **in the build/runtime stage**, not copy only root `node_modules`.
- Better Auth handler: mount with `.all('/api/auth/*', ({request}) => auth.handler(request))`, **not** `.mount('/api/auth', ...)` (mount strips the prefix → 404).
- Postgres `FOR UPDATE SKIP LOCKED` must come **after** `LIMIT`.
- postgres-js under Bun can't bind a `Date` in raw `sql\`\`` — use `.toISOString()`.
- `RUNNER_ENABLED` is checked `=== 'true'` (not `'1'`).
- `PAYMENTS_PROVIDER=noop` throws in `NODE_ENV=production` (by design).
- `BETTER_AUTH_URL` must equal the public origin or the browser gets **"Invalid origin"**.
- `stage_prices` must be seeded or paid stages 500.

## Git

Plain commit messages, no AI-attribution trailer. See [[CLAUDE.md]] for more.
