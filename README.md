# coji

[![CI](https://github.com/smadrom/coji/actions/workflows/ci.yml/badge.svg)](https://github.com/smadrom/coji/actions/workflows/ci.yml)

Coji is a self-hostable AI video-generation application. It turns a prompt or
storyboard into four reusable visual frames, lets the user review them and
compose any number of spoken clips, then exports a vertical video.

```text
prompt → 4 images → review → compose N clips → talking video → timeline → MP4
```

The project is pre-1.0. Interfaces and migrations may still change between
minor versions.

## What is included

- A React/Vite web app with gallery, storyboard input, clip composer, timeline,
  silence trimming, and 9:16 export.
- A Bun/Elysia API with end-to-end Eden types, OpenAPI, authentication, credits,
  billing, and an asynchronous provider-job runner.
- Provider seams for image generation, animation, rendering, storage, and
  payments. Free deterministic providers are the default, so local development
  and CI do not call paid APIs.
- Real integrations for Gemini, OpenRouter, HeyGen, S3-compatible storage,
  Stripe, ffmpeg, and local Remotion rendering.
- PostgreSQL migrations, Docker images, a production-like Playwright stack, and
  unit/integration tests using `bun:test`.

## Stack

| Area | Technology |
|---|---|
| Runtime and API | Bun 1.3, Elysia, TypeScript |
| Web | React 19, Vite, Remotion Player |
| Data | PostgreSQL, Drizzle ORM |
| Testing | `bun:test`, Playwright |
| Tooling | Biome, Docker Compose |

## Quick start

Requirements: [Bun](https://bun.sh/) 1.3.x and a PostgreSQL 16 instance. Docker
is optional but is the easiest way to start PostgreSQL.

```bash
git clone https://github.com/smadrom/coji.git
cd coji
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
bun run db:migrate
bun run db:seed:dev
bun run dev
```

Open <http://localhost:5173>, create an account, and use the Noop providers to
exercise the pipeline without external API keys. `db:seed:dev` only accepts a
localhost database by default; it creates development prices and credits and
must not be used in production.

The web app runs on port 5173 and proxies API requests to port 3001. OpenAPI is
available at <http://localhost:3001/openapi>.

## Configuration

Copy [`.env.example`](.env.example) and keep real values in `.env`, which is
ignored by Git. The safe defaults are:

```dotenv
IMAGE_PROVIDER=noop
ANIMATION_PROVIDER=noop
RENDER_PROVIDER=noop
STORAGE_PROVIDER=local-fs
PAYMENTS_PROVIDER=noop
```

Real providers are opt-in. Never expose provider secrets through a `VITE_*`
variable: those values are compiled into the public browser bundle. See
[`docs/wiki/Providers.md`](docs/wiki/Providers.md) and
[`docs/docker.md`](docs/docker.md) for provider and deployment configuration.

## Development

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

Database-backed tests run when `TEST_DATABASE_URL` or `DATABASE_URL` points to a
test PostgreSQL database; otherwise they are skipped. The browser suite uses an
isolated Docker Compose project:

```bash
docker compose -p coji-e2e -f docker-compose.e2e.yml up -d --build
bun run e2e/health-wait.ts
bun run test:e2e
docker compose -p coji-e2e -f docker-compose.e2e.yml down -v
```

Architecture constraints and known footguns are documented in
[`AGENTS.md`](AGENTS.md) and [`docs/wiki/Home.md`](docs/wiki/Home.md).
The remaining publication gates are tracked in
[`docs/OPEN_SOURCE_RELEASE.md`](docs/OPEN_SOURCE_RELEASE.md).

## Contributing and security

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Please
report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md),
not in a public issue. Project conduct expectations are in
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

Coji's own code is licensed under the [MIT License](LICENSE). Dependencies and
external services may use different terms; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), especially before enabling
Remotion or paid providers in a commercial deployment.
