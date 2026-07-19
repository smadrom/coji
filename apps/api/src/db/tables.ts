import { JOB_KINDS, PROJECT_STATUSES } from '@coji/shared';
import type { Storyboard } from '@coji/shared/storyboard';

interface ParsedScene {
  idx: number;
  time: string;
  voLine: string;
  avatarAction: string;
  suggestedFrameIdx: number;
}
/**
 * Drizzle table definitions — the coji-owned data model (P0.3).
 *
 * One module holds every table so drizzle-kit and the db client see a single
 * source of truth (re-exported by ./schema.ts). Mirrors the basalt/panx
 * conventions: defaultRandom uuid PKs, a shared `timestamps` helper with
 * `withTimezone`, jsonb `$type<>()` payloads, `references(onDelete)`, and
 * `index`/`uniqueIndex` declared in the table callback.
 *
 * Enum value lists are imported from `@coji/shared` where they already exist
 * (PROJECT_STATUSES, JOB_KINDS) so the FSM/runner and the DB never drift.
 *
 * NOTE on `user_id`: Better Auth is not yet scaffolded in coji, so there is no
 * `user` table to reference. `user_id` columns are therefore plain `text`
 * (no FK) for now; the FK to the auth `user` table should be added when auth
 * lands. This keeps the migration applyable today and matches the plan's
 * ownership model (projects.user_id == auth.userId, enforced in the route guard).
 */
import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

// ---------------------------------------------------------------------------
// Enums (Postgres native enums; value lists single-sourced from @coji/shared
// where they already exist).
// ---------------------------------------------------------------------------

/** Project lifecycle FSM states. */
export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);

/** Audio source for the HeyGen lip-sync stage (resolved at project level). */
export const audioModeEnum = pgEnum('audio_mode', ['tts', 'audio_url']);

/** Per-frame / clip / render lifecycle. */
export const frameStatusEnum = pgEnum('frame_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);
export const clipStatusEnum = pgEnum('clip_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);
export const renderStatusEnum = pgEnum('render_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

/** Provider-job kind (image | animation | render) — driven by the unified runner. */
export const jobKindEnum = pgEnum('job_kind', JOB_KINDS);

/** Provider-job lifecycle — mirrors HeyGen's status vocabulary (verified P0.2). */
export const jobStatusEnum = pgEnum('job_status', ['pending', 'processing', 'completed', 'failed']);

/** Pricing stage. */
export const stageEnum = pgEnum('stage', ['image', 'animation', 'render']);

/**
 * Pricing unit — BOUNDED units only for v1 (the exact hold is known before the
 * paid call). Usage-metered units (per_clip_second/per_output_minute) are
 * deferred per ADR-6.
 */
export const stagePriceUnitEnum = pgEnum('stage_price_unit', ['per_set', 'per_clip', 'per_export']);

/** Append-only credit-ledger entry kind. */
export const ledgerKindEnum = pgEnum('ledger_kind', ['hold', 'debit', 'refund', 'topup']);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A single user prompt = one Project, the FSM root.
 * `credits_spent` is a transactional rollup updated only inside applyJobResult
 * (P0.6), in the same txn as the ledger debit/refund.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    prompt: text('prompt').notNull(),
    status: projectStatusEnum('status').default('draft').notNull(),
    audioMode: audioModeEnum('audio_mode').default('tts').notNull(),
    script: text('script'),
    voiceId: text('voice_id'),
    audioUrl: text('audio_url'),
    // Style/locale (avatars-voices phase): style drives the person's look (image
    // preamble) + default voice; locale drives the VO/voice language. Plain text
    // (not pgEnum) so adding a style/locale needs no migration — values are
    // validated against @coji/shared/style at the edges.
    style: text('style').default('american').notNull(),
    locale: text('locale').default('en-US').notNull(),
    gender: text('gender').default('female').notNull(),
    // Storyboard config (assistant toggle + 4 shot presets/camera) for image gen.
    shotConfig: jsonb('shot_config').$type<Storyboard>(),
    // Parsed storyboard scenes (storyboard input mode). Stored at project create
    // so the Composer can pre-fill beats with VO lines + suggested frame indices.
    storyboardScenes: jsonb('storyboard_scenes').$type<ParsedScene[]>(),
    // Image quality mode: 'draft' = cheaper model, 'max' = best model.
    quality: text('quality').default('max').notNull(),
    creditsSpent: integer('credits_spent').default(0).notNull(),
    renderAttempt: integer('render_attempt').default(0).notNull(),
    // Editor auto-trim: true once the one-shot trim-to-speech pass has run for
    // this project, so re-opening the editor never re-applies it over manual edits.
    autoTrimmed: boolean('auto_trimmed').default(false).notNull(),
    ...timestamps,
  },
  (table) => [index('projects_user_id_idx').on(table.userId)],
);

/** Four frames per project (idx 0–3). `image_ref` is the object-storage KEY. */
export const frames = pgTable(
  'frames',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    imageRef: text('image_ref'),
    caption: text('caption'),
    status: frameStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('frames_project_id_idx').on(table.projectId),
    uniqueIndex('frames_project_idx_uidx').on(table.projectId, table.idx),
  ],
);

/**
 * A clip is a user-authored beat = `{ frame, line, order }` (clip-composer).
 * `frame_id` is the image source and is REUSABLE: there is no unique constraint
 * on it, so several clips can reference the same frame (one pose, many beats).
 * `video_url` is a signed/public URL.
 */
export const clips = pgTable(
  'clips',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    frameId: uuid('frame_id')
      .notNull()
      .references(() => frames.id, { onDelete: 'cascade' }),
    /**
     * Per-clip VO line spoken in this beat (clip-composer). Drives the HeyGen
     * TTS for this clip. Defaults to '' (legacy 4-clip rows backfilled to '').
     */
    script: text('script').default('').notNull(),
    /**
     * Explicit clip order within the project (clip-composer) — the SINGLE source
     * of truth for composer + editor + export + getProjectClips, replacing the
     * old reliance on frames.idx (invalid once a frame backs multiple clips).
     * Legacy rows backfilled to the source frame's idx.
     */
    orderIdx: integer('order_idx').default(0).notNull(),
    heygenVideoId: text('heygen_video_id'),
    videoUrl: text('video_url'),
    /** Real clip length in seconds (from HeyGen); drives the editor timeline. */
    durationSeconds: doublePrecision('duration_seconds'),
    /**
     * Editor in/out trim, in frames at the editor's timeline fps (30). Null
     * until the user (or the one-shot auto-trim) trims this clip. Persisted by
     * the B1 save route and re-applied to the composition + export.
     */
    trimStartFrame: integer('trim_start_frame'),
    trimEndFrame: integer('trim_end_frame'),
    status: clipStatusEnum('status').default('pending').notNull(),
    attempt: integer('attempt').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('clips_frame_id_idx').on(table.frameId),
    // Forward clip ordering: getProjectClips / composer read in order_idx order.
    index('clips_order_idx').on(table.orderIdx),
  ],
);

/**
 * Final composed render of a project. `output_url` is a durable storage KEY
 * (re-signed on read via renderEditorUrl), not a signed/public URL, as of A2.
 */
export const renders = pgTable(
  'renders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    outputUrl: text('output_url'),
    status: renderStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('renders_project_id_idx').on(table.projectId)],
);

/**
 * Every async provider call is a row here. Claimed by the unified runner with
 * `SELECT ... FOR UPDATE SKIP LOCKED` + a lease (claimed_at/claimed_by/
 * lease_expires_at). `idempotency_key` is unique per attempt:
 *   image     = project_id + ':' + attempt
 *   animation = frame_id   + ':' + attempt
 *   render    = project_id + ':' + render_attempt
 * `payload`/`result` are jsonb so the row is provider-shape-agnostic.
 */
export const providerJobs = pgTable(
  'provider_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: jobKindEnum('kind').notNull(),
    provider: text('provider').notNull(),
    externalId: text('external_id'),
    status: jobStatusEnum('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('provider_jobs_project_id_idx').on(table.projectId),
    // Runner claim scan: open rows by status + lease.
    index('provider_jobs_status_lease_idx').on(table.status, table.leaseExpiresAt),
  ],
);

/**
 * Retail credit pricing per stage, in BOUNDED units only (v1). Single source of
 * the credit amount held/debited per paid stage. `(stage, unit)` is unique.
 */
export const stagePrices = pgTable(
  'stage_prices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    stage: stageEnum('stage').notNull(),
    unit: stagePriceUnitEnum('unit').notNull(),
    credits: integer('credits').notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [uniqueIndex('stage_prices_stage_unit_uidx').on(table.stage, table.unit)],
);

/**
 * Append-only credit ledger. User balance = latest `balance_after`.
 * Settlement entries (debit/refund) are keyed to `provider_job_id` so a
 * double-apply is a no-op (P0.6). `topup`/`hold` may have no job.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    stage: text('stage'),
    kind: ledgerKindEnum('kind').notNull(),
    credits: integer('credits').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    providerJobId: uuid('provider_job_id').references(() => providerJobs.id, {
      onDelete: 'set null',
    }),
    /**
     * Idempotency key for payment-driven top-ups (the payment's idempotencyKey).
     * Unique when present → a replayed payment webhook never double-grants.
     * Null for job-driven entries (those use provider_job_id).
     */
    paymentRef: text('payment_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('credit_ledger_user_id_idx').on(table.userId),
    index('credit_ledger_project_id_idx').on(table.projectId),
    index('credit_ledger_provider_job_id_idx').on(table.providerJobId),
    // Idempotent settlement: at most one (debit|refund) per job.
    uniqueIndex('credit_ledger_job_kind_uidx').on(table.providerJobId, table.kind),
    // Idempotent top-up: at most one ledger entry per payment idempotency key.
    uniqueIndex('credit_ledger_payment_ref_uidx').on(table.paymentRef),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const projectsRelations = relations(projects, ({ many }) => ({
  frames: many(frames),
  renders: many(renders),
  providerJobs: many(providerJobs),
  ledgerEntries: many(creditLedger),
}));

export const framesRelations = relations(frames, ({ one, many }) => ({
  project: one(projects, { fields: [frames.projectId], references: [projects.id] }),
  clips: many(clips),
}));

export const clipsRelations = relations(clips, ({ one }) => ({
  frame: one(frames, { fields: [clips.frameId], references: [frames.id] }),
}));

export const rendersRelations = relations(renders, ({ one }) => ({
  project: one(projects, { fields: [renders.projectId], references: [projects.id] }),
}));

export const providerJobsRelations = relations(providerJobs, ({ one, many }) => ({
  project: one(projects, { fields: [providerJobs.projectId], references: [projects.id] }),
  ledgerEntries: many(creditLedger),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  project: one(projects, { fields: [creditLedger.projectId], references: [projects.id] }),
  providerJob: one(providerJobs, {
    fields: [creditLedger.providerJobId],
    references: [providerJobs.id],
  }),
}));

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Frame = typeof frames.$inferSelect;
export type NewFrame = typeof frames.$inferInsert;
export type Clip = typeof clips.$inferSelect;
export type NewClip = typeof clips.$inferInsert;
export type Render = typeof renders.$inferSelect;
export type NewRender = typeof renders.$inferInsert;
export type ProviderJob = typeof providerJobs.$inferSelect;
export type NewProviderJob = typeof providerJobs.$inferInsert;
export type StagePrice = typeof stagePrices.$inferSelect;
export type NewStagePrice = typeof stagePrices.$inferInsert;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;
