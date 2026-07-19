# CLAUDE.md — coji

> AI video-generation SaaS. **Prompt → 4 images → preview gate → compose N talking-video clips → editor → export.**
> Each prompt is a **Project** (UUID, PostgreSQL). Built on Bun + Elysia + TypeScript + React/Vite.

This file is the entry point for AI agents. Full knowledge base: **[[docs/wiki/Home]]**.

---

## Quick facts

| | |
|---|---|
| Runtime | **Bun** (1.3.x) — not Node |
| API | **Elysia** + TypeScript (`apps/api`) |
| Web | **React + Vite** (`apps/web`) |
| Shared | `packages/shared` (TypeBox schemas, provider seams, Eden client) |
| DB | **Drizzle ORM + PostgreSQL** |
| Types | One **Eden type spine** — `export type App = typeof app` via a literal `.use()` chain (never `reduce`) |
| Docs/MCP | One Elysia route def → OpenAPI **and** MCP tools |

## Commands (always Bun)

```bash
bun install
bun run typecheck      # all typed @coji workspaces
bun run test           # DB-backed suites skip without TEST_DATABASE_URL/DATABASE_URL
bun run lint           # biome
bun run db:migrate     # drizzle-kit (needs DATABASE_URL)
bun run dev            # api + web
```

## Hard rules (do not break)

1. **Eden type spine**: mount routes on the literal `.use()` chain in `apps/api/src/app.ts`; keep `export type App = typeof app`. Never `reduce` the chain.
2. **Module convention**: `apps/api/src/modules/<feature>/{schema,service,routes,...}.ts`. TypeBox schema = single source for routes + MCP.
3. **Provider seams**: every paid API sits behind an interface in `packages/shared/src/providers` with a **Noop/local fake** as the CI default — **CI never calls a paid API**. See [[docs/wiki/Providers]].
4. **One writer**: `applyJobResult` is the *only* function that applies a provider-job result to FSM + child rows + credit ledger. See [[docs/wiki/Job-Runner]].
5. **Credits before paid work**: place a **hold** before each paid stage; convert to **debit** on success, **refund** on failure. Idempotent. See [[docs/wiki/Credits]].
6. **Raw SQL under Bun**: postgres-js under Bun rejects `Date` params in raw `sql\`\`` — pass `.toISOString()`. See [[docs/wiki/Gotchas]].

## Where things are

- Pipeline & FSM → [[docs/wiki/Pipeline]]
- Providers (Gemini / OpenRouter / HeyGen / Remotion / S3) → [[docs/wiki/Providers]]
- Job runner & orchestration → [[docs/wiki/Job-Runner]]
- Credits & billing → [[docs/wiki/Credits]]
- Auth (Better Auth) → [[docs/wiki/Auth]]
- Storage & signed file URLs → [[docs/wiki/Storage]]
- Self-hosted deployment → [[docs/wiki/Deployment]]
- Runbook (env, run, smoke) → [[docs/wiki/Runbook]]
- Bugs found & fixed → [[docs/wiki/Gotchas]]
- Open follow-ups → [[docs/wiki/Follow-ups]]

## Git / commits

- Plain commit messages, **no AI co-authorship trailer**.
- Branch off `main` for non-trivial work; commit/push only when asked.
