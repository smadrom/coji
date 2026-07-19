/**
 * Stage → project-FSM transition policy (pure).
 *
 * Given the job kind, the result status, and how many sibling jobs of the same
 * stage are still outstanding, decide the project's next FSM state (or none —
 * stay put while siblings finish). applyJobResult applies the returned state
 * through the FSM guard inside its transaction.
 *
 * Mapping (P0 happy path; partial-failure detail is exercised in P3):
 *   image  success → images_ready ; failure → failed
 *   animation: advance once every clip is SETTLED (completed or terminally
 *             failed) — i.e. no clip is still in flight. clips_ready when at
 *             least one clip succeeded; failed when all clips failed. A single
 *             terminally-failed clip (e.g. a face-less shot HeyGen's avatar_iv
 *             can't animate) must NOT strand the project on the animating
 *             spinner — the editor/render works with the clips that succeeded.
 *   render success → rendered ; failure → editing (user can re-export) — kept as
 *             `editing` so a failed export does not strand the project.
 */
import type { ProjectState } from '../projects/fsm.ts';

export type JobKind = 'image' | 'animation' | 'render';
export type ResultStatus = 'completed' | 'failed';

export interface TransitionContext {
  kind: JobKind;
  result: ResultStatus;
  /** Sibling jobs of the same stage still in flight (pending/processing). */
  outstandingSiblings: number;
  /** Sibling jobs of the same stage that ended terminally failed. */
  failedSiblings: number;
  /** Sibling jobs of the same stage that completed successfully. */
  completedSiblings: number;
}

/**
 * Returns the next project state, or `null` to leave the project unchanged
 * (e.g. one of N animation clips finished but others are still running).
 *
 * The animation policy is clip-count agnostic: `clips_ready` is reached when
 * EVERY clip of the project is terminal (completed | failed) for arbitrary N,
 * driven purely by the sibling counters — never a hard-coded 4.
 */
export function resolveProjectTransition(ctx: TransitionContext): ProjectState | null {
  switch (ctx.kind) {
    case 'image':
      return ctx.result === 'completed' ? 'images_ready' : 'failed';

    case 'animation':
      // Stay in `animating` while any clip is still in flight (whether this one
      // succeeded or failed — its siblings may still complete).
      if (ctx.outstandingSiblings > 0) return null;
      // All clips are settled: advance to `clips_ready` if at least one
      // succeeded; if every clip failed, the whole stage failed. This keeps a
      // single terminally-failed clip from stranding the project on the spinner.
      return ctx.completedSiblings > 0 ? 'clips_ready' : 'failed';

    case 'render':
      return ctx.result === 'completed' ? 'rendered' : 'editing';
  }
}
