/**
 * Preview-gate wiring (P2 / task #15).
 *
 * The 4-frame review as explicit, FSM-guarded transitions:
 *   - loadPreview: images_ready → awaiting_decision (idempotent; no-op if already
 *     past it).
 *   - cancel: in-flight → cancelled.
 *   - retry {prompt?}: awaiting_decision|images_ready → re-enqueue the image
 *     stage (NEW attempt: bumped idempotency key, frame rows reset to pending,
 *     a FRESH per_set hold) → back toward images_ready. Reuses the exact pricing/
 *     hold logic from image-stage.ts; the previous attempt's hold was already
 *     settled by applyJobResult.
 *   - continueToAnimating: awaiting_decision → animating, after a pre-flight
 *     balance check against the bounded animation estimate (per_clip × 4).
 *
 * All transitions go through the FSM (assertTransition) so an out-of-state call
 * is a 409, never a silent corruption. DB-bound; kept behind a port so the HTTP
 * acceptance suite injects a fake (zero DB) while production wires Drizzle.
 */
import type { Storyboard } from '@coji/shared/storyboard';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { frames, projects, providerJobs } from '../../db/tables.ts';
import { env } from '../../env.ts';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import { balance, placeHold } from '../credits/ledger.ts';
import { stageHoldCredits } from '../credits/stage-prices.ts';
import { enqueueAnimation } from './animation-stage.ts';
import { type ProjectState, canTransition } from './fsm.ts';
import {
  IMAGE_FRAME_COUNT,
  InsufficientCreditsError,
  InvalidStateError,
  imageIdempotencyKey,
} from './image-stage.ts';
import { ProjectNotFoundError } from './service.ts';

/** Animation stage is priced per_clip; one clip per frame. */
export const ANIMATION_CLIP_COUNT = IMAGE_FRAME_COUNT;

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

/** Guard a transition through the FSM, raising 409 when illegal. */
function guardTransition(from: ProjectState, to: ProjectState): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new InvalidStateError(`Illegal transition ${from} → ${to}`);
  }
}

/**
 * images_ready → awaiting_decision on preview load. No-op (returns current
 * status) when the project is already at/after awaiting_decision, so polling the
 * preview repeatedly is safe.
 */
export async function loadPreview(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; status: ProjectState }> {
  const project = await loadOwned(db, args);
  if (project.status === 'images_ready') {
    guardTransition('images_ready', 'awaiting_decision');
    await setStatus(db, project.id, 'awaiting_decision');
    return { id: project.id, status: 'awaiting_decision' };
  }
  return { id: project.id, status: project.status as ProjectState };
}

/** in-flight → cancelled (FSM-guarded). */
export async function cancelProject(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; status: ProjectState }> {
  const project = await loadOwned(db, args);
  guardTransition(project.status as ProjectState, 'cancelled');
  await setStatus(db, project.id, 'cancelled');
  return { id: project.id, status: 'cancelled' };
}

/**
 * Retry the image set with an optional modified prompt. Allowed from
 * awaiting_decision or images_ready. Bumps the attempt, resets the 4 frame rows
 * to pending, and places a FRESH per_set hold for the new attempt's job.
 */
export async function retryImages(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; prompt?: string; storyboard?: Storyboard },
): Promise<{ id: string; status: ProjectState; jobId: string; attempt: number }> {
  const project = await loadOwned(db, args);
  const status = project.status as ProjectState;
  if (status !== 'awaiting_decision' && status !== 'images_ready') {
    throw new InvalidStateError(
      `retry requires 'awaiting_decision' or 'images_ready', but project is '${status}'`,
    );
  }

  return db.transaction(async (tx: AnyDb) => {
    // Determine the next attempt from existing image jobs (max attempt + 1).
    const jobs = await tx
      .select({ attempts: providerJobs.attempts })
      .from(providerJobs)
      .where(eq(providerJobs.projectId, project.id));
    const maxAttempt = jobs.reduce(
      (m: number, j: { attempts: number }) => Math.max(m, j.attempts),
      -1,
    );
    const attempt = maxAttempt + 1;
    const key = imageIdempotencyKey(project.id, attempt);

    // Price + pre-flight balance for the fresh hold (previous hold already settled).
    const price = await stageHoldCredits(tx, 'image', 1);
    const available = await balance(tx, project.userId);
    if (available < price) throw new InsufficientCreditsError(price, available);

    // Optionally update the prompt; reset frames to pending for the new set.
    const prompt = args.prompt ?? project.prompt;
    if (args.prompt && args.prompt !== project.prompt) {
      await tx
        .update(projects)
        .set({ prompt, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }
    // script + saved storyboard + style live on the row (loadOwned subset).
    const [extra] = await tx
      .select({
        script: projects.script,
        shotConfig: projects.shotConfig,
        style: projects.style,
      })
      .from(projects)
      .where(eq(projects.id, project.id));
    // Optionally update the storyboard (re-generate with edited shots).
    const storyboard: Storyboard | null = args.storyboard ?? extra?.shotConfig ?? null;
    if (args.storyboard) {
      await tx
        .update(projects)
        .set({ shotConfig: args.storyboard, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }
    await tx
      .update(frames)
      .set({ status: 'pending', imageRef: null, caption: null })
      .where(eq(frames.projectId, project.id));

    // Move back toward images-in-progress: awaiting_decision → images_ready is a
    // legal edge; from images_ready we stay put. The runner re-completes frames.
    if (status === 'awaiting_decision') {
      guardTransition('awaiting_decision', 'images_ready');
      await tx
        .update(projects)
        .set({ status: 'images_ready', updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }

    const [job] = await tx
      .insert(providerJobs)
      .values({
        projectId: project.id,
        kind: 'image',
        provider: env.imageProvider,
        status: 'pending',
        attempts: attempt,
        idempotencyKey: key,
        payload: { prompt, script: extra?.script ?? null, storyboard, style: extra?.style ?? null },
      })
      .returning({ id: providerJobs.id });

    await placeHold(tx, {
      userId: project.userId,
      projectId: project.id,
      stage: 'image',
      credits: price,
      jobId: job.id,
    });

    return { id: project.id, status: 'images_ready' as ProjectState, jobId: job.id, attempt };
  });
}

/**
 * awaiting_decision → animating (gateway into P3). Computes the animation credit
 * estimate (bounded per_clip × 4) and rejects with 402 if the owner can't cover
 * it. Returns the estimate so the UI can show "Continue → N credits".
 */
export async function continueToAnimating(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; status: ProjectState; animationCreditEstimate: number }> {
  const project = await loadOwned(db, args);
  guardTransition(project.status as ProjectState, 'animating');

  const estimate = await stageHoldCredits(db, 'animation', ANIMATION_CLIP_COUNT);
  const available = await balance(db, project.userId);
  if (available < estimate) throw new InsufficientCreditsError(estimate, available);

  // Enqueue the 4 animation jobs + per-clip holds (P3 / #18). enqueueAnimation
  // performs the awaiting_decision→animating transition itself and is idempotent,
  // so the project never sits in `animating` with no work queued.
  await enqueueAnimation(db, { caller: args.caller, projectId: project.id });
  return { id: project.id, status: 'animating', animationCreditEstimate: estimate };
}

/** Animation credit estimate without transitioning (for the UI on the gate). */
export async function animationEstimate(db: AnyDb): Promise<number> {
  return stageHoldCredits(db, 'animation', ANIMATION_CLIP_COUNT);
}

// --- internals -----------------------------------------------------------

async function loadOwned(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; userId: string; prompt: string; status: string }> {
  const rows = await db.select().from(projects).where(eq(projects.id, args.projectId)).limit(1);
  const project = rows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, args.caller);
  return project;
}

async function setStatus(db: AnyDb, projectId: string, status: ProjectState): Promise<void> {
  await db
    .update(projects)
    .set({ status, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}

// --- port + production wiring --------------------------------------------

export interface PreviewGatePort {
  loadPreview(args: { caller: AuthContext; projectId: string }): Promise<{
    id: string;
    status: ProjectState;
  }>;
  cancel(args: { caller: AuthContext; projectId: string }): Promise<{
    id: string;
    status: ProjectState;
  }>;
  retry(args: {
    caller: AuthContext;
    projectId: string;
    prompt?: string;
  }): Promise<{ id: string; status: ProjectState; jobId: string; attempt: number }>;
  continueToAnimating(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: ProjectState; animationCreditEstimate: number }>;
  /**
   * Read-only animation credit estimate (bounded per_clip × 4) WITHOUT
   * transitioning — lets the editor show cost-before-confirm (E2). Optional on
   * the port; the in-memory acceptance fake may omit it.
   */
  animationEstimate?(): Promise<number>;
}

export function createDbPreviewGate(db: AnyDb = defaultDb): PreviewGatePort {
  return {
    loadPreview: (args) => loadPreview(db, args),
    cancel: (args) => cancelProject(db, args),
    retry: (args) => retryImages(db, args),
    continueToAnimating: (args) => continueToAnimating(db, args),
    animationEstimate: () => animationEstimate(db),
  };
}
