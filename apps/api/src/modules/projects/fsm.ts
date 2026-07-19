/**
 * Project lifecycle FSM — pure logic, no DB writes.
 *
 * States:
 *   draft → images_ready → awaiting_decision → composing → animating → clips_ready → editing → rendered
 *
 * Terminal states reachable from any in-flight state:
 *   cancelled  — user-initiated
 *   failed     — unrecoverable provider failure
 *
 * The transition table is the single source of truth.  The service layer calls
 * canTransition() for guards and assertTransition() when a bad transition should
 * throw.  No persistence happens here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PROJECT_STATES = [
  'draft',
  'images_ready',
  'awaiting_decision',
  'composing',
  'animating',
  'clips_ready',
  'editing',
  'rendered',
  'cancelled',
  'failed',
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

/** Terminal states — no further transitions are permitted. */
const TERMINAL_STATES = new Set<ProjectState>(['rendered', 'cancelled', 'failed']);

// ---------------------------------------------------------------------------
// Transition table
//
// Format: from → Set<to>
// Every pair NOT in this table is illegal.
// ---------------------------------------------------------------------------

const TRANSITIONS: ReadonlyMap<ProjectState, ReadonlySet<ProjectState>> = new Map([
  // Normal happy path
  ['draft', new Set<ProjectState>(['images_ready', 'cancelled', 'failed'])],
  ['images_ready', new Set<ProjectState>(['awaiting_decision', 'cancelled', 'failed'])],
  [
    'awaiting_decision',
    new Set<ProjectState>([
      'composing', // user hits Continue → author the clip composition (WS2)
      'animating', // legacy direct path (auto-seeded composition); kept for back-compat
      'images_ready', // user hits Retry (re-runs image stage)
      'cancelled',
      'failed',
    ]),
  ],
  // The composer (WS3/WS6) authors the N-clip list, then commits to the paid
  // animation stage. `composing` can also bounce back to image-correction
  // (images_ready) or be cancelled before any paid work.
  ['composing', new Set<ProjectState>(['animating', 'images_ready', 'cancelled', 'failed'])],
  ['animating', new Set<ProjectState>(['clips_ready', 'cancelled', 'failed'])],
  // clips_ready/editing → animating: re-animate a single failed/unsatisfactory
  // clip from the editor (C2). When that clip settles, the animation transition
  // policy returns the project to clips_ready (animating → clips_ready).
  ['clips_ready', new Set<ProjectState>(['editing', 'animating', 'cancelled', 'failed'])],
  ['editing', new Set<ProjectState>(['rendered', 'animating', 'cancelled', 'failed'])],
  // `rendered` is the happy-path end state (isTerminal stays true for UI/poll),
  // but the done screen can explicitly RE-OPEN it back to `editing` so the user
  // edits trims/clips and re-exports — no dead-end. The re-export bumps
  // render_attempt (A1) so a fresh render is produced. This is the ONLY outgoing
  // edge from rendered, and only via the explicit POST /:id/reopen.
  ['rendered', new Set<ProjectState>(['editing'])],
  ['cancelled', new Set<ProjectState>()],
  ['failed', new Set<ProjectState>()],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IllegalTransitionError {
  readonly kind: 'illegal_transition';
  readonly from: ProjectState;
  readonly to: ProjectState;
  readonly message: string;
}

/**
 * Returns true if transitioning from `from` to `to` is allowed.
 */
export function canTransition(from: ProjectState, to: ProjectState): boolean {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Asserts that the transition is legal.
 *
 * Throws an `Error` whose `cause` is an `IllegalTransitionError` value so
 * callers that need the structured data can access it without an instanceof
 * check on a custom class.
 *
 * @throws {Error} when the transition is illegal
 */
export function assertTransition(from: ProjectState, to: ProjectState): void {
  if (!canTransition(from, to)) {
    const detail: IllegalTransitionError = {
      kind: 'illegal_transition',
      from,
      to,
      message: `Illegal project state transition: ${from} → ${to}`,
    };
    const err = new Error(detail.message);
    (err as Error & { cause: IllegalTransitionError }).cause = detail;
    throw err;
  }
}

/**
 * Returns true when no further transitions are possible (state is terminal).
 */
export function isTerminal(state: ProjectState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Returns the set of states reachable from `from` in one step.
 * Useful for UI to show valid next actions.
 */
export function validNextStates(from: ProjectState): ReadonlySet<ProjectState> {
  return TRANSITIONS.get(from) ?? new Set();
}
