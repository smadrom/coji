# Open-source release readiness

## Current status — 2026-07-19

The MIT-licensed source snapshot was published at
`https://github.com/smadrom/coji` on 2026-07-19. The default branch has a clean
root history, the legacy remote branches were deleted, and GitHub Actions passed
on the published tree. The former smoke-test credential must still be treated as
exposed until its account is rotated or deleted.

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
- Replaced `main` with an approved clean root commit authored as
  `smadrom <sn.one.dev@gmail.com>`.
- Made the ffmpeg argv test harness executable on both Windows and POSIX so the
  public CI test suite runs consistently.
- Deleted the two legacy remote feature branches; GitHub has only the clean
  `main` branch and no tags, releases, pull requests, or forks at publication.
- Changed repository visibility to public and enabled secret scanning, push
  protection, Dependabot security updates, vulnerability alerts, and private
  vulnerability reporting.
- Deleted 40 Actions runs tied to the removed private history, including their
  logs and artifacts; only runs from the clean `main` graph remain.
- Protected `main` with strict `verify` and `e2e` checks, linear history,
  conversation resolution, and force-push/branch-deletion prevention.

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
| GitHub Actions CI | PASS: verify plus Docker/Playwright e2e, run `29676158163` |
| GitHub Actions history | PASS: no run remains from outside the clean `main` graph |
| GitHub remote refs | PASS: only clean `refs/heads/main` remains |
| Anonymous repository access | PASS: public repository returned HTTP 200 |
| `main` branch protection | PASS: strict `verify` + `e2e`, linear history, no force-push/deletion |
| Local Docker Compose config/build and Playwright e2e | SKIPPED: Docker is unavailable on this host |
| DB-backed integration suites | SKIPPED: no test PostgreSQL URL was supplied |

`bun audit` without a severity threshold still reports one moderate and one low
esbuild advisory through the development-only legacy
`drizzle-kit → @esbuild-kit/esm-loader` path. The installed runtime/build paths
use fixed esbuild versions. Keep tracking the advisory and remove the exception
when Drizzle Kit drops the legacy loader.

The web production build succeeds with a warning that its main JavaScript chunk
is about 560 kB before gzip. This is a performance follow-up, not a release
correctness failure.

## Post-publication security and acceptance follow-ups

1. **Rotate or delete the old smoke-test account.** Treat its previous password
   as exposed even though it is absent from the published source snapshot.
2. **Request cached sensitive-data cleanup from GitHub Support if needed.** The
   old branch refs are deleted, but ref deletion alone does not guarantee
   immediate removal of cached views or dangling Git objects.
3. **Run production Compose acceptance.** The isolated Docker/Playwright CI
   stack passes; production configuration still needs an environment-specific
   `docker compose ... config` and deployment smoke test.
4. **Run DB-backed tests** against a disposable PostgreSQL database.
5. **Review commercial terms.** Coji code is MIT, but Remotion 4.0.491 uses a
   custom license and external providers have separate terms. See
   `THIRD_PARTY_NOTICES.md`.

## Next steps

1. Rotate the exposed smoke credential.
2. Request GitHub cached-data cleanup if the old commit objects remain
   accessible after credential rotation.
3. Run the remaining production Compose and database acceptance checks.
4. Move the changelog's `Unreleased` entries to `0.3.0`, create the `v0.3.0`
   tag, and publish GitHub release notes.

The repository was changed to `PUBLIC` through GitHub CLI on 2026-07-19 and was
confirmed anonymously with HTTP 200. At publication, the remote contained only
the clean `main` branch. Automatic deletion of merged branches and public
security analysis are enabled. Legacy Actions logs were removed and `main` is
protected by the required CI checks.
