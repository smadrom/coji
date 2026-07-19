# Open-source release readiness

## Current status — 2026-07-19

The current working tree has been prepared as an MIT-licensed public source
snapshot. The default branch is being replaced with a clean root commit, but
the GitHub repository must remain private until the remaining legacy refs and
the previously published test credentials are handled.

## Completed

- Added the MIT license, package metadata, changelog, third-party notices,
  contribution guide, code of conduct, security policy, CODEOWNERS, and GitHub
  issue/pull-request templates.
- Reworked README, self-hosting docs, environment examples, and the project wiki
  for a new contributor rather than a private deployment operator.
- Removed private infrastructure details, a committed test-account password,
  internal agent plans/handoffs, runtime locks, and the stale internal QA report
  from the current snapshot.
- Ignored local task/business notes, dashboard output, deployment archives, and
  agent runtime state so they cannot be added accidentally.
- Replaced the hard-coded OpenRouter test origin with configurable public
  attribution variables.
- Added an idempotent localhost-only `db:seed:dev` onboarding command.
- Hardened CI permissions/concurrency/timeouts and made high/critical dependency
  advisories blocking.
- Updated direct dependencies, including Drizzle ORM, Google Gen AI, Remotion,
  AWS SDK, Better Auth, and Elysia. Known high-severity advisories are resolved.
- Fixed the root test command so Playwright specs are not loaded by `bun:test`.
- Made root build/typecheck filters cover every typed `@coji/*` workspace.

## Verification

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | PASS |
| `bun run lint` | PASS, 176 files |
| `bun run typecheck` | PASS: API, web, shared, render-spike |
| `bun run test` | PASS: 448 passed, 49 DB-gated skipped, 0 failed |
| `bun run build` | PASS: API, web, shared |
| `bun audit --audit-level=high` | PASS |
| Current releasable-file secret pattern scan | PASS, no high-confidence matches |
| Compose-file YAML parse | PASS for all four files |
| Docker Compose config/build and Playwright e2e | SKIPPED: Docker is unavailable on this host |
| DB-backed integration suites | SKIPPED: no test PostgreSQL URL was supplied |

`bun audit` without a severity threshold still reports one moderate and one low
esbuild advisory through the development-only legacy
`drizzle-kit → @esbuild-kit/esm-loader` path. The installed runtime/build paths
use fixed esbuild versions. Keep tracking the advisory and remove the exception
when Drizzle Kit drops the legacy loader.

The web production build succeeds with a warning that its main JavaScript chunk
is about 560 kB before gzip. This is a performance follow-up, not a release
correctness failure.

## Open gates before changing visibility

1. **Rotate or delete the old smoke-test account.** Treat its previous password
   as exposed even though it is absent from the clean source snapshot.
2. **Remove or rewrite all remaining legacy remote refs.** The clean root commit
   replaces `main`, but two private feature branches still retain the old graph,
   including internal host details and the former smoke credential. Do not make
   the repository public until those refs and any associated pull-request refs
   have been reviewed. GitHub Support may be needed to purge cached sensitive
   data after the credential has been rotated.
3. **Run Docker acceptance.** Validate `docker compose ... config`, build both
   images, run the isolated Playwright stack, and tear it down with `down -v`.
4. **Run DB-backed tests** against a disposable PostgreSQL database.
5. **Configure GitHub while still private:** enable private vulnerability
   reporting, secret scanning/push protection where available, branch protection
   for `main`, required CI checks, and automatic deletion of merged branches.
6. **Review commercial terms.** Coji code is MIT, but Remotion 4.0.491 uses a
   custom license and external providers have separate terms. See
   `THIRD_PARTY_NOTICES.md`.

## Suggested publication sequence

1. Rotate the exposed smoke credential.
2. Verify the clean `main` root commit and its CI run while the repository is
   private.
3. Remove or rewrite the two legacy remote feature branches and review any
   associated pull-request refs.
4. Run the remaining Docker and database acceptance checks.
5. Enable repository security and branch-protection settings.
6. Change visibility to public.
7. Move the changelog's `Unreleased` entries to `0.3.0`, create the `v0.3.0`
   tag, and publish GitHub release notes.

The repository was confirmed as `PRIVATE` through GitHub CLI on 2026-07-19.
The maintainer approved replacing `main` with a clean root commit. Repository
visibility was not changed.
