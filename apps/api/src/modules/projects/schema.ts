import { JOB_KINDS, PROJECT_STATUSES } from '@coji/shared';
/**
 * TypeBox schemas for the projects data model (P0.3).
 *
 * Single source of truth for route validation, OpenAPI, and MCP tool shapes.
 * Enum literal unions are kept in lock-step with the same `@coji/shared` value
 * lists that back the Drizzle pgEnums (asserted below), so the DB, the API
 * contract, and the FSM never drift.
 *
 * NOTE: the literal members are spelled out explicitly (not built via
 * `LIST.map(t.Literal)`) because Elysia/TypeBox loses the literal types through
 * `.map()` — the inferred `status` collapses to `never`, which then breaks
 * route `response` typing. The compile-time `satisfies` + the runtime assert
 * below guarantee these stay identical to the shared source of truth.
 */
import { type Static, t } from 'elysia';

// --- Enum unions ---------------------------------------------------------

const PROJECT_STATUS_LITERALS = [
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
] as const satisfies readonly (typeof PROJECT_STATUSES)[number][];

const JOB_KIND_LITERALS = [
  'image',
  'animation',
  'render',
] as const satisfies readonly (typeof JOB_KINDS)[number][];

// Drift guard: the explicit literal lists must match the shared source exactly.
if (
  PROJECT_STATUS_LITERALS.length !== PROJECT_STATUSES.length ||
  !PROJECT_STATUS_LITERALS.every((s, i) => s === PROJECT_STATUSES[i])
) {
  throw new Error('ProjectStatus literals drifted from @coji/shared PROJECT_STATUSES');
}
if (
  JOB_KIND_LITERALS.length !== JOB_KINDS.length ||
  !JOB_KIND_LITERALS.every((k, i) => k === JOB_KINDS[i])
) {
  throw new Error('JobKind literals drifted from @coji/shared JOB_KINDS');
}

export const ProjectStatusSchema = t.Union([
  t.Literal('draft'),
  t.Literal('images_ready'),
  t.Literal('awaiting_decision'),
  t.Literal('composing'),
  t.Literal('animating'),
  t.Literal('clips_ready'),
  t.Literal('editing'),
  t.Literal('rendered'),
  t.Literal('cancelled'),
  t.Literal('failed'),
]);
export const AudioModeSchema = t.Union([t.Literal('tts'), t.Literal('audio_url')]);
export const JobKindSchema = t.Union([
  t.Literal('image'),
  t.Literal('animation'),
  t.Literal('render'),
]);
export const JobStatusSchema = t.Union([
  t.Literal('pending'),
  t.Literal('processing'),
  t.Literal('completed'),
  t.Literal('failed'),
]);
export const ChildStatusSchema = JobStatusSchema; // frames/clips/renders share the lifecycle
export const StageSchema = t.Union([
  t.Literal('image'),
  t.Literal('animation'),
  t.Literal('render'),
]);
export const StagePriceUnitSchema = t.Union([
  t.Literal('per_set'),
  t.Literal('per_clip'),
  t.Literal('per_export'),
]);
export const LedgerKindSchema = t.Union([
  t.Literal('hold'),
  t.Literal('debit'),
  t.Literal('refund'),
  t.Literal('topup'),
]);

// --- Entity schemas ------------------------------------------------------

export const ProjectSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  userId: t.String(),
  prompt: t.String(),
  status: ProjectStatusSchema,
  audioMode: AudioModeSchema,
  script: t.Union([t.String(), t.Null()]),
  voiceId: t.Union([t.String(), t.Null()]),
  audioUrl: t.Union([t.String(), t.Null()]),
  // Style/locale (avatars-voices phase). Plain strings here (validated against
  // @coji/shared/style on create); the DB stores them as defaulted text.
  style: t.String(),
  locale: t.String(),
  gender: t.String(),
  creditsSpent: t.Integer(),
  renderAttempt: t.Integer(),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});
export type ProjectDto = Static<typeof ProjectSchema>;

export const FrameSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  projectId: t.String({ format: 'uuid' }),
  idx: t.Integer({ minimum: 0, maximum: 3 }),
  imageRef: t.Union([t.String(), t.Null()]),
  caption: t.Union([t.String(), t.Null()]),
  status: ChildStatusSchema,
  createdAt: t.String({ format: 'date-time' }),
});
export type FrameDto = Static<typeof FrameSchema>;

/** Per-frame progress entry returned alongside a project (web client polls this). */
export const FrameProgressSchema = t.Object({
  // Frame DB id — the composer needs it to identify which shot backs a clip
  // (clips.frame_id). Optional so in-memory test fakes that omit it still pass.
  id: t.Optional(t.String({ format: 'uuid' })),
  idx: t.Integer({ minimum: 0, maximum: 3 }),
  status: ChildStatusSchema,
  imageRef: t.Union([t.String(), t.Null()]),
  caption: t.Union([t.String(), t.Null()]),
  // Browser-loadable signed URL for the frame image (null until generated).
  signedUrl: t.Optional(t.Union([t.String(), t.Null()])),
});
export type FrameProgressDto = Static<typeof FrameProgressSchema>;

/**
 * Lifecycle a clip can surface in the editor. Adds `animating` (the clip's
 * re-animation job is in flight, C2) on top of the shared child lifecycle so the
 * editor can show a per-clip spinner / failed state distinct from "completed".
 */
export const ClipViewStatusSchema = t.Union([
  t.Literal('pending'),
  t.Literal('animating'),
  t.Literal('completed'),
  t.Literal('failed'),
]);
export type ClipViewStatusDto = Static<typeof ClipViewStatusSchema>;

/**
 * A clip surfaced on the project view for the editor. `videoUrl` is a
 * browser-loadable URL (same-origin `/files/<key>` for re-hosted clips, or the
 * provider's CDN URL for legacy HeyGen clips). `idx` mirrors the source frame so
 * clips stay in storyboard order. `status` lets the editor surface a failed clip
 * (C2) and offer re-animate. `trimStartFrame`/`trimEndFrame` are the persisted
 * editor in/out trim (frames at the editor's 30fps); absent until trimmed.
 */
export const ClipViewSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  // The backing frame (shot) id — clip-composer needs it so a reloaded draft
  // restores the chosen shot per beat (a frame may back multiple clips).
  sourceFrameId: t.Optional(t.String({ format: 'uuid' })),
  // Clip-composer: `idx` is the clip's order_idx (position in the composition),
  // no longer the source frame's 0–3 idx — a project can hold up to
  // MAX_CLIPS_PER_PROJECT clips, so this is an unbounded-above non-negative int.
  idx: t.Integer({ minimum: 0 }),
  // Nullable for C2: a failed/animating/pending clip has no video yet, but the
  // editor still surfaces it (with status) to offer "re-animate".
  videoUrl: t.Union([t.String(), t.Null()]),
  durationInFrames: t.Optional(t.Integer()),
  // Lead-locked contract: status is REQUIRED so the editor can always branch on
  // completed | failed | pending | animating without a fallback.
  status: ClipViewStatusSchema,
  trimStartFrame: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
  trimEndFrame: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
  // Per-clip VO line (clip-composer). '' for legacy 4-clip rows; surfaced so the
  // composer/editor can show and edit the beat's spoken text.
  script: t.String(),
});
export type ClipViewDto = Static<typeof ClipViewSchema>;

// --- Clip composer (decouple clips from frames) --------------------------

/**
 * Upper bound on clips a single project may compose/animate. Bounds the N-hold
 * transaction size + abuse; validated at the composer (WS3) and at animate (WS4).
 * Single source — imported by the composer service, animation stage, and web.
 */
export const MAX_CLIPS_PER_PROJECT = 20;

/**
 * One authored beat in a project's composition (clip-composer). A clip is a
 * `{ frame, line, order }` unit; `sourceFrameId` is the reusable image source
 * (must be one of the project's frames), `script` is the beat's VO line, and
 * `orderIdx` is its position. `clipId` is present for an existing clip (edit)
 * and absent for a new beat (the service mints the id).
 */
export const ClipComposerEntry = t.Object({
  clipId: t.Optional(t.String({ format: 'uuid' })),
  sourceFrameId: t.String({ format: 'uuid' }),
  script: t.String(),
  orderIdx: t.Integer({ minimum: 0 }),
});
export type ClipComposerEntryDto = Static<typeof ClipComposerEntry>;

/**
 * Body for the composer's replace-composition route (WS3): the full ordered clip
 * list. Bounded by MAX_CLIPS_PER_PROJECT; an empty list clears the composition.
 */
export const ComposeBodySchema = t.Object({
  clips: t.Array(ClipComposerEntry, { maxItems: MAX_CLIPS_PER_PROJECT }),
});
export type ComposeBodyDto = Static<typeof ComposeBodySchema>;

/**
 * Project read model: the project + its frame progress + the image-stage credit
 * cost estimate the UI shows before triggering generation.
 *
 * Declared as a flat object (not t.Composite) — composing an object whose
 * `status` is a literal-union with another object mis-infers `status` to `never`
 * under Elysia's response typing, which breaks the handler return type.
 */

/**
 * One parsed scene from a storyboard-mode input. `suggestedFrameIdx` (0–3) is
 * the LLM-assigned keyframe that best fits this scene visually.
 */
export const ParsedSceneSchema = t.Object({
  idx: t.Integer({ minimum: 0 }),
  time: t.String(),
  voLine: t.String(),
  avatarAction: t.String(),
  suggestedFrameIdx: t.Integer({ minimum: 0, maximum: 3 }),
});
export type ParsedSceneDto = Static<typeof ParsedSceneSchema>;

export const ProjectViewSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  userId: t.String(),
  prompt: t.String(),
  status: ProjectStatusSchema,
  audioMode: AudioModeSchema,
  script: t.Union([t.String(), t.Null()]),
  voiceId: t.Union([t.String(), t.Null()]),
  audioUrl: t.Union([t.String(), t.Null()]),
  style: t.String(),
  locale: t.String(),
  gender: t.String(),
  creditsSpent: t.Integer(),
  renderAttempt: t.Integer(),
  // True once the editor's one-shot auto-trim pass has run for this project, so
  // the UI never re-applies it over manual trims (B1 / lead-locked contract).
  autoTrimmed: t.Boolean(),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
  frames: t.Array(FrameProgressSchema),
  imageStageCost: t.Integer(),
  // Completed animation clips (browser-loadable video URLs) for the editor.
  // Present once the animation stage has produced at least one clip.
  clips: t.Optional(t.Array(ClipViewSchema)),
  // Latest render status + output URL (null until an export has been run).
  render: t.Optional(
    t.Union([
      t.Object({ status: ChildStatusSchema, outputUrl: t.Union([t.String(), t.Null()]) }),
      t.Null(),
    ]),
  ),
  // Parsed storyboard scenes (storyboard input mode). Present when the project
  // was created from a structured storyboard; used by the Composer to pre-fill
  // beats with VO lines + suggested frame assignments.
  storyboardScenes: t.Optional(t.Union([t.Array(ParsedSceneSchema), t.Null()])),
  // Image quality mode: 'draft' (cheap/fast) | 'max' (best quality).
  quality: t.Optional(t.Union([t.Literal('draft'), t.Literal('max')])),
});
export type ProjectViewDto = Static<typeof ProjectViewSchema>;

/**
 * Gallery list item — a lightweight projection of a project the caller owns.
 * `previewUrl` is a browser-loadable signed URL for the first stored frame
 * (null until images exist / when storage signing is unavailable).
 */
export const ProjectListItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: ProjectStatusSchema,
  prompt: t.String(),
  createdAt: t.String({ format: 'date-time' }),
  previewUrl: t.Optional(t.Union([t.String(), t.Null()])),
  creditsSpent: t.Integer(),
});
export type ProjectListItemDto = Static<typeof ProjectListItemSchema>;

/** GET /projects response — the caller's projects, newest first. */
export const ProjectListSchema = t.Array(ProjectListItemSchema);
export type ProjectListDto = Static<typeof ProjectListSchema>;

/** 202 response for an accepted async image-generation request. */
export const GenerateImagesResponseSchema = t.Object({
  jobId: t.String({ format: 'uuid' }),
  status: t.Union([t.Literal('enqueued'), t.Literal('already_enqueued')]),
  projectStatus: ProjectStatusSchema,
});
export type GenerateImagesResponseDto = Static<typeof GenerateImagesResponseSchema>;

// --- Preview gate (P2 / task #15) ----------------------------------------

/** Camera settings overrides for one frame (all optional). */
export const CameraSettingsSchema = t.Object({
  distance: t.Optional(t.Union([t.Literal('closeup'), t.Literal('medium'), t.Literal('wide')])),
  angle: t.Optional(
    t.Union([t.Literal('eye'), t.Literal('low'), t.Literal('high'), t.Literal('dutch')]),
  ),
  height: t.Optional(t.Union([t.Literal('low'), t.Literal('eye'), t.Literal('high')])),
  lens: t.Optional(t.Union([t.Literal('wide'), t.Literal('normal'), t.Literal('tele')])),
});

/** One frame's shot: a preset id + optional camera + optional action. */
export const FrameShotSchema = t.Object({
  preset: t.String({ minLength: 1 }),
  camera: t.Optional(CameraSettingsSchema),
  action: t.Optional(t.Union([t.String(), t.Null()])),
});

/** Storyboard: assistant toggle + per-frame shots. */
export const StoryboardSchema = t.Object({
  assistant: t.Boolean(),
  frames: t.Array(FrameShotSchema, { minItems: 1, maxItems: 8 }),
});
export type StoryboardDto = Static<typeof StoryboardSchema>;

/** Body for POST /projects/:id/retry — optional modified prompt + storyboard. */
export const RetryBodySchema = t.Object({
  prompt: t.Optional(t.String({ minLength: 1 })),
  storyboard: t.Optional(StoryboardSchema),
});
export type RetryBodyDto = Static<typeof RetryBodySchema>;

/** Result of cancel/continue/preview-load — the project's new status. */
export const TransitionResponseSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: ProjectStatusSchema,
});
export type TransitionResponseDto = Static<typeof TransitionResponseSchema>;

/** Result of POST /projects/:id/retry — a fresh image job was enqueued. */
export const RetryResponseSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: ProjectStatusSchema,
  jobId: t.String({ format: 'uuid' }),
  attempt: t.Integer(),
});
export type RetryResponseDto = Static<typeof RetryResponseSchema>;

/**
 * Result of POST /projects/:id/continue → animating. Carries the animation
 * credit estimate (bounded per_clip × 4) the UI shows on the Continue button.
 */
export const ContinueResponseSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  status: ProjectStatusSchema,
  animationCreditEstimate: t.Integer(),
});
export type ContinueResponseDto = Static<typeof ContinueResponseSchema>;

// --- Export / render (P4 / task #20) -------------------------------------

/**
 * Per-clip in/out trim (frames at the editor's 30fps), ordered to match the
 * project's completed clips (idx order). Sent by the editor on export so the
 * final render reflects the timeline trims (incl. auto-trim to speech).
 */
export const ClipTrimSchema = t.Object({
  startFrom: t.Integer({ minimum: 0 }),
  endAt: t.Integer({ minimum: 1 }),
});
export type ClipTrimDto = Static<typeof ClipTrimSchema>;

/**
 * One entry in an explicit, ordered export clip selection (E1 reorder/delete).
 * Addresses a clip by id (not idx) and gives the RENDER ORDER by array position;
 * clips omitted from the array are EXCLUDED from the render. Optional per-clip
 * `startFrom`/`endAt` (frames) override the persisted trim; when both are absent
 * the persisted trim (or full clip) is used. Non-completed/unknown ids are
 * skipped server-side.
 */
export const ExportClipSchema = t.Object({
  clipId: t.String({ format: 'uuid' }),
  startFrom: t.Optional(t.Integer({ minimum: 0 })),
  endAt: t.Optional(t.Integer({ minimum: 1 })),
});
export type ExportClipDto = Static<typeof ExportClipSchema>;

/**
 * Optional body for POST /:id/export.
 *   - `clips`: explicit ORDERED selection (E1) — render exactly these clip ids in
 *     this order; omitted clips are excluded. Takes precedence over `trims`.
 *   - `trims`: legacy positional per-clip trims, zipped to the completed clips in
 *     idx order (back-compat; superseded by `clips` when both are sent).
 */
export const ExportBodySchema = t.Object({
  clips: t.Optional(t.Array(ExportClipSchema)),
  trims: t.Optional(t.Array(ClipTrimSchema)),
});
export type ExportBodyDto = Static<typeof ExportBodySchema>;

/**
 * One persisted editor trim, addressed by clip id (not idx) so reorder/delete
 * never mis-targets a clip. Frames are at the editor's 30fps timeline.
 */
export const SaveTrimSchema = t.Object({
  clipId: t.String({ format: 'uuid' }),
  startFrame: t.Integer({ minimum: 0 }),
  endFrame: t.Integer({ minimum: 1 }),
});
export type SaveTrimDto = Static<typeof SaveTrimSchema>;

/**
 * Body for the B1 save route (persist editor trims). Empty array clears all
 * trims for the project's clips. Each entry updates one clip's
 * trim_start_frame/trim_end_frame.
 */
export const SaveTrimsBodySchema = t.Object({
  trims: t.Array(SaveTrimSchema),
});
export type SaveTrimsBodyDto = Static<typeof SaveTrimsBodySchema>;

/** 202 response for an accepted async export (render) request. */
export const ExportResponseSchema = t.Object({
  jobId: t.String({ format: 'uuid' }),
  status: t.Union([t.Literal('enqueued'), t.Literal('already_enqueued')]),
  renderAttempt: t.Integer(),
});
export type ExportResponseDto = Static<typeof ExportResponseSchema>;

/**
 * Latest render status + output URL, surfaced on the project view for polling.
 * As of A2, `outputUrl` is a SAME-ORIGIN `/files/<key>` URL (the render output is
 * stored as a storage key and served same-origin) so the browser can inline the
 * final video and download it without a cross-origin/expiry hit. Shape unchanged.
 */
export const RenderStatusSchema = t.Object({
  status: ChildStatusSchema,
  outputUrl: t.Union([t.String(), t.Null()]),
});
export type RenderStatusDto = Static<typeof RenderStatusSchema>;

// --- Voices (D1) ---------------------------------------------------------

/**
 * A TTS voice the user can pick on /new. `id` is the provider voice id persisted
 * to projects.voice_id. `previewUrl` is a browser-loadable sample (may be absent
 * for some voices / providers).
 */
export const VoiceSchema = t.Object({
  id: t.String(),
  name: t.String(),
  locale: t.String(),
  gender: t.Optional(t.String()),
  previewUrl: t.Optional(t.String()),
});
export type VoiceDto = Static<typeof VoiceSchema>;

/** GET /v2/voices response — the available voices (cached upstream). */
export const VoiceListSchema = t.Array(VoiceSchema);
export type VoiceListDto = Static<typeof VoiceListSchema>;

export const ClipSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  frameId: t.String({ format: 'uuid' }),
  heygenVideoId: t.Union([t.String(), t.Null()]),
  videoUrl: t.Union([t.String(), t.Null()]),
  durationSeconds: t.Union([t.Number(), t.Null()]),
  status: ChildStatusSchema,
  attempt: t.Integer(),
  createdAt: t.String({ format: 'date-time' }),
});
export type ClipDto = Static<typeof ClipSchema>;

export const RenderSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  projectId: t.String({ format: 'uuid' }),
  outputUrl: t.Union([t.String(), t.Null()]),
  status: ChildStatusSchema,
  createdAt: t.String({ format: 'date-time' }),
});
export type RenderDto = Static<typeof RenderSchema>;

export const ProviderJobSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  projectId: t.String({ format: 'uuid' }),
  kind: JobKindSchema,
  provider: t.String(),
  externalId: t.Union([t.String(), t.Null()]),
  status: JobStatusSchema,
  attempts: t.Integer(),
  idempotencyKey: t.String(),
  payload: t.Record(t.String(), t.Unknown()),
  result: t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
  claimedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  claimedBy: t.Union([t.String(), t.Null()]),
  leaseExpiresAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});
export type ProviderJobDto = Static<typeof ProviderJobSchema>;

export const StagePriceSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  stage: StageSchema,
  unit: StagePriceUnitSchema,
  credits: t.Integer(),
  notes: t.Union([t.String(), t.Null()]),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});
export type StagePriceDto = Static<typeof StagePriceSchema>;

export const CreditLedgerEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  userId: t.String(),
  projectId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  stage: t.Union([t.String(), t.Null()]),
  kind: LedgerKindSchema,
  credits: t.Integer(),
  balanceAfter: t.Integer(),
  providerJobId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  createdAt: t.String({ format: 'date-time' }),
});
export type CreditLedgerEntryDto = Static<typeof CreditLedgerEntrySchema>;
