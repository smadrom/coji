import type { Providers } from '@coji/shared/providers';
/**
 * Animation reconciler (P3 / task #18).
 *
 * The safety net for the webhook fast-path. Two passes, both routed EXCLUSIVELY
 * through applyJobResult (never writing FSM/ledger directly):
 *   1. poll: for animation jobs stuck in `processing` with an external_id past
 *      RECONCILE_STALE_MS, GET the provider status; on terminal completed/failed,
 *      persist the clip (completed) + applyJobResult. Covers missed webhooks and
 *      is the only path that works in local/dev without a public tunnel.
 *   2. max-age sweep: animation jobs older than RECONCILE_MAX_AGE_MS that never
 *      reached terminal are swept to `failed` via applyJobResult (refunding the
 *      hold), so a project never strands in `animating`/`processing`.
 *
 * Idempotent: applyJobResult drops duplicate/superseded results, so a webhook
 * and the reconciler racing on the same job converge to one settlement.
 */
import { sql } from 'drizzle-orm';
import { type DbLike, applyJobResult } from './apply-job-result.ts';
import { persistClip } from './clip-storage.ts';
import type { RunnerDb } from './runner.ts';

export interface ReconcileOptions {
  providers: Providers;
  staleMs: number;
  maxAgeMs: number;
  now?: Date;
}

/** Run one reconciliation pass. Returns counts for observability/tests. */
export async function reconcileOnce(
  db: RunnerDb,
  opts: ReconcileOptions,
): Promise<{ polled: number; completed: number; failed: number; swept: number }> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - opts.staleMs);
  const maxAgeBefore = new Date(now.getTime() - opts.maxAgeMs);
  let polled = 0;
  let completed = 0;
  let failed = 0;
  let swept = 0;

  // --- Pass 1: poll stuck-processing animation jobs with an external id -----
  const stuck = (await db.execute(sql`
    SELECT id, project_id, external_id
    FROM provider_jobs
    WHERE kind = 'animation'
      AND status = 'processing'
      AND external_id IS NOT NULL
      AND updated_at <= ${staleBefore.toISOString()}
    ORDER BY updated_at ASC
    LIMIT 50
  `)) as unknown;
  const stuckRows = (
    Array.isArray(stuck) ? stuck : ((stuck as { rows?: unknown[] })?.rows ?? [])
  ) as {
    id: string;
    project_id: string;
    external_id: string | null;
  }[];

  for (const row of stuckRows) {
    if (!row.external_id) continue;
    polled += 1;
    const res = await opts.providers.animation.fetchResult(row.external_id);
    if (res.status === 'completed' && res.videoUrl) {
      const videoUrl = await persistClip(
        opts.providers,
        `projects/${row.project_id}/clips/${row.id}.mp4`,
        res.videoUrl,
      );
      await applyJobResult(db as unknown as DbLike, row.id, {
        status: 'completed',
        clipVideoUrl: videoUrl,
        clipDurationSeconds: res.durationSeconds,
        heygenVideoId: res.externalId,
      });
      completed += 1;
    } else if (res.status === 'failed') {
      await applyJobResult(db as unknown as DbLike, row.id, {
        status: 'failed',
        failureMessage: res.failureMessage,
      });
      failed += 1;
    }
    // else still processing — leave for the next pass.
  }

  // --- Pass 2: max-age sweep → failed (refund) -----------------------------
  const old = (await db.execute(sql`
    SELECT id, project_id, external_id
    FROM provider_jobs
    WHERE kind = 'animation'
      AND status IN ('pending', 'processing')
      AND created_at <= ${maxAgeBefore.toISOString()}
    ORDER BY created_at ASC
    LIMIT 50
  `)) as unknown;
  const oldRows = (Array.isArray(old) ? old : ((old as { rows?: unknown[] })?.rows ?? [])) as {
    id: string;
  }[];
  for (const row of oldRows) {
    await applyJobResult(db as unknown as DbLike, row.id, {
      status: 'failed',
      failureMessage: 'reconciler: job exceeded max age',
    });
    swept += 1;
  }

  return { polled, completed, failed, swept };
}
