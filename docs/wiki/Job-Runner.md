# Job Runner & Orchestration

[[Home]] · related: [[Pipeline]] · [[Providers]] · [[Credits]]

All async work (image, animation, render) is a `provider_jobs` row driven by **one** runner and applied through **one** writer.

## `provider_jobs` (the async spine)
`id, project_id, kind[image|animation|render], provider, external_id, status[pending|processing|completed|failed], attempts, idempotency_key (UNIQUE), payload/result jsonb, claimed_at, claimed_by, lease_expires_at`.

Idempotency keys: image = `project_id:attempt`, animation = **`clip_id:attempt`** (clip-composer — a frame may back multiple clips so `frame_id` is no longer unique per job), render = `render:<project_id>:<render_attempt>`.

## Unified runner (`apps/api/src/modules/jobs/runner.ts`)
- Started on boot in `server.ts` when `RUNNER_ENABLED=true` (checked `=== 'true'`, **not `'1'`** — see [[Gotchas]]). Dev manual tick: `POST /internal/runner/tick` behind `RUNNER_DEV_TICK_ROUTE`.
- `claimNextJob`: atomic `UPDATE ... WHERE id = (SELECT id ... ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)` + lease stamp. **`FOR UPDATE SKIP LOCKED` must come after `LIMIT`** (Postgres). Date params via `.toISOString()` (postgres-js+Bun). Both in [[Gotchas]].
- `executeJob` per kind:
  - **image** → ImageProvider.generate → store frames → `apply`
  - **animation** → HeyGen `submit` → record `external_id`, release lease → `deferred` (webhook/reconciler resolves)
  - **render** → RenderProvider.render → store output → `apply`
  - submission 429/5xx → `retry` (stays claimable, no refund, backoff within attempts cap)

## `applyJobResult` — the single writer
`apps/api/src/modules/jobs/apply-job-result.ts` is the **only** function that applies a job result to FSM + child rows (frames/clips/renders) + credit settlement, in one row-locked transaction.
- **Idempotent**: re-applying the same result is a no-op.
- **Attempt-aware**: drops a webhook/result for a superseded / already-terminal / retried attempt.
- **Clip-keyed (clip-composer)**: animation results are keyed by `payload.clipId` — not `frameId`. A frame may back several clips; each clip's job carries `{ clipId, frameId, frameRef, audio }` in its payload and settles independently. The ledger hold is placed and settled per-clip, so partial failure refunds only the failed clips' holds.
- **Settle-based** `clips_ready` (`transition-policy.ts`): advance once every clip is SETTLED (completed **or** terminally failed), not only when all N succeed — `clips_ready` if ≥1 clip succeeded, `failed` if all failed. `siblingStats` aggregates outstanding/failed/completed counts over the N-clip set (not a hard 4).
- On animation completion the clip mp4 is **re-hosted to R2** (`persistClip` → storage key, re-signed on read) by the runner-poll / reconciler / webhook paths alike — never persist a provider/presigned URL ([[Gotchas]] #14, [[Storage]]).
- **Render idempotency key is `render:<projectId>:<renderAttempt>`** — the `render:` prefix is mandatory: an unprefixed `pid:N` collides with the image job's key (table-wide UNIQUE) and the render job is never created ([[Gotchas]] #15).

Both the **webhook receiver** (`webhook-routes.ts`) and the **reconciler** call `applyJobResult` exclusively — neither writes FSM/ledger directly.

## Reconciler (`reconciler.ts`)
Polls jobs stuck in `processing` past `RECONCILE_STALE_MS` (default 30 s) and sweeps jobs past `RECONCILE_MAX_AGE_MS` (default 30 min) → `failed` + refund. This is the safety net so a missed HeyGen webhook never strands a project, and it works in local dev with no public tunnel.

## Concurrency
Designed for **N runner instances**: `FOR UPDATE SKIP LOCKED` + a lease (`claimed_at`/`claimed_by`/`lease_expires_at`) with stale-claim reclaim. (True multi-instance concurrency tests are env-gated on a real Postgres.)
