import type { Providers } from '@coji/shared/providers';
import type { Storyboard } from '@coji/shared/storyboard';
import { getStylePreset } from '@coji/shared/style';
/**
 * Unified job runner (P0.6).
 *
 * One logical runner role, runnable as N horizontally-scaled instances. Each
 * instance:
 *   1. claims one `provider_jobs` row with `SELECT ... FOR UPDATE SKIP LOCKED`
 *      (so instances never grab the same row), stamping claimed_at/claimed_by
 *      and lease_expires_at = now + LEASE_TTL;
 *   2. a non-terminal row whose lease has expired is reclaimable (stale-claim
 *      reclaim) — covered by the same claim predicate;
 *   3. executes the relevant provider for the job kind;
 *   4. calls applyJobResult (the single writer) with the outcome.
 *
 * The claim is a single atomic `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 * SKIP LOCKED)` so the read-lock-and-stamp is race-free across instances.
 * Pure lease math lives in ./lease.ts (unit-tested without a DB).
 */
import { type SQL, sql } from 'drizzle-orm';
import { env } from '../../env.ts';
import { HeyGenRetryableError } from '../../providers/heygen.ts';
import { makeOpenRouterShotPlanner } from '../../providers/openrouter.ts';
import { planShots } from '../projects/shot-planner.ts';
import { type ApplyResult, type DbLike, applyJobResult } from './apply-job-result.ts';
import { persistClip } from './clip-storage.ts';
import { leaseExpiry } from './lease.ts';

/**
 * Outcome of executing a claimed job:
 *   - a terminal ApplyResult (image/render, or an animation that failed/resolved
 *     synchronously) → runOnce applies it;
 *   - `{ deferred }` (animation submit accepted) → runOnce records the external
 *     id and leaves the job `processing` for the webhook/reconciler to resolve;
 *   - `{ retry }` (animation submission throttled: HeyGen 429/5xx) → the job
 *     stays claimable, NO refund, retried with backoff within the attempts cap.
 */
export type ExecuteOutcome =
  | { kind: 'apply'; result: ApplyResult }
  | { kind: 'deferred'; externalId: string }
  | { kind: 'retry'; reason: string };

export interface RunnerOptions {
  instanceId: string;
  leaseTtlMs: number;
  /** Provider bundle (Noop fakes in CI/dev). */
  providers: Providers;
}

export interface ClaimedJob {
  id: string;
  projectId: string;
  kind: 'image' | 'animation' | 'render';
  provider: string;
  externalId: string | null;
  attempts: number;
  payload: Record<string, unknown>;
}

/** A db handle that supports both raw execute and the transaction used by applyJobResult. */
export type RunnerDb = DbLike & {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * Atomically claim the next runnable job. Returns the claimed row or null when
 * nothing is available. Claims rows that are:
 *   - non-terminal (status in pending|processing), AND
 *   - unclaimed OR lease-expired (stale reclaim),
 * skipping rows another instance currently holds (`FOR UPDATE SKIP LOCKED`).
 */
export async function claimNextJob(
  db: RunnerDb,
  opts: { instanceId: string; leaseTtlMs: number; now?: Date },
): Promise<ClaimedJob | null> {
  const now = opts.now ?? new Date();
  const newLease = leaseExpiry(now, opts.leaseTtlMs);

  const result = await db.execute(sql`
    UPDATE provider_jobs
    SET claimed_at = ${now.toISOString()},
        claimed_by = ${opts.instanceId},
        lease_expires_at = ${newLease.toISOString()},
        status = 'processing',
        attempts = attempts + CASE WHEN status = 'pending' THEN 0 ELSE 0 END,
        updated_at = ${now.toISOString()}
    WHERE id = (
      SELECT id FROM provider_jobs
      WHERE status IN ('pending', 'processing')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${now.toISOString()})
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, project_id, kind, provider, external_id, attempts, payload
  `);

  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as unknown[];
  const row = rows[0] as
    | {
        id: string;
        project_id: string;
        kind: 'image' | 'animation' | 'render';
        provider: string;
        external_id: string | null;
        attempts: number;
        payload: Record<string, unknown>;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    provider: row.provider,
    externalId: row.external_id,
    attempts: row.attempts,
    payload: row.payload ?? {},
  };
}

/**
 * Execute a claimed job against its provider. Returns an ExecuteOutcome:
 *   - image/render → terminal ApplyResult (applied immediately);
 *   - animation → SUBMIT to the provider (deferred): record the external id and
 *     leave the job processing for the webhook/reconciler. A submission throttle
 *     (HeyGen 429/5xx, surfaced as HeyGenRetryableError) → `retry` (no refund).
 *
 * Uses the Noop providers + local-fs storage by default, so the full pipeline
 * runs with zero external calls. The Noop animation provider's submit returns
 * an external id immediately (and its fetchResult resolves completed), so the
 * deferred path still converges in tests via the reconciler/webhook.
 */
export async function executeJob(job: ClaimedJob, providers: Providers): Promise<ExecuteOutcome> {
  switch (job.kind) {
    case 'image': {
      const basePrompt = String(job.payload.prompt ?? '');
      const script = job.payload.script != null ? String(job.payload.script) : null;
      const storyboard =
        job.payload.storyboard && typeof job.payload.storyboard === 'object'
          ? (job.payload.storyboard as Storyboard)
          : undefined;
      // Style preamble (avatars-voices phase): prepend the style's appearance
      // cue so the generated person matches the chosen style. Unknown/absent
      // style → no preamble (prompt drives the look, as before).
      const stylePreset =
        job.payload.style != null ? getStylePreset(String(job.payload.style)) : undefined;
      const prompt = stylePreset ? `${stylePreset.imagePreamble}. ${basePrompt}` : basePrompt;
      // Storyboard → per-frame prompts (distinct camera angles) + short labels.
      // The LLM planner (when a chat key is set AND the assistant is on) adapts
      // each shot's action to the prompt/script; otherwise preset defaults.
      const planner = env.openrouterApiKey
        ? makeOpenRouterShotPlanner({
            apiKey: env.openrouterApiKey,
            model: env.openrouterChatModel,
          })
        : undefined;
      const planned = await planShots(prompt, { storyboard, script, planner });
      const generated = await providers.image.generate(prompt, {
        seed: job.projectId,
        shotPrompts: planned.map((p) => p.prompt),
        shotLabels: planned.map((p) => p.label),
        model: job.payload.imageModel ? String(job.payload.imageModel) : undefined,
      });
      const stored: { idx: number; imageRef: string; caption: string }[] = [];
      for (const g of generated) {
        const key = `projects/${job.projectId}/frames/${g.idx}`;
        await providers.storage.put(key, g.bytes, g.contentType);
        stored.push({ idx: g.idx, imageRef: key, caption: g.caption });
      }
      return {
        kind: 'apply',
        result: { status: 'completed', frames: stored, attempt: job.attempts },
      };
    }

    case 'animation': {
      // If not yet submitted, submit now (non-terminal). The frame ref + audio
      // come from the job payload (set at enqueue). 429/5xx → retry (no refund).
      if (!job.externalId) {
        const frameRef = String(job.payload.frameRef ?? '');
        const audio = job.payload.audio as
          | { mode: 'tts'; script: string; voiceId: string }
          | { mode: 'audio_url'; audioUrl: string };
        try {
          const { externalId } = await providers.animation.submit({
            frameRef,
            audio,
            callbackId: job.id, // encodes provider_jobs.id for the webhook
          });
          return { kind: 'deferred', externalId };
        } catch (err) {
          if (err instanceof HeyGenRetryableError) {
            return { kind: 'retry', reason: err.message };
          }
          throw err; // terminal → caught by runOnce → applied as failed (refund)
        }
      }
      // Already submitted: this claim is a poll (reconciler path).
      const res = await providers.animation.fetchResult(job.externalId);
      if (res.status === 'completed' && res.videoUrl) {
        // Re-host the provider clip to OUR storage and persist the KEY (durable,
        // re-signed on read) — same as the reconciler/webhook path, so a clip is
        // never stored as a short-lived provider/presigned URL.
        const clipKey = await persistClip(
          providers,
          `projects/${job.projectId}/clips/${job.id}.mp4`,
          res.videoUrl,
        );
        return {
          kind: 'apply',
          result: {
            status: 'completed',
            clipVideoUrl: clipKey,
            clipDurationSeconds: res.durationSeconds,
            heygenVideoId: res.externalId,
            attempt: job.attempts,
          },
        };
      }
      if (res.status === 'failed') {
        return {
          kind: 'apply',
          result: { status: 'failed', failureMessage: res.failureMessage, attempt: job.attempts },
        };
      }
      // Still processing remotely — leave it for the next poll/webhook.
      return { kind: 'retry', reason: 'animation still processing' };
    }

    case 'render': {
      const composition = (job.payload.composition as never) ?? { clips: [] };
      const out = await providers.render.render(composition);
      const key = `projects/${job.projectId}/renders/${job.attempts}`;
      await providers.storage.put(key, out.bytes, out.contentType);
      // Persist the durable storage KEY (NOT a short-lived signed/absolute URL),
      // mirroring how clips store a key (ADR-5 / Gotcha #14). getProjectRender
      // re-signs it FRESH to a same-origin /files URL on read so the done screen
      // can play the final cut inline (cross-origin <video> is blocked by Brave).
      return {
        kind: 'apply',
        result: { status: 'completed', renderOutputUrl: key, attempt: job.attempts },
      };
    }
  }
}

/**
 * Claim + execute one job, then settle according to the execute outcome:
 *   - apply    → applyJobResult (terminal: image/render, or a polled animation);
 *   - deferred → record the provider external id, leave the job `processing` for
 *                the webhook/reconciler (animation submit accepted);
 *   - retry    → release the claim (clear the lease) so the job is re-claimable
 *                with backoff, NO refund (submission throttle / still processing).
 * A thrown (terminal) provider error is applied as a failed result so the hold
 * is refunded — it never escapes the runner loop. Returns the job id, or null
 * when the queue was empty.
 */
export async function runOnce(db: RunnerDb, opts: RunnerOptions): Promise<string | null> {
  const job = await claimNextJob(db, {
    instanceId: opts.instanceId,
    leaseTtlMs: opts.leaseTtlMs,
  });
  if (!job) return null;

  let outcome: ExecuteOutcome;
  try {
    outcome = await executeJob(job, opts.providers);
  } catch (err) {
    outcome = {
      kind: 'apply',
      result: {
        status: 'failed',
        failureMessage: err instanceof Error ? err.message : String(err),
        attempt: job.attempts,
      },
    };
  }

  if (outcome.kind === 'apply') {
    await applyJobResult(db, job.id, outcome.result);
  } else if (outcome.kind === 'deferred') {
    // Record the external id; release the lease so the reconciler can poll it
    // later, but keep it `processing` (awaiting webhook).
    await db.execute(sql`
      UPDATE provider_jobs
      SET external_id = ${outcome.externalId}, lease_expires_at = NULL, claimed_by = NULL, updated_at = ${new Date().toISOString()}
      WHERE id = ${job.id}
    `);
  } else {
    // retry: release the claim so it is re-claimable with backoff. No refund.
    await db.execute(sql`
      UPDATE provider_jobs
      SET lease_expires_at = NULL, claimed_by = NULL, updated_at = ${new Date().toISOString()}
      WHERE id = ${job.id}
    `);
  }
  return job.id;
}
