# Docker

Coji includes a database-only development compose file, a hot-reload stack, a
production-oriented stack, and an isolated browser-test stack.

| File | Purpose |
|---|---|
| `docker-compose.yml` | PostgreSQL only; use with native Bun processes |
| `docker-compose.dev.yml` | PostgreSQL + hot-reload API + Vite web |
| `docker-compose.prod.yml` | PostgreSQL + migration gate + API + nginx web |
| `docker-compose.e2e.yml` | Isolated Noop stack for Playwright |

## Configuration boundary

`VITE_*` values are build-time browser configuration and are public. Never put
an API key or other secret in a `VITE_*` variable. API secrets are runtime-only
environment variables on the `api` service.

`VITE_API_URL` defaults to `/api`, which nginx proxies to the API on the same
origin. Set an absolute public URL only for a deliberately split-origin deploy.

## Development stack

```bash
docker compose -f docker-compose.dev.yml up --build
```

This exposes PostgreSQL on 5432, the API on 3001, and Vite on 5173. Source is
bind-mounted, while anonymous volumes keep container dependencies separate from
host `node_modules`.

For a faster native workflow, use the database-only file and run Bun on the
host:

```bash
docker compose up -d postgres
bun run db:migrate
bun run db:seed:dev
bun run dev
```

## Production stack

Create a private `.env` with at least:

```dotenv
POSTGRES_PASSWORD=<strong-random-value>
BETTER_AUTH_SECRET=<strong-random-value>
BETTER_AUTH_URL=https://coji.example.com
STRIPE_API_KEY=<stripe-secret-key>
PAYMENTS_WEBHOOK_SECRET=<stripe-webhook-secret>
PAYMENTS_SUCCESS_URL=https://coji.example.com/billing?status=success
PAYMENTS_CANCEL_URL=https://coji.example.com/billing?status=cancel
```

Then validate and start:

```bash
docker compose --env-file .env -f docker-compose.prod.yml config
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

The stack fails fast when required auth, database, or Stripe settings are
missing. Noop payments are intentionally rejected with `NODE_ENV=production`.
The job runner defaults to enabled in this stack.

Provider and storage variables are listed in `.env.example`. The local storage
default is persisted in `coji-storage-prod`; use `STORAGE_PROVIDER=s3` for shared
storage across API instances.

## Images

- The API image installs dependencies with the complete workspace manifest
  graph and includes ffmpeg, source, and Drizzle migrations.
- The web image builds the Vite bundle and serves it with nginx, including SPA
  history fallback and `/api`, `/health`, and `/files` proxy routes.
- API and web images include health checks.
- `.dockerignore` excludes Git metadata, local environment files, dependencies,
  storage, logs, agent state, and release artifacts.

## Browser tests

```bash
docker compose -p coji-e2e -f docker-compose.e2e.yml up -d --build
bun run e2e/health-wait.ts
bun run test:e2e
docker compose -p coji-e2e -f docker-compose.e2e.yml down -v
```

The explicit project name keeps its PostgreSQL and media volumes isolated from
development and production data.
