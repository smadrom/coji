import { VIDEO_HEIGHT, VIDEO_WIDTH } from '@coji/shared/video';
/**
 * Render/export-stage wiring (P4 / task #20).
 *
 * Mirrors image-stage.ts / animation-stage.ts for the final Remotion render. The
 * gateway is the editor's Export. `enqueueExport`:
 *   1. asserts ownership;
 *   2. state guard: project must be in `clips_ready` or `editing`;
 *   3. prices the stage (bounded `per_export` from stage_prices) + pre-flight
 *      balance check;
 *   4. builds the render composition inputProps from the project's clips[]
 *      (signed video_url + per-clip trims) + the project's audio track;
 *   5. in ONE transaction: on a RE-export (a render job for the current attempt
 *      already exists and is terminal) bump render_attempt so the new job key is
 *      fresh; ensure clips_ready→editing; create/reuse a renders row (pending) +
 *      a provider_jobs(kind=render, idempotency_key='render:'+projectId+':'+
 *      render_attempt, payload={composition}); place the render HOLD tied to it;
 *   6. returns 202 — the runner does the render asynchronously.
 *
 * The unified runner's kind=render branch runs the configured RenderProvider
 * (Noop in CI; remotion-local in prod), stores the output via StorageProvider,
 * and applyJobResult settles the hold (debit on success / refund on failure) and
 * moves the FSM editing→rendered (failure → stays editing so the user can
 * re-export; see jobs/transition-policy.ts).
 *
 * Idempotent: a second export while a render job for the current render_attempt
 * is still open is a no-op (returns the existing job).
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { clips, frames, projects, providerJobs, renders } from '../../db/tables.ts';
import { env } from '../../env.ts';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import { balance, placeHold } from '../credits/ledger.ts';
import { stageHoldCredits } from '../credits/stage-prices.ts';
import { clipBrowserUrl, clipEditorUrl, renderEditorUrl } from '../jobs/clip-storage.ts';
import { canTransition } from './fsm.ts';
import { InsufficientCreditsError, InvalidStateError } from './image-stage.ts';
import type { ClipViewDto, RenderStatusDto } from './schema.ts';
import { ProjectNotFoundError, type RenderStagePort } from './service.ts';

/** Signed-URL TTL for clips fed to OffthreadVideo — must outlive the render. */
const CLIP_URL_TTL_SECONDS = 6 * 60 * 60;

/** Editor/Remotion frame rate — clip durations are converted seconds → frames. */
const CLIP_FPS = 30;

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

/**
 * Build the per-render-attempt idempotency key for a render job. MUST be
 * prefixed so it never collides with the IMAGE key (`${projectId}:${attempt}`)
 * — `idempotency_key` is unique across ALL provider_jobs, so an unprefixed
 * render key with the same projectId+0 matched the image job and the render job
 * was silently never created (export → "already_enqueued").
 */
export function renderIdempotencyKey(projectId: string, renderAttempt: number): string {
  return `render:${projectId}:${renderAttempt}`;
}

export interface EnqueueExportResult {
  jobId: string;
  status: 'enqueued' | 'already_enqueued';
  renderAttempt: number;
}

/**
 * Build the RenderComposition inputProps from a project's completed clips (in
 * frame order) + its audio track. Each clip contributes an OffthreadVideo source
 * (signed video_url). Shape matches the RenderProvider seam (@coji/shared).
 *
 * Clip order & selection:
 *   - When the request carries an explicit ordered `clips[]` (E1 reorder/delete),
 *     the render contains EXACTLY those clip ids in that order; clips not listed
 *     are excluded; unknown/non-completed ids are skipped. Each entry's
 *     {startFrom,endAt} overrides; absent → persisted trim; null persisted → full.
 *   - Otherwise the render is every completed clip in frame (idx) order.
 *
 * Per-clip trims (no explicit selection): an explicit request `trims[]` (the
 * editor's current, unsaved state) takes precedence and is applied by position.
 * When the request omits trims, we FALL BACK to each clip's PERSISTED trim
 * (clips.trim_start_frame / trim_end_frame, saved by the editor's B1 save route)
 * so a plain re-export honours the trims the user already committed. A clip whose
 * trim cols are null (never trimmed) gets no trim — full clip.
 */
type CompletedClipRow = {
  id: string;
  videoUrl: string;
  trimStartFrame: number | null;
  trimEndFrame: number | null;
};

/** Effective trim for a clip: explicit request trim → persisted → none (full). */
function resolveTrim(
  row: CompletedClipRow,
  requested?: { startFrom?: number; endAt?: number },
): { startFrom: number; endAt: number } | undefined {
  if (requested?.startFrom != null && requested.endAt != null) {
    return { startFrom: requested.startFrom, endAt: requested.endAt };
  }
  if (row.trimStartFrame != null && row.trimEndFrame != null) {
    return { startFrom: row.trimStartFrame, endAt: row.trimEndFrame };
  }
  return undefined;
}

async function buildComposition(
  db: AnyDb,
  project: { id: string; audioUrl: string | null },
  trims?: { startFrom: number; endAt: number }[],
  selection?: { clipId: string; startFrom?: number; endAt?: number }[],
): Promise<{
  clips: { videoUrl: string; startFrom?: number; endAt?: number }[];
  audioUrl?: string;
  fps: number;
  width: number;
  height: number;
}> {
  // Clips joined to frames so they come back in frame order (idx 0–3).
  const rows = await db
    .select({
      id: clips.id,
      idx: frames.idx,
      videoUrl: clips.videoUrl,
      status: clips.status,
      trimStartFrame: clips.trimStartFrame,
      trimEndFrame: clips.trimEndFrame,
    })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(frames.projectId, project.id))
    .orderBy(frames.idx);

  const ready: CompletedClipRow[] = rows.filter(
    (r: { videoUrl: string | null; status: string }) => r.videoUrl && r.status === 'completed',
  );
  if (ready.length === 0) {
    throw new InvalidStateError('export requires at least one completed clip with a video_url');
  }

  // Re-sign storage keys to absolute http(s) URLs for the render provider (it
  // fetches them server-side); pass legacy provider URLs through. A trim is
  // applied only when it actually narrows the clip (endAt > startFrom).
  const toInput = async (row: CompletedClipRow, trim?: { startFrom: number; endAt: number }) => ({
    videoUrl: await clipBrowserUrl(row.videoUrl),
    ...(trim && trim.endAt > trim.startFrom
      ? { startFrom: trim.startFrom, endAt: trim.endAt }
      : {}),
  });

  let clipInputs: { videoUrl: string; startFrom?: number; endAt?: number }[];
  if (selection != null && selection.length > 0) {
    // Explicit ordered selection (E1): render exactly the listed completed clips
    // in the given order. Resolve each by id; drop unknown/non-completed ids.
    const byId = new Map(ready.map((r) => [r.id, r]));
    const picked = selection
      .map((sel) => ({ sel, row: byId.get(sel.clipId) }))
      .filter((p): p is { sel: (typeof selection)[number]; row: CompletedClipRow } => !!p.row);
    if (picked.length === 0) {
      throw new InvalidStateError('export selection matched no completed clips');
    }
    clipInputs = await Promise.all(
      picked.map(({ sel, row }) => toInput(row, resolveTrim(row, sel))),
    );
  } else {
    // No explicit selection: every completed clip in idx order. The request's
    // positional trims[] override per position; otherwise persisted/none.
    const useRequestTrims = trims != null && trims.length > 0;
    clipInputs = await Promise.all(
      ready.map((row, i) => toInput(row, resolveTrim(row, useRequestTrims ? trims[i] : undefined))),
    );
  }

  return {
    clips: clipInputs,
    fps: CLIP_FPS,
    // Vertical 9:16 (TikTok/Reels/Shorts) — single source in @coji/shared.
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    ...(project.audioUrl ? { audioUrl: project.audioUrl } : {}),
  };
}

/**
 * Enqueue the final render for an owned project and place the render hold.
 */
export async function enqueueExport(
  db: AnyDb,
  args: {
    caller: AuthContext;
    projectId: string;
    trims?: { startFrom: number; endAt: number }[];
    /** Explicit ORDERED clip selection (E1); overrides positional `trims`. */
    clips?: { clipId: string; startFrom?: number; endAt?: number }[];
  },
): Promise<EnqueueExportResult> {
  const { caller, projectId, trims, clips: selection } = args;

  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  if (project.status !== 'clips_ready' && project.status !== 'editing') {
    throw new InvalidStateError(
      `export requires project in 'clips_ready' or 'editing', but it is '${project.status}'`,
    );
  }

  // Idempotency vs. re-export. The render job for the CURRENT render_attempt has
  // a unique `render:<pid>:<attempt>` key, so it can only be created once. Two
  // cases when one already exists:
  //   - IN-FLIGHT (pending/processing) → a double-click on Export; return the
  //     existing job so we never run two renders for the same attempt.
  //   - TERMINAL (completed/failed) → a genuine re-export (e.g. after editing
  //     trims). Bump render_attempt so a FRESH render:<pid>:<newAttempt> job is
  //     created below; otherwise the unique-key dup check would make re-render a
  //     silent no-op.
  const currentKey = renderIdempotencyKey(projectId, project.renderAttempt);
  const existing = await db
    .select({ id: providerJobs.id, status: providerJobs.status })
    .from(providerJobs)
    .where(eq(providerJobs.idempotencyKey, currentKey))
    .limit(1);
  const inFlight = existing[0]?.status === 'pending' || existing[0]?.status === 'processing';
  if (existing[0] && inFlight) {
    return {
      jobId: existing[0].id,
      status: 'already_enqueued',
      renderAttempt: project.renderAttempt,
    };
  }

  return db.transaction(async (tx: AnyDb) => {
    const price = await stageHoldCredits(tx, 'render', 1);
    const available = await balance(tx, project.userId);
    if (available < price) throw new InsufficientCreditsError(price, available);

    // Re-export of a terminal attempt: bump render_attempt inside the tx so the
    // job key below is fresh. First export (no prior job) keeps the attempt.
    const renderAttempt = existing[0] ? project.renderAttempt + 1 : project.renderAttempt;
    if (existing[0]) {
      await tx
        .update(projects)
        .set({ renderAttempt, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }
    const key = renderIdempotencyKey(projectId, renderAttempt);
    const composition = await buildComposition(tx, project, trims, selection);

    // clips_ready → editing before the render runs.
    if (project.status === 'clips_ready') {
      if (!canTransition('clips_ready', 'editing')) {
        throw new InvalidStateError('clips_ready → editing is not a legal transition');
      }
      await tx
        .update(projects)
        .set({ status: 'editing', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }

    // renders row (pending) for this export.
    await tx.insert(renders).values({ projectId, status: 'pending' }).onConflictDoNothing();

    const [job] = await tx
      .insert(providerJobs)
      .values({
        projectId,
        kind: 'render',
        provider: env.renderProvider,
        status: 'pending',
        attempts: renderAttempt,
        idempotencyKey: key,
        payload: { composition },
      })
      .returning({ id: providerJobs.id });

    await placeHold(tx, {
      userId: project.userId,
      projectId,
      stage: 'render',
      credits: price,
      jobId: job.id,
    });

    return { jobId: job.id, status: 'enqueued' as const, renderAttempt };
  });
}

/**
 * Latest render status + output_url for a project (web editor polls/downloads).
 * `output_url` is normally a storage KEY → re-signed FRESH to a SAME-ORIGIN
 * `/files` URL here (cross-origin `<video>` is blocked by Brave; see Gotcha #13)
 * so the done screen plays + downloads the final cut in-app. A legacy absolute
 * URL (old rows that stored a presigned R2 URL) is passed through unchanged.
 */
export async function getProjectRender(
  db: AnyDb,
  projectId: string,
): Promise<RenderStatusDto | null> {
  const rows = await db
    .select({ status: renders.status, outputUrl: renders.outputUrl, createdAt: renders.createdAt })
    .from(renders)
    .where(eq(renders.projectId, projectId))
    .orderBy(renders.createdAt);
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  return {
    status: latest.status,
    outputUrl: latest.outputUrl ? renderEditorUrl(latest.outputUrl) : latest.outputUrl,
  } as RenderStatusDto;
}

/** Render-stage credit cost estimate (bounded per_export), for the UI. */
export async function renderStageCost(db: AnyDb): Promise<number> {
  return stageHoldCredits(db, 'render', 1);
}

/**
 * ALL of a project's clips (in frame idx order) for the editor (C2) — completed,
 * failed, animating, and pending — each with its real status + idx, so the editor
 * can render a failure state + re-animate button (not just play completed clips).
 * For a completed clip, `video_url` (a storage KEY) is re-signed FRESH to a
 * same-origin /files URL (legacy absolute URLs pass through); a non-completed clip
 * has videoUrl=null (nothing to play yet). buildComposition stays completed-only —
 * export must never include an unready clip.
 */
export async function getProjectClips(db: AnyDb, projectId: string): Promise<ClipViewDto[]> {
  const rows = await db
    .select({
      id: clips.id,
      sourceFrameId: clips.frameId,
      idx: clips.orderIdx,
      videoUrl: clips.videoUrl,
      durationSeconds: clips.durationSeconds,
      status: clips.status,
      trimStartFrame: clips.trimStartFrame,
      trimEndFrame: clips.trimEndFrame,
      script: clips.script,
    })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(frames.projectId, projectId))
    // Clip-composer: order by the clip's own order_idx (single source of truth),
    // NOT frames.idx — a frame may back multiple clips, so frame idx is no longer
    // a valid clip order.
    .orderBy(clips.orderIdx);
  // ALL clips in frame order (C2): the editor must SEE a failed/in-flight clip to
  // surface a failure state + the re-animate button — not just completed ones.
  // A completed clip carries a same-origin video URL + persisted trims; any other
  // status carries videoUrl:null. (buildComposition stays completed-only — export
  // must never include an unready clip.)
  return Promise.all(
    rows.map(
      async (r: {
        id: string;
        sourceFrameId: string;
        idx: number;
        videoUrl: string | null;
        durationSeconds: number | null;
        status: string;
        trimStartFrame: number | null;
        trimEndFrame: number | null;
        script: string;
      }) => ({
        id: r.id,
        // Backing shot id — lets the composer restore the chosen frame per beat.
        sourceFrameId: r.sourceFrameId,
        // Clip-composer: `idx` is the clip's order_idx (its position in the
        // composition), the single source of truth for editor/export order.
        idx: r.idx,
        script: r.script,
        // Completed + has a stored ref → SAME-ORIGIN `/files` stream (cross-origin
        // <video> is blocked by Brave). Otherwise null (nothing to play yet).
        videoUrl: r.status === 'completed' && r.videoUrl ? clipEditorUrl(r.videoUrl) : null,
        // Map the DB clip status to the editor-facing status (processing, the
        // in-flight animation job, surfaces as 'animating').
        status: toClipViewStatus(r.status),
        // Real clip length → frames at the editor's 30fps. Omit when unknown so
        // the client falls back to probing the loaded video.
        ...(r.durationSeconds != null
          ? { durationInFrames: Math.round(r.durationSeconds * CLIP_FPS) }
          : {}),
        // Persisted editor in/out trim (B1) — re-applied on reload. Null until
        // the user (or the one-shot auto-trim) has trimmed this clip.
        trimStartFrame: r.trimStartFrame,
        trimEndFrame: r.trimEndFrame,
      }),
    ),
  );
}

/**
 * Map a DB clip status (`clip_status` enum) to the editor-facing ClipViewStatus.
 * The DB `processing` (animation job in flight) surfaces as `animating`; the
 * others map 1:1.
 */
function toClipViewStatus(status: string): 'pending' | 'animating' | 'completed' | 'failed' {
  switch (status) {
    case 'processing':
      return 'animating';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/**
 * Persist the editor's per-clip trims (B1). Updates each addressed clip's
 * trim_start_frame/trim_end_frame and flips projects.auto_trimmed=true the first
 * time the editor saves (so the one-shot auto-trim never re-runs over a manual
 * edit). Ownership is enforced by scoping the clip update to the project's clips
 * (clip → frame → project). Idempotent: re-saving the same values is a no-op for
 * auto_trimmed once it is already true. All writes happen in one transaction.
 */
export async function saveProjectTrims(
  db: AnyDb,
  args: {
    caller: AuthContext;
    projectId: string;
    // Body contract (SaveTrimDto): startFrame/endFrame → written to the matching
    // clips.trim_start_frame/trim_end_frame columns (the column names differ from
    // the wire field names; the read side surfaces them as trimStartFrame/End).
    trims: { clipId: string; startFrame: number; endFrame: number }[];
  },
): Promise<{ saved: number; autoTrimmed: boolean }> {
  const { caller, projectId, trims } = args;

  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  // The set of clip ids that belong to THIS project (clip → frame → project),
  // so a trim payload can never target another project's clip.
  const ownClipRows = await db
    .select({ id: clips.id })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(frames.projectId, projectId));
  const ownClipIds = new Set(ownClipRows.map((r: { id: string }) => r.id));

  return db.transaction(async (tx: AnyDb) => {
    let saved = 0;
    for (const trim of trims) {
      if (!ownClipIds.has(trim.clipId)) continue; // ignore foreign/unknown ids
      await tx
        .update(clips)
        .set({ trimStartFrame: trim.startFrame, trimEndFrame: trim.endFrame })
        .where(eq(clips.id, trim.clipId));
      saved += 1;
    }

    // First save flips auto_trimmed so the editor's one-shot auto-trim runs once.
    if (!project.autoTrimmed) {
      await tx
        .update(projects)
        .set({ autoTrimmed: true, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
    }

    return { saved, autoTrimmed: true };
  });
}

/**
 * Re-open a finished project for another edit pass (done-screen "re-edit").
 * Transitions a `rendered` project back to `editing` (FSM-guarded) so the editor
 * loads with persisted trims/clips and the user can re-export — the re-export
 * bumps render_attempt (A1) to produce a NEW render. Idempotent: already in
 * `editing` (or `clips_ready`) → no-op, returns current status. A pure state
 * transition: NO credit side-effects (the render hold is placed at /export).
 */
export async function reopenProject(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; status: 'editing' | 'clips_ready' }> {
  const { caller, projectId } = args;
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  // Already editable → no-op (idempotent re-open).
  if (project.status === 'editing' || project.status === 'clips_ready') {
    return { id: projectId, status: project.status };
  }
  if (project.status !== 'rendered') {
    throw new InvalidStateError(
      `reopen requires project in 'rendered' (or already editable), but it is '${project.status}'`,
    );
  }
  if (!canTransition('rendered', 'editing')) {
    throw new InvalidStateError('rendered → editing is not a legal transition');
  }
  await db
    .update(projects)
    .set({ status: 'editing', updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  return { id: projectId, status: 'editing' };
}

// --- production wiring (implements the service's RenderStagePort) ---------

export function createDbRenderStage(db: AnyDb = defaultDb): RenderStagePort {
  return {
    export: ({ caller, projectId, trims, clips }) =>
      enqueueExport(db, { caller, projectId, trims, clips }),
    render: (projectId) => getProjectRender(db, projectId),
    cost: () => renderStageCost(db),
    clips: (projectId) => getProjectClips(db, projectId),
    saveTrims: (args) => saveProjectTrims(db, args),
    reopen: (args) => reopenProject(db, args),
  };
}

export { CLIP_URL_TTL_SECONDS };
