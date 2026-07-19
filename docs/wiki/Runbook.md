# Runbook

[[Home]] · related: [[Deployment]] · [[Credits]] · [[Auth]]

## Local development

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
bun run db:migrate
bun run db:seed:dev
bun run dev
```

`db:seed:dev` is idempotent, local-only by default, and creates stage prices plus
development credits. Never run it against production.

## Verification

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

Database-backed suites run when `TEST_DATABASE_URL` or `DATABASE_URL` points to
a PostgreSQL database; otherwise they are reported as skipped.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Session secret; a non-development value is required in production |
| `BETTER_AUTH_URL` | Exact public browser origin |
| `RUNNER_ENABLED` | `true` starts the background provider-job runner |
| `IMAGE_PROVIDER` | `noop`, `gemini`, or `openrouter` |
| `ANIMATION_PROVIDER` | `noop` or `heygen` |
| `RENDER_PROVIDER` | `noop`, `ffmpeg`, or `remotion-local` |
| `STORAGE_PROVIDER` | `local-fs` or `s3` |
| `PAYMENTS_PROVIDER` | `noop` for development, `stripe` for production |
| `GEMINI_API_KEY` | Native Gemini image provider |
| `OPENROUTER_*` | OpenRouter key, models, and public attribution |
| `HEYGEN_*` | HeyGen key, webhook secret, and output resolution |
| `S3_*` | S3/R2/MinIO endpoint, bucket, and credentials |
| `STRIPE_API_KEY` / `PAYMENTS_WEBHOOK_SECRET` | Stripe checkout and webhook verification |
| `RECONCILE_*` | Stale-job reconciliation timing |

See `.env.example` for the complete list and safe development defaults.

## First production database

1. Run `bun run db:migrate`.
2. Seed `stage_prices` with the intended production credit amounts.
3. Configure Stripe or use an administrative process to fund accounts.
4. Confirm `RUNNER_ENABLED=true` before enabling real providers.

Example price seed:

```sql
INSERT INTO stage_prices (stage, unit, credits, notes) VALUES
  ('image', 'per_set', 10, 'production'),
  ('animation', 'per_clip', 20, 'production'),
  ('render', 'per_export', 30, 'production')
ON CONFLICT (stage, unit) DO UPDATE SET credits = EXCLUDED.credits;
```

## Smoke test

```bash
BASE_URL=http://localhost:3001
curl "$BASE_URL/health"
curl "$BASE_URL/openapi/json" > /dev/null
```

For a deployed instance, use its public origin and create a dedicated smoke-test
account through the normal sign-up flow. Store credentials in a secret manager,
rotate them regularly, and never commit them to this runbook.

## Operations

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 100 api
docker compose -f docker-compose.prod.yml exec db pg_isready
```

Common startup failures:

- `Invalid origin`: `BETTER_AUTH_URL` does not exactly match the browser origin.
- Jobs stay pending: `RUNNER_ENABLED` is not the string `true`.
- Paid stages return 500: `stage_prices` has not been seeded.
- Production boot rejects payments: Stripe configuration is missing and the
  Noop provider is intentionally barred.
