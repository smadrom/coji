/**
 * @coji/shared — types and contracts shared between the API and the web client.
 *
 * Provider seam interfaces live here (P0.5) so both the API runtime and tests
 * import the same contract; the Eden treaty client (./client) re-exports the
 * API's `App` type for end-to-end type safety with no codegen.
 */

/** Project lifecycle states (mirrors the persisted FSM). */
export const PROJECT_STATUSES = [
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

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Provider-job kinds driven by the unified runner. */
export const JOB_KINDS = ['image', 'animation', 'render'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// Output video format (9:16). Lives in the ./video LEAF module so the web bundle
// can import it without dragging in the Node-only provider graph; re-exported
// here for convenience of root (api/runtime) importers.
export * from './video.ts';

// Provider seam contracts + CI-default fakes.
export * from './providers/index.ts';
