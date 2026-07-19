/**
 * Image-generation stage wiring (P1 / task #14).
 *
 * The async entry into the pipeline. `enqueueImageGeneration` does NOT call any
 * provider inline — it only:
 *   1. asserts the caller owns the project and it is in `draft`;
 *   2. prices the image stage (bounded `per_set` from stage_prices);
 *   3. pre-flight balance check (owner balance ≥ price) — reject before any hold;
 *   4. in ONE transaction: create the 4 frame rows (pending), create a
 *      provider_jobs(kind=image, idempotency_key=projectId+':'+attempt) row, and
 *      place the image credit HOLD tied to that job;
 *   5. returns 202 with the project still in `draft` (job pending).
 *
 * The unified runner (modules/jobs) later claims the job, runs the image
 * provider, stores frames, and calls applyJobResult → on all-4 success the hold
 * becomes a debit and the FSM moves draft→images_ready; on any failure the whole
 * hold is refunded (image stage is all-or-nothing per plan M5).
 *
 * Idempotent: a second call while an image job for the current attempt is still
 * open is a no-op (returns the existing job), so a double-submit never
 * double-charges or double-enqueues.
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { frames, projects, providerJobs } from '../../db/tables.ts';
import { env } from '../../env.ts';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import { balance, placeHold } from '../credits/ledger.ts';
import { stageHoldCredits } from '../credits/stage-prices.ts';
import { signedUrlFor } from '../files/signed-url.ts';
import type { FrameProgressDto } from './schema.ts';
import type { ImageStagePort } from './service.ts';
import { ProjectNotFoundError } from './service.ts';

export const IMAGE_FRAME_COUNT = 4;

export class InsufficientCreditsError extends Error {
  readonly status = 402;
  constructor(required: number, available: number) {
    super(`Insufficient credits: need ${required}, have ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export class InvalidStateError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

export interface EnqueueImageResult {
  jobId: string;
  status: 'enqueued' | 'already_enqueued';
}

/** Build the per-attempt idempotency key for an image job. */
export function imageIdempotencyKey(projectId: string, attempt: number): string {
  return `${projectId}:${attempt}`;
}

/**
 * Enqueue async image generation for a project the caller owns.
 *
 * @param db drizzle client (transaction is opened internally)
 * @param imageProviderName the configured IMAGE_PROVIDER (recorded on the job)
 */
export async function enqueueImageGeneration(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; imageProviderName: string },
): Promise<EnqueueImageResult> {
  const { caller, projectId } = args;

  // Load + ownership-guard the project (outside the tx is fine; re-checked in tx).
  const existing = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = existing[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  if (project.status !== 'draft') {
    throw new InvalidStateError(
      `generate-images requires project in 'draft', but it is '${project.status}'`,
    );
  }

  // Idempotency: if an open image job already exists for the current attempt,
  // return it rather than enqueuing/charging again.
  const attempt = 0; // first set; retries (P2) bump this via a separate path
  const key = imageIdempotencyKey(projectId, attempt);
  const dup = await db
    .select({ id: providerJobs.id, status: providerJobs.status })
    .from(providerJobs)
    .where(eq(providerJobs.idempotencyKey, key))
    .limit(1);
  if (dup[0]) {
    return { jobId: dup[0].id, status: 'already_enqueued' };
  }

  return db.transaction(async (tx: AnyDb) => {
    // Price the stage (bounded per_set) and pre-flight the owner's balance.
    const price = await stageHoldCredits(tx, 'image', 1);
    const available = await balance(tx, project.userId);
    if (available < price) {
      throw new InsufficientCreditsError(price, available);
    }

    // Create the 4 frame rows (idempotent on the unique (project_id, idx)).
    await tx
      .insert(frames)
      .values(
        Array.from({ length: IMAGE_FRAME_COUNT }, (_, idx) => ({
          projectId,
          idx,
          status: 'pending' as const,
        })),
      )
      .onConflictDoNothing();

    // Create the provider job (kind=image). payload carries the prompt the
    // runner feeds to the image provider.
    const [job] = await tx
      .insert(providerJobs)
      .values({
        projectId,
        kind: 'image',
        provider: args.imageProviderName,
        status: 'pending',
        attempts: attempt,
        idempotencyKey: key,
        // script (VO) lets the shot planner adapt each shot's action to the
        // spoken line; storyboard drives the per-frame shot presets/camera;
        // style prepends an appearance preamble so the person matches the style.
        // imageModel carries the resolved quality-mode model so the runner
        // passes it as a per-call override to the image provider.
        payload: {
          prompt: project.prompt,
          script: project.script ?? null,
          storyboard: project.shotConfig ?? null,
          style: project.style ?? null,
          imageModel:
            project.quality === 'draft'
              ? env.openrouterImageModelDraft || env.openrouterImageModel || null
              : env.openrouterImageModelMax || env.openrouterImageModel || null,
        },
      })
      .returning({ id: providerJobs.id });

    // Place the image credit HOLD tied to this job (settled by applyJobResult).
    await placeHold(tx, {
      userId: project.userId,
      projectId,
      stage: 'image',
      credits: price,
      jobId: job.id,
    });

    return { jobId: job.id, status: 'enqueued' as const };
  });
}

/** Read the per-frame status list for a project (progress signal for the web client). */
export async function getProjectFrames(db: AnyDb, projectId: string): Promise<FrameProgressDto[]> {
  const rows = await db
    .select({
      id: frames.id,
      idx: frames.idx,
      status: frames.status,
      imageRef: frames.imageRef,
      caption: frames.caption,
    })
    .from(frames)
    .where(eq(frames.projectId, projectId))
    .orderBy(frames.idx);
  // Attach a browser-loadable signed URL for any frame that has stored bytes.
  // Provider-aware: local-fs → /files HMAC, s3/R2 → absolute presigned URL.
  return Promise.all(
    (rows as FrameProgressDto[]).map(async (r) => ({
      ...r,
      signedUrl: r.imageRef ? await signedUrlFor(r.imageRef) : null,
    })),
  );
}

/** The image-stage credit cost estimate (bounded per_set), for the UI. */
export async function imageStageCost(db: AnyDb): Promise<number> {
  return stageHoldCredits(db, 'image', 1);
}

/**
 * Drizzle-backed ImageStagePort for production wiring. Records the configured
 * IMAGE_PROVIDER on the job for observability; the runner is what actually
 * selects/executes the provider.
 */
export function createDbImageStage(db: AnyDb = defaultDb): ImageStagePort {
  return {
    enqueue: ({ caller, projectId }) =>
      enqueueImageGeneration(db, { caller, projectId, imageProviderName: env.imageProvider }),
    frames: (projectId) => getProjectFrames(db, projectId),
    cost: () => imageStageCost(db),
  };
}
