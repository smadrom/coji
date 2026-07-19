/**
 * Animation-stage wiring (P3 / task #18; clip-composer rewrite / WS4).
 *
 * The HeyGen image-to-video stage, now driven by the project's COMPOSITION — a
 * user-authored list of N clips (clip-composer), each a `{ frame, line, order }`
 * beat — rather than a fixed 1:1 mapping to the 4 frames. `enqueueAnimation`:
 *   1. asserts ownership + state (awaiting_decision | composing | animating);
 *   2. resolves the clip list: the project's existing composition clips, or —
 *      for the legacy direct path (no composer step) — AUTO-SEEDS a 4-clip
 *      composition from the 4 frames (1:1, script split per frame) so old flows
 *      keep working (back-compat, P4 in the plan);
 *   3. caps N ≤ MAX_CLIPS_PER_PROJECT (bounds the N-hold tx + abuse);
 *   4. prices the stage (per_clip × N) + pre-flight balance check;
 *   5. in ONE transaction, for each clip: resolve clip → its source frame
 *      (clips.frame_id, REUSABLE), create a provider_jobs(kind=animation,
 *      idempotency_key=`${clipId}:${attempt}` — CANONICAL, migrated from
 *      frameId:attempt; payload carries {clipId, frameId, frameRef, audio});
 *      place ONE animation HOLD per job tied to it (so each clip settles
 *      independently — partial failure refunds only the failed clips' holds);
 *   6. ensures the project is in `animating`.
 *
 * Idempotent: if animation jobs already exist for the project, it is a no-op (so
 * calling it again — or after the gate already transitioned to animating — never
 * double-charges or double-enqueues).
 *
 * The runner SUBMITS each job to HeyGen (records external_id, stays processing);
 * terminal resolution arrives via the webhook receiver or the reconciler, both
 * routed exclusively through applyJobResult (the ONE writer). applyJobResult keys
 * the result by `payload.clipId` (WS5) so a frame backing several clips settles
 * each clip independently; clips_ready is reached only when EVERY clip is
 * terminal (see jobs/transition-policy.ts).
 *
 * The `${clipId}:${attempt}` idempotency-key format is the SINGLE source shared
 * by this stage and the runner/applyJobResult settlement (WS5) — keep them in
 * lock-step.
 */
import { NoopVoGenerator, type VoGenerator } from '@coji/shared/providers';
import { resolveLocale, splitScriptForFrames } from '@coji/shared/style';
import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { clips, frames, projects, providerJobs } from '../../db/tables.ts';
import { env } from '../../env.ts';
import { makeOpenRouterVoGenerator } from '../../providers/openrouter.ts';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import { balance, placeHold } from '../credits/ledger.ts';
import { unitPrice } from '../credits/stage-prices.ts';
import { type ProjectState, canTransition } from './fsm.ts';
import { InsufficientCreditsError, InvalidStateError } from './image-stage.ts';
import { MAX_CLIPS_PER_PROJECT } from './schema.ts';
import { type AnimationStagePort, ProjectNotFoundError } from './service.ts';

/** Frame count for the AUTO-SEEDED legacy composition (4 frames → 4 clips). */
export const ANIMATION_CLIP_COUNT = 4;

/**
 * Resolve the VO-script generator (D2). Prod uses the OpenRouter-backed LLM
 * generator when an OPENROUTER_API_KEY is configured; otherwise (CI/test, no
 * key) the deterministic NoopVoGenerator — so CI never calls the paid API
 * (hard rule #3). Selection is per-call so a missing key never throws here.
 */
function resolveVoGenerator(): VoGenerator {
  if (env.openrouterApiKey) {
    return makeOpenRouterVoGenerator({ apiKey: env.openrouterApiKey, title: 'coji' });
  }
  return new NoopVoGenerator();
}

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

/** Audio spec resolved from the project, embedded in each animation job payload. */
type AudioPayload =
  | { mode: 'tts'; script: string; voiceId: string }
  | { mode: 'audio_url'; audioUrl: string };

/**
 * Build the per-clip, per-attempt idempotency key for an animation job.
 *
 * CANONICAL: keyed by `clipId` (clip-composer / WS4) — a clip is the animate
 * unit now, and a frame may back several clips so `frameId` is no longer unique
 * per job. The runner + applyJobResult (WS5) read this exact format.
 */
export function animationIdempotencyKey(clipId: string, attempt: number): string {
  return `${clipId}:${attempt}`;
}

/**
 * Resolve + validate the project's audio config into ONE payload PER frame, so
 * each HeyGen clip speaks its own VO segment (shorter scripts = cheaper clips).
 * Used ONLY by the legacy auto-seed path (no composition) — the composer path
 * carries each clip's own `script`.
 *
 * - tts: the VO script is split into `count` non-empty lines (one per clip); the
 *   shared `voice_id` (resolved from locale+gender at create) is used for all.
 *   When no script was entered, the prompt is used as the VO source so the stage
 *   never throws on a missing script (the locale-matched voice still applies).
 * - audio_url: the same supplied audio URL is used for every clip (a single
 *   pre-rendered track can't be split here).
 */
export function resolveFrameAudioPayloads(
  project: {
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    voiceId: string | null;
    audioUrl: string | null;
  },
  count: number,
): AudioPayload[] {
  if (project.audioMode === 'tts') {
    if (!project.voiceId) {
      throw new InvalidStateError('tts audio mode requires a voice_id on the project');
    }
    const voiceId = project.voiceId;
    const source = project.script?.trim() ? project.script : project.prompt;
    const lines = splitScriptForFrames(source, count);
    return lines.map((line) => ({ mode: 'tts', script: line.trim() || source, voiceId }));
  }
  if (!project.audioUrl) {
    throw new InvalidStateError('audio_url audio mode requires audio_url on the project');
  }
  const audioUrl = project.audioUrl;
  return Array.from({ length: count }, () => ({ mode: 'audio_url', audioUrl }));
}

/**
 * Resolve ONE clip's audio payload (clip-composer path). The clip carries its own
 * VO line (`clip.script`); the project's shared voice is used. Empty line falls
 * back to the project script/prompt so a beat never submits an empty TTS.
 * audio_url projects reuse the single supplied track.
 */
export function resolveClipAudioPayload(
  project: {
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    voiceId: string | null;
    audioUrl: string | null;
  },
  clipScript: string,
): AudioPayload {
  if (project.audioMode === 'tts') {
    if (!project.voiceId) {
      throw new InvalidStateError('tts audio mode requires a voice_id on the project');
    }
    const fallback = project.script?.trim() ? project.script : project.prompt;
    const script = clipScript.trim() || fallback;
    return { mode: 'tts', script, voiceId: project.voiceId };
  }
  if (!project.audioUrl) {
    throw new InvalidStateError('audio_url audio mode requires audio_url on the project');
  }
  return { mode: 'audio_url', audioUrl: project.audioUrl };
}

export interface EnqueueAnimationResult {
  status: 'enqueued' | 'already_enqueued';
  jobIds: string[];
}

/** Explicit failure when VO generation is needed but did not produce a script. */
export class VoGenerationError extends Error {
  readonly status = 502;
  constructor() {
    super('Could not generate a voice-over script for this project. Add a script and try again.');
    this.name = 'VoGenerationError';
  }
}

/**
 * Ensure a TTS project has a spoken VO script (D2). When the user left the
 * script empty, generate one in the project's locale via the VoGenerator seam
 * and PERSIST it to projects.script (so the editor shows it and the retry/
 * reanimate paths reuse it). On generation failure we throw EXPLICITLY rather
 * than silently reading the raw prompt aloud (the previous behaviour). No-op for
 * audio_url projects or when a script already exists. Returns the script to use.
 */
async function ensureVoScript(
  db: AnyDb,
  project: {
    id: string;
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    locale: string | null;
  },
  voGenerator: VoGenerator,
): Promise<string | null> {
  if (project.audioMode !== 'tts') return project.script;
  if (project.script?.trim()) return project.script;

  const locale = resolveLocale(project.locale);
  const generated = (await voGenerator.generate({ prompt: project.prompt, locale }))?.trim();
  if (!generated) throw new VoGenerationError();

  await db
    .update(projects)
    .set({ script: generated, updatedAt: new Date() })
    .where(eq(projects.id, project.id));
  return generated;
}

/** A composition clip to animate: its id, its source frame, and its VO line. */
type ComposedClip = { clipId: string; frameId: string; frameRef: string; script: string };

/**
 * Resolve the clips to animate for a project, in order_idx order. Returns the
 * existing composition clips when present; otherwise AUTO-SEEDS a 4-clip
 * composition from the 4 frames (1:1, script split per frame) and inserts the
 * pending clip rows — so the legacy direct path (no composer step) keeps working.
 * Throws if frames are missing/incomplete (image stage not done).
 */
async function resolveComposedClips(
  tx: AnyDb,
  project: {
    id: string;
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    voiceId: string | null;
    audioUrl: string | null;
  },
): Promise<ComposedClip[]> {
  // Existing composition: clips joined to their source frame, in order_idx order.
  const existing = await tx
    .select({
      clipId: clips.id,
      frameId: clips.frameId,
      frameRef: frames.imageRef,
      script: clips.script,
    })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(frames.projectId, project.id))
    .orderBy(clips.orderIdx);

  if (existing.length > 0) {
    return existing.map(
      (c: { clipId: string; frameId: string; frameRef: string | null; script: string }) => {
        if (!c.frameRef) {
          throw new InvalidStateError(
            `clip ${c.clipId} source frame has no image_ref; image stage incomplete`,
          );
        }
        return { clipId: c.clipId, frameId: c.frameId, frameRef: c.frameRef, script: c.script };
      },
    );
  }

  // Legacy auto-seed: 4 frames → 4 clips (1:1), one script line per frame.
  const frameRows = await tx
    .select({ id: frames.id, idx: frames.idx, imageRef: frames.imageRef })
    .from(frames)
    .where(eq(frames.projectId, project.id))
    .orderBy(frames.idx);
  if (frameRows.length !== ANIMATION_CLIP_COUNT) {
    throw new InvalidStateError(
      `animation requires ${ANIMATION_CLIP_COUNT} frames, found ${frameRows.length}`,
    );
  }

  const audios = resolveFrameAudioPayloads(project, ANIMATION_CLIP_COUNT);
  const seeded: ComposedClip[] = [];
  for (const frame of frameRows) {
    if (!frame.imageRef) {
      throw new InvalidStateError(`frame ${frame.idx} has no image_ref; image stage incomplete`);
    }
    const audio = audios[frame.idx] ?? audios[0];
    const script = audio && audio.mode === 'tts' ? audio.script : '';
    const [row] = await tx
      .insert(clips)
      .values({ frameId: frame.id, script, orderIdx: frame.idx, status: 'pending', attempt: 0 })
      .returning({ id: clips.id });
    seeded.push({
      clipId: row.id,
      frameId: frame.id,
      frameRef: frame.imageRef,
      script,
    });
  }
  return seeded;
}

/**
 * Enqueue the N animation jobs for an owned project's composition and place one
 * per_clip hold per job.
 *
 * Safe to call whether or not the gate has already transitioned the project to
 * `animating`: it transitions if needed and is idempotent on the job set (skips
 * when animation jobs already exist).
 */
export async function enqueueAnimation(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; voGenerator?: VoGenerator },
): Promise<EnqueueAnimationResult> {
  const { caller, projectId, voGenerator = resolveVoGenerator() } = args;

  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  // Allowed from awaiting_decision / composing (gate) or animating (already moved).
  if (
    project.status !== 'awaiting_decision' &&
    project.status !== 'composing' &&
    project.status !== 'animating'
  ) {
    throw new InvalidStateError(
      `continue/animate requires 'awaiting_decision', 'composing' or 'animating', but project is '${project.status}'`,
    );
  }

  // Idempotency: if animation jobs already exist, do not re-enqueue/charge.
  const existingJobs = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(and(eq(providerJobs.projectId, projectId), eq(providerJobs.kind, 'animation')));
  if (existingJobs.length > 0) {
    return { status: 'already_enqueued', jobIds: existingJobs.map((j: { id: string }) => j.id) };
  }

  // D2: a TTS project with no script gets a generated locale VO (persisted),
  // instead of silently reading the raw prompt aloud. Throws explicitly on
  // generation failure. The resolved script feeds the auto-seed split (the
  // composer path carries per-clip scripts and ignores this).
  project.script = await ensureVoScript(db, project, voGenerator);

  return db.transaction(async (tx: AnyDb) => {
    const composed = await resolveComposedClips(tx, project);
    if (composed.length === 0) {
      throw new InvalidStateError('animation requires at least one clip in the composition');
    }
    if (composed.length > MAX_CLIPS_PER_PROJECT) {
      throw new InvalidStateError(
        `composition exceeds the ${MAX_CLIPS_PER_PROJECT}-clip cap (got ${composed.length})`,
      );
    }

    // Price per clip; total = perClip × N. Pre-flight the owner balance.
    const perClip = await unitPrice(tx, 'animation');
    const total = perClip * composed.length;
    const available = await balance(tx, project.userId);
    if (available < total) throw new InsufficientCreditsError(total, available);

    const jobIds: string[] = [];
    for (const clip of composed) {
      const audio = resolveClipAudioPayload(project, clip.script);
      const attempt = 0;

      const [job] = await tx
        .insert(providerJobs)
        .values({
          projectId,
          kind: 'animation',
          provider: env.animationProvider,
          status: 'pending',
          attempts: attempt,
          idempotencyKey: animationIdempotencyKey(clip.clipId, attempt),
          // payload.clipId is the CANONICAL settlement key (WS5); frameId is kept
          // for back-compat/debugging; frameRef + audio drive the HeyGen submit.
          payload: {
            clipId: clip.clipId,
            frameId: clip.frameId,
            frameRef: clip.frameRef,
            audio,
          },
        })
        .returning({ id: providerJobs.id });

      // One hold per clip (per_clip), settled independently by applyJobResult.
      await placeHold(tx, {
        userId: project.userId,
        projectId,
        stage: 'animation',
        credits: perClip,
        jobId: job.id,
      });
      jobIds.push(job.id);
    }

    // Ensure the project is in `animating` (gate may have done this already).
    if (project.status !== 'animating') {
      const from = project.status as ProjectState;
      if (!canTransition(from, 'animating')) {
        throw new InvalidStateError(`${from} → animating is not a legal transition`);
      }
      await tx
        .update(projects)
        .set({ status: 'animating', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }

    return { status: 'enqueued' as const, jobIds };
  });
}

/**
 * Compute the next attempt for a clip = max existing animation attempt for it
 * (by the `${clipId}:` idempotency-key prefix) + 1.
 */
async function nextClipAttempt(tx: AnyDb, projectId: string, clipId: string): Promise<number> {
  const jobs = await tx
    .select({ attempts: providerJobs.attempts, key: providerJobs.idempotencyKey })
    .from(providerJobs)
    .where(and(eq(providerJobs.projectId, projectId), eq(providerJobs.kind, 'animation')));
  const prefix = `${clipId}:`;
  const maxAttempt = jobs
    .filter((j: { key: string }) => j.key.startsWith(prefix))
    .reduce((m: number, j: { attempts: number }) => Math.max(m, j.attempts), -1);
  return maxAttempt + 1;
}

/**
 * Resolve a clip → its source frame ref + its VO audio payload (scoped to the
 * project so a foreign clipId can't target another project's clip). Shared by
 * the retry/re-animate paths.
 */
async function loadClipForAnimate(
  tx: AnyDb,
  project: {
    id: string;
    audioMode: 'tts' | 'audio_url';
    prompt: string;
    script: string | null;
    voiceId: string | null;
    audioUrl: string | null;
  },
  clipId: string,
): Promise<{ frameId: string; frameRef: string; audio: AudioPayload }> {
  const rows = await tx
    .select({ frameId: clips.frameId, frameRef: frames.imageRef, script: clips.script })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(and(eq(clips.id, clipId), eq(frames.projectId, project.id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new InvalidStateError(`clip ${clipId} not found on project`);
  if (!row.frameRef) throw new InvalidStateError(`clip ${clipId} source frame has no image_ref`);
  const audio = resolveClipAudioPayload(project, row.script ?? '');
  return { frameId: row.frameId as string, frameRef: row.frameRef as string, audio };
}

/**
 * Retry a single clip's animation while the project is in `animating` (bumped
 * attempt → new `${clipId}:${attempt}` key + fresh per_clip hold). The previous
 * attempt's hold was already settled (refunded) by applyJobResult.
 */
export async function retryAnimationClip(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; clipId: string },
): Promise<{ jobId: string; attempt: number }> {
  const { caller, projectId, clipId } = args;
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);
  if (project.status !== 'animating') {
    throw new InvalidStateError(
      `retry-clip requires 'animating', but project is '${project.status}'`,
    );
  }

  return db.transaction(async (tx: AnyDb) => {
    const { frameId, frameRef, audio } = await loadClipForAnimate(tx, project, clipId);
    const attempt = await nextClipAttempt(tx, projectId, clipId);

    const perClip = await unitPrice(tx, 'animation');
    const available = await balance(tx, project.userId);
    if (available < perClip) throw new InsufficientCreditsError(perClip, available);

    // Reset THIS clip (by id) to pending for the new attempt — not all clips on
    // the frame (a frame may back several clips).
    await tx
      .update(clips)
      .set({ status: 'pending', videoUrl: null, attempt })
      .where(eq(clips.id, clipId));

    const [job] = await tx
      .insert(providerJobs)
      .values({
        projectId,
        kind: 'animation',
        provider: env.animationProvider,
        status: 'pending',
        attempts: attempt,
        idempotencyKey: animationIdempotencyKey(clipId, attempt),
        payload: { clipId, frameId, frameRef, audio },
      })
      .returning({ id: providerJobs.id });

    await placeHold(tx, {
      userId: project.userId,
      projectId,
      stage: 'animation',
      credits: perClip,
      jobId: job.id,
    });

    return { jobId: job.id, attempt };
  });
}

/**
 * Back-compat shim: retry by FRAME id (legacy P3 entry). Resolves the frame's
 * clip(s) and retries them via the clip-keyed path. With the composer a frame
 * may back several clips; this retries every clip on that frame. Prefer
 * {@link retryAnimationClip}. Returns the LAST clip's job id + attempt.
 */
export async function retryAnimationFrame(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; frameId: string },
): Promise<{ jobId: string; attempt: number }> {
  const { caller, projectId, frameId } = args;
  const clipRows = await db
    .select({ id: clips.id })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(and(eq(clips.frameId, frameId), eq(frames.projectId, projectId)))
    .orderBy(clips.orderIdx);
  if (clipRows.length === 0) {
    throw new InvalidStateError(`no clip found for frame ${frameId} on project`);
  }
  let last: { jobId: string; attempt: number } | null = null;
  for (const c of clipRows) {
    last = await retryAnimationClip(db, { caller, projectId, clipId: c.id as string });
  }
  // Non-null: clipRows.length > 0 guaranteed above.
  return last as { jobId: string; attempt: number };
}

/**
 * Re-animate ONE clip from the editor (C2). Unlike {@link retryAnimationClip}
 * (which requires the project already be in `animating`), this is the
 * editor-reachable entry: a failed/unsatisfactory clip surfaces in the editor
 * while the project sits in `clips_ready` or `editing`. It:
 *   1. resolves the clip (scoped to the project) → its source frame ref + line;
 *   2. allows `clips_ready` | `editing` | `animating` (re-entrant);
 *   3. re-enters `animating` (FSM-guarded) so the runner + applyJobResult treat
 *      it exactly like the initial animation stage — when the clip settles, the
 *      animation transition policy returns the project to `clips_ready`;
 *   4. resets THAT clip (by id) to pending, enqueues a fresh per-clip animation
 *      job (bumped attempt → new key) and places ONE per_clip hold tied to it.
 *
 * applyJobResult remains the ONE writer of the result (hard rule #4); the hold is
 * settled (debit on success / refund on failure) per stage (hard rule #5). All
 * writes happen in one transaction. Returns the new job id + the clip's attempt.
 */
export async function reanimateClip(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; clipId: string },
): Promise<{ jobId: string; attempt: number; status: 'animating' }> {
  const { caller, projectId, clipId } = args;

  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  const status = project.status as string;
  if (status !== 'clips_ready' && status !== 'editing' && status !== 'animating') {
    throw new InvalidStateError(
      `re-animate requires 'clips_ready', 'editing' or 'animating', but project is '${status}'`,
    );
  }

  return db.transaction(async (tx: AnyDb) => {
    const { frameId, frameRef, audio } = await loadClipForAnimate(tx, project, clipId);
    const attempt = await nextClipAttempt(tx, projectId, clipId);

    const perClip = await unitPrice(tx, 'animation');
    const available = await balance(tx, project.userId);
    if (available < perClip) throw new InsufficientCreditsError(perClip, available);

    // Re-enter `animating` (FSM-guarded) unless already there.
    if (status !== 'animating') {
      if (!canTransition(status as ProjectState, 'animating')) {
        throw new InvalidStateError(`${status} → animating is not a legal transition`);
      }
      await tx
        .update(projects)
        .set({ status: 'animating', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }

    // Reset THIS clip (by id) to pending for the new attempt.
    await tx
      .update(clips)
      .set({ status: 'pending', videoUrl: null, attempt })
      .where(eq(clips.id, clipId));

    const [job] = await tx
      .insert(providerJobs)
      .values({
        projectId,
        kind: 'animation',
        provider: env.animationProvider,
        status: 'pending',
        attempts: attempt,
        idempotencyKey: animationIdempotencyKey(clipId, attempt),
        payload: { clipId, frameId, frameRef, audio },
      })
      .returning({ id: providerJobs.id });

    await placeHold(tx, {
      userId: project.userId,
      projectId,
      stage: 'animation',
      credits: perClip,
      jobId: job.id,
    });

    return { jobId: job.id, attempt, status: 'animating' as const };
  });
}

/**
 * Animation-stage credit cost estimate. Without a project it returns the bounded
 * legacy estimate (per_clip × 4) for the gate's Continue button. With a project
 * id it returns the EXACT cost for the project's composition (per_clip × N),
 * falling back to the legacy 4 when no composition has been authored yet.
 */
export async function animationStageCost(db: AnyDb, projectId?: string): Promise<number> {
  const perClip = await unitPrice(db, 'animation');
  if (!projectId) return perClip * ANIMATION_CLIP_COUNT;
  const rows = await db
    .select({ id: clips.id })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(frames.projectId, projectId));
  const n = rows.length > 0 ? rows.length : ANIMATION_CLIP_COUNT;
  return perClip * n;
}

// --- production wiring (implements the service's AnimationStagePort) -------

export function createDbAnimationStage(db: AnyDb = defaultDb): AnimationStagePort {
  return {
    reanimateClip: (args) => reanimateClip(db, args),
  };
}
