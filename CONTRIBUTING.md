# Contributing to coji

Thanks for helping improve coji. Bug fixes, documentation, tests, provider
integrations, and focused feature proposals are welcome.

## Before you start

- Search existing issues before opening a new one.
- For a substantial change, open an issue first so the design and provider cost
  implications can be discussed before implementation.
- Never include API keys, customer media, account data, or private deployment
  details in an issue, test fixture, commit, or pull request.
- Security vulnerabilities must follow [`SECURITY.md`](SECURITY.md).

## Local setup

Follow the [README quick start](README.md#quick-start). The default Noop
providers are deterministic and free. Tests and examples must not require paid
provider calls.

Before submitting a pull request, run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run lint
bun run build
```

Database-backed tests require `TEST_DATABASE_URL` or `DATABASE_URL`. Browser
tests and their isolated Docker stack are documented in the README.

## Architecture constraints

Please preserve these invariants:

1. Keep the literal Elysia `.use()` chain and `export type App = typeof app` in
   `apps/api/src/app.ts` so the Eden type spine remains intact.
2. Put API features in `apps/api/src/modules/<feature>/` and use TypeBox schemas
   as the route and MCP source of truth.
3. Put paid services behind a provider interface with a Noop or local fake.
4. Apply provider-job results through `applyJobResult`; do not write parallel
   state-transition paths.
5. Use `bun:test`, not Vitest or Jest.

More context is in [`AGENTS.md`](AGENTS.md) and
[`docs/wiki/Architecture.md`](docs/wiki/Architecture.md).

## Pull requests

- Keep the change focused and explain the user-visible result.
- Add or update tests for behavior changes.
- Update `.env.example` and docs when configuration changes.
- Include migrations for schema changes; do not edit an already published
  migration.
- Call out skipped checks and any provider behavior that was not tested live.
- Use plain commit messages with no generated attribution trailer.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
