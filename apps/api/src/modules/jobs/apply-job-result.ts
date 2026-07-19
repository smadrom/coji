/**
 * applyJobResult — the SINGLE writer of provider-job-driven FSM transitions,
 * child-row updates, and credit-ledger settlement (P0.6).
 *
 * Both the runner (after executing a provider) and, later, the webhook receiver
 * + reconciler (P3) call ONLY this function to apply a result. It is:
 *   - transactional: child rows + ledger + credits_spent + FSM move in one tx;
 *   - idempotent: re-applying the same result is a no-op (decision + UNIQUE
 *     (provider_job_id, kind) ledger index);
 *   - attempt-aware: a result for a superseded/already-terminal attempt is
 *     dropped, never applied to the current attempt (see ./apply-decision.ts).
 *
 * Pure branching lives in ./apply-decision.ts and ./transition-policy.ts and is
 * unit-tested without a DB; this file is the thin DB-bound orchestration and is
 * exercised by the DB-gated integration test (./apply-job-result.db.test.ts).
 */
import { and, eq } from 'drizzle-orm';
import { clips, creditLedger, frames, projects, providerJobs, renders } from '../../db/tables.ts';
import { convertHoldToDebit, refundHold } from '../credits/ledger.ts';
import type { Stage } from '../credits/types.ts';
import { type ProjectState, assertTransition } from '../projects/fsm.ts';
import { type IncomingResult, decideApplication } from './apply-decision.ts';
import { resolveProjectTransition } from './transition-policy.ts';

/** Result payload applied to a job (what the provider/webhook produced). */
export interface ApplyResult {
  status: 'completed' | 'failed';
  /** image: storage keys + captions per frame; animation: a clip URL; render: output URL. */
  frames?: { idx: number; imageRef: string; caption: string }[];
  clipVideoUrl?: string;
  /** Real clip length in seconds (animation), recorded on the clip row. */
  clipDurationSeconds?: number;
  /** HeyGen video id for the clip (animation), recorded on the clip row. */
  heygenVideoId?: string;
  renderOutputUrl?: string;
  /** Attempt the producer ran (optional cross-check for superseded drops). */
  attempt?: number;
  failureMessage?: string;
}

/** Outcome of an applyJobResult call. */
export interface ApplyOutcome {
  action: 'applied' | 'noop' | 'dropped';
  reason?: string;
  projectTransition?: ProjectState | null;
}

/** Any drizzle transaction/db handle. */
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];
export type DbLike = {
  // biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's tx (its generics are version-fragile)
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

const STAGE_BY_KIND: Record<'image' | 'animation' | 'render', Stage> = {
  image: 'image',
  animation: 'animation',
  render: 'render',
};

/**
 * Apply `result` to the job identified by `jobId`. `db` is the drizzle client.
 */
export async function applyJobResult(
  db: DbLike,
  jobId: string,
  result: ApplyResult,
): Promise<ApplyOutcome> {
  return db.transaction(async (tx: Tx) => {
    // Lock the job row for the duration of the tx.
    const jobRows = await tx
      .select()
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId))
      .for('update')
      .limit(1);
    const job = jobRows[0];
    if (!job) return { action: 'dropped', reason: 'job not found' };

    const incoming: IncomingResult = {
      jobId,
      status: result.status,
      attempt: result.attempt,
    };
    const decision = decideApplication(
      { id: job.id, status: job.status, attempts: job.attempts },
      incoming,
    );
    if (decision.action !== 'apply') {
      return { action: decision.action === 'noop' ? 'noop' : 'dropped', reason: decision.reason };
    }

    const kind = job.kind as 'image' | 'animation' | 'render';
    const stage = STAGE_BY_KIND[kind];

    // 1) Mark the job terminal.
    await tx
      .update(providerJobs)
      .set({
        status: result.status,
        result: result as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(providerJobs.id, jobId));

    // 2) Apply child-row updates by kind.
    if (kind === 'image' && result.status === 'completed' && result.frames) {
      for (const f of result.frames) {
        await tx
          .update(frames)
          .set({ imageRef: f.imageRef, caption: f.caption, status: 'completed' })
          .where(and(eq(frames.projectId, job.projectId), eq(frames.idx, f.idx)));
      }
    } else if (kind === 'image' && result.status === 'failed') {
      await tx.update(frames).set({ status: 'failed' }).where(eq(frames.projectId, job.projectId));
    } else if (kind === 'animation') {
      // One animation job per CLIP (clip-composer / WS4). The job payload carries
      // the target clipId — the canonical settlement key — so a result updates
      // exactly the right clip even when several clips reuse one frame (keying by
      // frameId here would clobber EVERY clip sharing that frame). Legacy
      // pre-migration jobs carry only frameId (1 clip per frame, so unambiguous):
      // fall back to frameId for those so in-flight legacy jobs still settle.
      const clipId = typeof job.payload?.clipId === 'string' ? job.payload.clipId : undefined;
      const frameId = typeof job.payload?.frameId === 'string' ? job.payload.frameId : undefined;
      const clipPredicate = clipId
        ? eq(clips.id, clipId)
        : frameId
          ? eq(clips.frameId, frameId)
          : undefined;
      if (clipPredicate) {
        await tx
          .update(clips)
          .set({
            status: result.status,
            videoUrl: result.status === 'completed' ? (result.clipVideoUrl ?? null) : null,
            durationSeconds:
              result.status === 'completed' ? (result.clipDurationSeconds ?? null) : null,
            heygenVideoId: result.heygenVideoId ?? job.externalId ?? null,
          })
          .where(clipPredicate);
      }
    } else if (kind === 'render') {
      await tx
        .update(renders)
        .set({
          status: result.status,
          outputUrl: result.status === 'completed' ? (result.renderOutputUrl ?? null) : null,
        })
        .where(eq(renders.projectId, job.projectId));
    }

    // 3) Settle the credit hold (idempotent via UNIQUE (provider_job_id, kind)).
    const project = (
      await tx.select().from(projects).where(eq(projects.id, job.projectId)).limit(1)
    )[0];
    if (project) {
      if (result.status === 'completed') {
        await convertHoldToDebit(tx, {
          userId: project.userId,
          projectId: job.projectId,
          stage,
          jobId,
        });
      } else {
        await refundHold(tx, {
          userId: project.userId,
          projectId: job.projectId,
          stage,
          jobId,
        });
      }
    }

    // 4) Compute + apply the project FSM transition (guarded).
    let projectTransition: ProjectState | null = null;
    if (project) {
      const siblings = await siblingStats(tx, job.projectId, kind, jobId);
      projectTransition = resolveProjectTransition({
        kind,
        result: result.status,
        outstandingSiblings: siblings.outstanding,
        failedSiblings: siblings.failed,
        completedSiblings: siblings.completed,
      });
      if (projectTransition && projectTransition !== project.status) {
        assertTransition(project.status as ProjectState, projectTransition);
        await tx
          .update(projects)
          .set({ status: projectTransition, updatedAt: new Date() })
          .where(eq(projects.id, job.projectId));
      }
    }

    return { action: 'applied', projectTransition };
  });
}

/**
 * Aggregate the stage's jobs (the just-applied one included — its status was
 * updated earlier in this tx) into outstanding/failed counts that drive the FSM.
 *
 * For `animation` the stage has one logical job PER CLIP (clip-composer / WS4),
 * and a clip may be retried (a new attempt row). A stale `failed` attempt that
 * has since been superseded by a newer attempt must NOT count — so we collapse
 * animation jobs to the LATEST attempt per CLIP (keyed by payload.clipId) before
 * counting. This is what lets `clips_ready` count each clip once even when
 * several clips reuse one frame. Legacy pre-migration jobs carry only frameId
 * (1 clip per frame); they collapse by frameId, which is unambiguous for them.
 * image/render have a single job per attempt, so no collapsing is needed.
 */
async function siblingStats(
  tx: Tx,
  projectId: string,
  kind: 'image' | 'animation' | 'render',
  _selfJobId: string,
): Promise<{ outstanding: number; failed: number; completed: number }> {
  const rows = (await tx
    .select({
      status: providerJobs.status,
      attempts: providerJobs.attempts,
      payload: providerJobs.payload,
    })
    .from(providerJobs)
    .where(and(eq(providerJobs.projectId, projectId), eq(providerJobs.kind, kind)))) as {
    status: string;
    attempts: number;
    payload: Record<string, unknown> | null;
  }[];

  // Collapse animation rows to the latest attempt per clip (key = payload.clipId,
  // falling back to payload.frameId for legacy pre-migration rows).
  let effective = rows;
  if (kind === 'animation') {
    const latestByClip = new Map<string, { status: string; attempts: number }>();
    for (const r of rows) {
      const key =
        (typeof r.payload?.clipId === 'string' ? r.payload.clipId : undefined) ??
        (typeof r.payload?.frameId === 'string' ? r.payload.frameId : undefined);
      if (!key) continue;
      const prev = latestByClip.get(key);
      if (!prev || r.attempts > prev.attempts) {
        latestByClip.set(key, { status: r.status, attempts: r.attempts });
      }
    }
    effective = [...latestByClip.values()].map((v) => ({
      status: v.status,
      attempts: v.attempts,
      payload: null,
    }));
  }

  let outstanding = 0;
  let failed = 0;
  let completed = 0;
  for (const r of effective) {
    if (r.status === 'failed') failed += 1;
    else if (r.status === 'completed') completed += 1;
    else outstanding += 1;
  }
  return { outstanding, failed, completed };
}
