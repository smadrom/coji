/**
 * Composer-stage wiring (clip-composer / WS3).
 *
 * The composition is the user-authored clip list that decouples clips from
 * frames: a clip is a `{ frame, line, order }` beat, and a frame (one of the
 * project's 4 poses) is a REUSABLE image source — several clips may reference the
 * same frame. This module is the CRUD seam for that list:
 *
 *   - getComposition: the project's clips in order_idx order (ClipViewDto[],
 *     same shape the editor reads), so the composer screen and the editor share
 *     one read model.
 *   - setComposition: REPLACE the whole list. Each entry's `sourceFrameId` must
 *     be one of the project's frames (else 422); order_idx is assigned by array
 *     position; the list is capped at MAX_CLIPS_PER_PROJECT. Existing clips are
 *     updated in place by id (preserving any video/trim), new beats are inserted,
 *     and clips no longer in the list are deleted — all in ONE transaction.
 *   - continueToComposing: awaiting_decision → composing (FSM-guarded), the
 *     gateway from the preview gate into the composer.
 *
 * No paid work + no credit side-effects here (the holds are placed at animate,
 * WS4). Reusing clips.frame_id as the image source (no source_frame_id column);
 * the "1 clip per frame" rule is gone — reuse is the point.
 *
 * DB-bound; kept behind the same port style as the other stages so the HTTP
 * acceptance suite can inject a fake while production wires Drizzle.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.ts';
import { clips, frames, projects } from '../../db/tables.ts';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import { clipEditorUrl } from '../jobs/clip-storage.ts';
import { type ProjectState, canTransition } from './fsm.ts';
import { InvalidStateError } from './image-stage.ts';
import { MAX_CLIPS_PER_PROJECT } from './schema.ts';
import type { ClipComposerEntryDto, ClipViewDto } from './schema.ts';
import { ProjectNotFoundError } from './service.ts';

/** Editor/Remotion frame rate — clip durations are converted seconds → frames. */
const CLIP_FPS = 30;

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

/**
 * Validation failure for a malformed composition (foreign frame, over cap).
 * 422 — the request shape is valid TypeBox but semantically rejected.
 */
export class InvalidCompositionError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCompositionError';
  }
}

/**
 * Map a DB clip status (`clip_status` enum) to the editor-facing ClipViewStatus.
 * Mirrors render-stage.ts toClipViewStatus: `processing` (animation job in
 * flight) surfaces as `animating`; the rest map 1:1.
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
 * Read a project's composition (its clips in order_idx order) as ClipViewDto[] —
 * the SAME read model the editor consumes (see render-stage.getProjectClips), so
 * the composer and editor never drift on order/status/script. Ownership is the
 * caller's (asserted by the service before this is reached). A completed clip
 * carries a same-origin `/files` URL; any other status carries videoUrl=null.
 */
export async function getComposition(db: AnyDb, projectId: string): Promise<ClipViewDto[]> {
  const rows = await db
    .select({
      id: clips.id,
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
    // order_idx is the single source of truth for clip order (a frame may back
    // multiple clips, so frames.idx is no longer a valid clip order).
    .orderBy(clips.orderIdx);

  return rows.map(
    (r: {
      id: string;
      idx: number;
      videoUrl: string | null;
      durationSeconds: number | null;
      status: string;
      trimStartFrame: number | null;
      trimEndFrame: number | null;
      script: string;
    }) => ({
      id: r.id,
      idx: r.idx,
      script: r.script,
      videoUrl: r.status === 'completed' && r.videoUrl ? clipEditorUrl(r.videoUrl) : null,
      status: toClipViewStatus(r.status),
      ...(r.durationSeconds != null
        ? { durationInFrames: Math.round(r.durationSeconds * CLIP_FPS) }
        : {}),
      trimStartFrame: r.trimStartFrame,
      trimEndFrame: r.trimEndFrame,
    }),
  );
}

/**
 * REPLACE a project's composition with the given ordered entries. In ONE
 * transaction:
 *   1. validate cap (N ≤ MAX_CLIPS_PER_PROJECT) and that every entry's
 *      `sourceFrameId` is one of THIS project's frames (foreign/unknown → 422);
 *   2. assign order_idx by array position (the array IS the order);
 *   3. UPDATE existing clips in place by id (set frame_id + script + order_idx,
 *      preserving video/trim/status so an already-animated beat keeps its clip);
 *      INSERT new beats (no clipId) as pending; DELETE clips no longer present.
 *
 * No credit side-effects (holds are placed at animate, WS4). An empty list
 * clears the composition. A clipId not belonging to this project is treated as a
 * new beat would be — rejected: we only update ids that are the project's own
 * clips, so a foreign clipId is dropped (insert a fresh beat instead). Returns
 * the fresh composition (getComposition) so the caller has the minted ids.
 */
export async function setComposition(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string; entries: ClipComposerEntryDto[] },
): Promise<ClipViewDto[]> {
  const { caller, projectId, entries } = args;

  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  if (entries.length > MAX_CLIPS_PER_PROJECT) {
    throw new InvalidCompositionError(
      `composition exceeds the ${MAX_CLIPS_PER_PROJECT}-clip cap (got ${entries.length})`,
    );
  }

  // The project's frames — the valid set of image sources. Every entry's
  // sourceFrameId must be one of these (frame reuse is allowed; foreign is not).
  const frameRows = await db
    .select({ id: frames.id })
    .from(frames)
    .where(eq(frames.projectId, projectId));
  const ownFrameIds = new Set(frameRows.map((f: { id: string }) => f.id));
  for (const entry of entries) {
    if (!ownFrameIds.has(entry.sourceFrameId)) {
      throw new InvalidCompositionError(
        `sourceFrameId ${entry.sourceFrameId} is not a frame of project ${projectId}`,
      );
    }
  }

  return db.transaction(async (tx: AnyDb) => {
    // The project's existing clip ids (clip → frame → project), so an entry's
    // clipId can only update one of THIS project's clips (never a foreign one).
    const existingRows = await tx
      .select({ id: clips.id })
      .from(clips)
      .innerJoin(frames, eq(clips.frameId, frames.id))
      .where(eq(frames.projectId, projectId));
    const existingIds = new Set(existingRows.map((r: { id: string }) => r.id));

    // Walk the entries in array order: order_idx = position. Update an existing
    // own clip in place (preserve video/trim/status); insert a new beat as
    // pending. Track which existing ids survive so we can delete the rest.
    const keptIds = new Set<string>();
    for (const [orderIdx, entry] of entries.entries()) {
      if (entry.clipId && existingIds.has(entry.clipId)) {
        await tx
          .update(clips)
          .set({ frameId: entry.sourceFrameId, script: entry.script, orderIdx })
          .where(eq(clips.id, entry.clipId));
        keptIds.add(entry.clipId);
      } else {
        // New beat (no clipId, or a clipId that isn't this project's): insert a
        // pending clip. The animate stage (WS4) places the hold + job later.
        await tx.insert(clips).values({
          frameId: entry.sourceFrameId,
          script: entry.script,
          orderIdx,
          status: 'pending',
          attempt: 0,
        });
      }
    }

    // Delete the project's clips that are no longer in the composition.
    const toDelete = [...existingIds].filter((id) => !keptIds.has(id as string)) as string[];
    if (toDelete.length > 0) {
      await tx.delete(clips).where(inArray(clips.id, toDelete));
    }

    return getComposition(tx, projectId);
  });
}

/**
 * awaiting_decision → composing (the gateway from the preview gate into the
 * composer). FSM-guarded (409 on an illegal edge). Idempotent: already in
 * `composing` (or past it) → no-op, returns current status. NO credit side-
 * effects — the composer is free; holds are placed at animate (WS4).
 */
export async function continueToComposing(
  db: AnyDb,
  args: { caller: AuthContext; projectId: string },
): Promise<{ id: string; status: ProjectState }> {
  const { caller, projectId } = args;
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = projectRows[0];
  if (!project) throw new ProjectNotFoundError();
  assertOwner(project.userId, caller);

  const status = project.status as ProjectState;
  // Idempotent: already composing → no-op.
  if (status === 'composing') {
    return { id: projectId, status };
  }
  if (!canTransition(status, 'composing')) {
    throw new InvalidStateError(`${status} → composing is not a legal transition`);
  }
  await db
    .update(projects)
    .set({ status: 'composing', updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  return { id: projectId, status: 'composing' };
}

// --- port + production wiring --------------------------------------------

/**
 * Composer-stage port — DB-bound composition CRUD + the continue-to-composing
 * transition. Behind a port like the other stages so the HTTP acceptance suite
 * can inject a fake (zero DB) while production wires the Drizzle-backed impl.
 */
export interface ComposerStagePort {
  getComposition(args: { caller: AuthContext; projectId: string }): Promise<ClipViewDto[]>;
  setComposition(args: {
    caller: AuthContext;
    projectId: string;
    entries: ClipComposerEntryDto[];
  }): Promise<ClipViewDto[]>;
  continueToComposing(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: ProjectState }>;
}

export function createDbComposerStage(db: AnyDb = defaultDb): ComposerStagePort {
  return {
    getComposition: ({ projectId }) => getComposition(db, projectId),
    setComposition: (args) => setComposition(db, args),
    continueToComposing: (args) => continueToComposing(db, args),
  };
}
