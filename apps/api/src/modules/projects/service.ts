/**
 * Projects service (P0.7).
 *
 * Business logic for creating and reading projects, sitting behind a small
 * `ProjectsRepository` port so it can run against Drizzle in production and an
 * in-memory fake in `app.handle` tests (keeping the HTTP-layer acceptance suite
 * CI-green with zero DB). The full DB-backed draft→rendered path is covered by
 * the gated jobs integration test (modules/jobs/jobs.db.test.ts).
 *
 * Every read/mutation of an existing project goes through `assertOwner`, so the
 * ownership invariant (projects.user_id == caller) is enforced in one place.
 */
import type { Storyboard } from '@coji/shared/storyboard';
import { defaultVoiceId, localeForStyle, resolveGender, resolveStyle } from '@coji/shared/style';
import { type AuthContext, assertOwner } from '../auth/context.ts';
import type { ProjectState } from './fsm.ts';
import type {
  ClipComposerEntryDto,
  ClipViewDto,
  FrameProgressDto,
  ParsedSceneDto,
  ProjectDto,
  ProjectListItemDto,
  ProjectViewDto,
  RenderStatusDto,
} from './schema.ts';

/** A persisted project as the service sees it (camelCase, owner included). */
export interface ProjectRecord {
  id: string;
  userId: string;
  prompt: string;
  status: ProjectDto['status'];
  audioMode: ProjectDto['audioMode'];
  script: string | null;
  voiceId: string | null;
  audioUrl: string | null;
  style: string;
  locale: string;
  gender: string;
  creditsSpent: number;
  renderAttempt: number;
  /** True once the editor's one-shot auto-trim pass has run for this project. */
  autoTrimmed: boolean;
  storyboardScenes?: ParsedSceneDto[] | null;
  /** Image quality mode chosen at project creation. */
  quality: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  userId: string;
  prompt: string;
  audioMode?: ProjectDto['audioMode'];
  script?: string | null;
  voiceId?: string | null;
  audioUrl?: string | null;
  /** Style id (american/russian). Defaults to american. */
  style?: string | null;
  /** Locale (en-US/ru-RU). Defaults to the style's default locale. */
  locale?: string | null;
  /** Presenter gender (female/male). Defaults to the style's default gender. */
  gender?: string | null;
  storyboard?: Storyboard | null;
  storyboardScenes?: ParsedSceneDto[] | null;
  /** Image quality mode: 'draft' | 'max'. Defaults to 'max'. */
  quality?: string;
}

/** Persistence port — implemented by the Drizzle repo and the in-memory fake. */
export interface ProjectsRepository {
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  findById(id: string): Promise<ProjectRecord | null>;
  /** List the projects owned by `userId`, newest first (gallery projection). */
  listOwned(userId: string): Promise<ProjectListItemDto[]>;
}

/**
 * Image-stage port — the DB-bound async generate path (provider_jobs + frames +
 * credit hold). Kept behind a port so the HTTP acceptance suite can inject a
 * fake while production wires the Drizzle-backed implementation
 * (modules/projects/image-stage.ts). Optional on the service: when absent,
 * generate-images / frame progress degrade to a clear 501.
 */
export interface ImageStagePort {
  /** Enqueue async image generation; returns the job id + whether it was new. */
  enqueue(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ jobId: string; status: 'enqueued' | 'already_enqueued' }>;
  /** Per-frame progress for a project. */
  frames(projectId: string): Promise<FrameProgressDto[]>;
  /** Image-stage credit cost estimate (bounded per_set). */
  cost(): Promise<number>;
}

/**
 * Preview-gate port (P2) — DB-bound cancel/retry/continue/preview-load
 * transitions. Behind a port for the same reason as ImageStagePort: the HTTP
 * acceptance suite injects a fake; production wires the Drizzle-backed impl
 * (modules/projects/preview-gate.ts).
 */
export interface PreviewGatePort {
  loadPreview(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: ProjectState }>;
  cancel(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: ProjectState }>;
  retry(args: {
    caller: AuthContext;
    projectId: string;
    prompt?: string;
    storyboard?: Storyboard;
  }): Promise<{ id: string; status: ProjectState; jobId: string; attempt: number }>;
  continueToAnimating(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: ProjectState; animationCreditEstimate: number }>;
  /** Read-only animation credit estimate (E2 cost-before-confirm). */
  animationEstimate?(): Promise<number>;
}

/**
 * Render/export port (P4) — DB-bound export enqueue (render hold + provider_jobs
 * kind=render + clips_ready→editing) and the latest render status for polling.
 * Behind a port for the same reason as the other stages: HTTP acceptance injects
 * a fake; production wires the Drizzle-backed impl (modules/projects/render-stage.ts).
 */
export interface RenderStagePort {
  export(args: {
    caller: AuthContext;
    projectId: string;
    /** Per-clip in/out trims (frames), ordered to match completed clips. */
    trims?: { startFrom: number; endAt: number }[];
    /**
     * Explicit ORDERED clip selection (E1 reorder/delete): render exactly these
     * clip ids in this order; omitted clips are excluded. Per-entry
     * startFrom/endAt override the persisted trim. Takes precedence over `trims`.
     */
    clips?: { clipId: string; startFrom?: number; endAt?: number }[];
  }): Promise<{ jobId: string; status: 'enqueued' | 'already_enqueued'; renderAttempt: number }>;
  render(projectId: string): Promise<RenderStatusDto | null>;
  cost(): Promise<number>;
  /** Completed clips (browser-loadable URLs) for the editor; optional. */
  clips?(projectId: string): Promise<ClipViewDto[]>;
  /**
   * Persist the editor's per-clip in/out trims (B1). Each entry sets one clip's
   * trim_start_frame/trim_end_frame; the first save also flips
   * projects.auto_trimmed=true so the one-shot auto-trim never re-runs over a
   * manual edit. Idempotent. Optional on the port.
   */
  saveTrims?(args: {
    caller: AuthContext;
    projectId: string;
    trims: { clipId: string; startFrame: number; endFrame: number }[];
  }): Promise<{ saved: number; autoTrimmed: boolean }>;
  /**
   * Re-open a `rendered` project back to `editing` (done-screen "re-edit") so the
   * user can edit trims/clips and re-export. Idempotent; a pure FSM transition
   * with no credit side-effects. Optional on the port.
   */
  reopen?(args: {
    caller: AuthContext;
    projectId: string;
  }): Promise<{ id: string; status: 'editing' | 'clips_ready' }>;
}

/**
 * Animation re-run port (C2) — the editor-scoped 're-animate one clip' flow.
 * Behind a port like the other stages so the HTTP acceptance suite can inject a
 * fake; production wires the Drizzle-backed impl (modules/projects/animation-stage.ts).
 */
export interface AnimationStagePort {
  reanimateClip(args: {
    caller: AuthContext;
    projectId: string;
    clipId: string;
  }): Promise<{ jobId: string; attempt: number; status: 'animating' }>;
}

/**
 * Composer-stage port (clip-composer / WS3) — DB-bound composition CRUD + the
 * continue-to-composing transition. Behind a port like the other stages so the
 * HTTP acceptance suite injects a fake while production wires the Drizzle-backed
 * impl (modules/projects/composer-stage.ts).
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

export class StageNotConfiguredError extends Error {
  readonly status = 501;
  constructor(stage = 'Image') {
    super(`${stage} stage is not configured on this service`);
    this.name = 'StageNotConfiguredError';
  }
}

export class ProjectNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Not found');
    this.name = 'ProjectNotFoundError';
  }
}

/** Serialize a record to the API DTO (Date → ISO string). */
export function toProjectDto(p: ProjectRecord): ProjectDto {
  return {
    id: p.id,
    userId: p.userId,
    prompt: p.prompt,
    status: p.status,
    audioMode: p.audioMode,
    script: p.script,
    voiceId: p.voiceId,
    audioUrl: p.audioUrl,
    style: p.style,
    locale: p.locale,
    gender: p.gender,
    creditsSpent: p.creditsSpent,
    renderAttempt: p.renderAttempt,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * Resolve a create input's style/locale/gender/voice defaults. `style` defaults
 * to american; `locale`/`gender` derive from the style preset unless given; the
 * voice is the default for the resolved locale+gender unless the caller picked
 * one. One place so the Drizzle repo and the in-memory fake agree.
 */
export function resolveProjectDefaults(input: CreateProjectInput): {
  style: string;
  locale: string;
  gender: string;
  voiceId: string;
} {
  const style = resolveStyle(input.style).id;
  const locale = input.locale ?? localeForStyle(style);
  const gender = resolveGender(input.gender ?? resolveStyle(style).defaultGender);
  const voiceId = input.voiceId ?? defaultVoiceId(locale, gender);
  return { style, locale, gender, voiceId };
}

export function createProjectsService(
  repo: ProjectsRepository,
  imageStage?: ImageStagePort,
  previewGate?: PreviewGatePort,
  renderStage?: RenderStagePort,
  animationStage?: AnimationStagePort,
  composerStage?: ComposerStagePort,
) {
  function requireStage(): ImageStagePort {
    if (!imageStage) throw new StageNotConfiguredError('Image');
    return imageStage;
  }
  function requireGate(): PreviewGatePort {
    if (!previewGate) throw new StageNotConfiguredError('Preview-gate');
    return previewGate;
  }
  function requireRender(): RenderStagePort {
    if (!renderStage) throw new StageNotConfiguredError('Render');
    return renderStage;
  }
  function requireAnimation(): AnimationStagePort {
    if (!animationStage) throw new StageNotConfiguredError('Animation');
    return animationStage;
  }
  function requireComposer(): ComposerStagePort {
    if (!composerStage) throw new StageNotConfiguredError('Composer');
    return composerStage;
  }
  /** Load + ownership-check a project, returning its record. */
  async function ownedOrThrow(caller: AuthContext, id: string): Promise<ProjectRecord> {
    const record = await repo.findById(id);
    if (!record) throw new ProjectNotFoundError();
    assertOwner(record.userId, caller);
    return record;
  }

  return {
    /** Create a new project in `draft` for the caller. */
    async create(
      caller: AuthContext,
      input: Omit<CreateProjectInput, 'userId'>,
    ): Promise<ProjectDto> {
      const record = await repo.create({ ...input, userId: caller.userId });
      return toProjectDto(record);
    },

    /**
     * List the caller's own projects (newest first) for the gallery. The
     * ownership guard is the query itself: the repo filters by `caller.userId`,
     * so a caller can never see another user's projects.
     */
    async listOwned(caller: AuthContext): Promise<ProjectListItemDto[]> {
      return repo.listOwned(caller.userId);
    },

    /**
     * Read a project the caller owns. Missing project → 404; someone else's
     * project → 404 (privacy-preserving, via assertOwner). The two are
     * indistinguishable to the caller by design.
     */
    async getOwned(caller: AuthContext, id: string): Promise<ProjectDto> {
      const record = await repo.findById(id);
      if (!record) throw new ProjectNotFoundError();
      assertOwner(record.userId, caller);
      return toProjectDto(record);
    },

    /**
     * Read a project view (project + per-frame progress + image-stage cost
     * estimate) the caller owns. Powers the web client's generate/preview poll.
     */
    async getOwnedView(caller: AuthContext, id: string): Promise<ProjectViewDto> {
      const record = await repo.findById(id);
      if (!record) throw new ProjectNotFoundError();
      assertOwner(record.userId, caller);
      const stage = requireStage();
      const [frames, imageStageCost] = await Promise.all([stage.frames(id), stage.cost()]);
      // Render status + completed clips are included when the render stage is
      // configured (P4). Clips power the editor's preview/player + downloads.
      const render = renderStage ? await renderStage.render(id) : undefined;
      const clips = renderStage?.clips ? await renderStage.clips(id) : undefined;
      return {
        ...toProjectDto(record),
        // Surfaced on the view (not the base ProjectDto) so the editor knows
        // whether the one-shot auto-trim has already run for this project.
        autoTrimmed: record.autoTrimmed,
        storyboardScenes: record.storyboardScenes ?? null,
        quality: record.quality as 'draft' | 'max',
        frames,
        imageStageCost,
        ...(clips !== undefined ? { clips } : {}),
        ...(render !== undefined ? { render } : {}),
      };
    },

    /**
     * Enqueue async image generation for an owned project (202). Ownership +
     * pre-flight balance + hold + job creation happen in the image-stage port;
     * no provider is awaited inline.
     */
    async generateImages(
      caller: AuthContext,
      id: string,
    ): Promise<{
      jobId: string;
      status: 'enqueued' | 'already_enqueued';
      projectStatus: ProjectDto['status'];
    }> {
      const record = await repo.findById(id);
      if (!record) throw new ProjectNotFoundError();
      assertOwner(record.userId, caller);
      const result = await requireStage().enqueue({ caller, projectId: id });
      return { ...result, projectStatus: record.status };
    },

    // --- Preview gate (P2) ------------------------------------------------

    /** images_ready → awaiting_decision on preview load (idempotent). */
    async loadPreview(
      caller: AuthContext,
      id: string,
    ): Promise<{ id: string; status: ProjectState }> {
      await ownedOrThrow(caller, id);
      return requireGate().loadPreview({ caller, projectId: id });
    },

    /** Cancel an in-flight project → cancelled (FSM-guarded). */
    async cancel(caller: AuthContext, id: string): Promise<{ id: string; status: ProjectState }> {
      await ownedOrThrow(caller, id);
      return requireGate().cancel({ caller, projectId: id });
    },

    /** Retry the image set with an optional modified prompt (fresh attempt + hold). */
    async retry(
      caller: AuthContext,
      id: string,
      prompt?: string,
      storyboard?: Storyboard,
    ): Promise<{ id: string; status: ProjectState; jobId: string; attempt: number }> {
      await ownedOrThrow(caller, id);
      return requireGate().retry({ caller, projectId: id, prompt, storyboard });
    },

    /** Continue → animating, returning the animation credit estimate. */
    async continue(
      caller: AuthContext,
      id: string,
    ): Promise<{ id: string; status: ProjectState; animationCreditEstimate: number }> {
      await ownedOrThrow(caller, id);
      return requireGate().continueToAnimating({ caller, projectId: id });
    },

    /**
     * Read-only animation credit estimate for an owned project (E2 cost-before-
     * confirm). Asserts ownership; never mutates state.
     */
    async animationEstimate(caller: AuthContext, id: string): Promise<{ credits: number }> {
      await ownedOrThrow(caller, id);
      const gate = requireGate();
      if (!gate.animationEstimate) throw new StageNotConfiguredError('Preview-gate');
      return { credits: await gate.animationEstimate() };
    },

    /**
     * Read-only render (export) credit estimate for an owned project (E2). Asserts
     * ownership; never mutates state.
     */
    async renderEstimate(caller: AuthContext, id: string): Promise<{ credits: number }> {
      await ownedOrThrow(caller, id);
      return { credits: await requireRender().cost() };
    },

    // --- Export / render (P4) ---------------------------------------------

    /**
     * Enqueue the final render for an owned project (202). State guard +
     * pre-flight balance + render hold + render job creation happen in the
     * render-stage port; no render is awaited inline.
     */
    async export(
      caller: AuthContext,
      id: string,
      trims?: { startFrom: number; endAt: number }[],
      clips?: { clipId: string; startFrom?: number; endAt?: number }[],
    ): Promise<{ jobId: string; status: 'enqueued' | 'already_enqueued'; renderAttempt: number }> {
      await ownedOrThrow(caller, id);
      return requireRender().export({ caller, projectId: id, trims, clips });
    },

    /**
     * Persist the editor's per-clip trims (B1). Ownership-checked; the first
     * save flips projects.auto_trimmed so the one-shot auto-trim runs once.
     * Idempotent — re-saving the same trims is a no-op for auto_trimmed.
     */
    async saveTrims(
      caller: AuthContext,
      id: string,
      trims: { clipId: string; startFrame: number; endFrame: number }[],
    ): Promise<{ saved: number; autoTrimmed: boolean }> {
      await ownedOrThrow(caller, id);
      const stage = requireRender();
      if (!stage.saveTrims) throw new StageNotConfiguredError('Render');
      return stage.saveTrims({ caller, projectId: id, trims });
    },

    /**
     * Re-open a finished project for another edit pass (done-screen "re-edit").
     * Ownership-checked; rendered → editing (idempotent), no credit side-effects.
     */
    async reopen(
      caller: AuthContext,
      id: string,
    ): Promise<{ id: string; status: 'editing' | 'clips_ready' }> {
      await ownedOrThrow(caller, id);
      const stage = requireRender();
      if (!stage.reopen) throw new StageNotConfiguredError('Render');
      return stage.reopen({ caller, projectId: id });
    },

    // --- Re-animate one clip (C2) -----------------------------------------

    /**
     * Re-animate a single clip (editor-scoped). Ownership-checked; re-enters the
     * animation stage for that clip's frame (fresh job + per_clip hold) and
     * returns the new job id. applyJobResult settles the result.
     */
    async reanimateClip(
      caller: AuthContext,
      id: string,
      clipId: string,
    ): Promise<{ jobId: string; attempt: number; status: 'animating' }> {
      await ownedOrThrow(caller, id);
      return requireAnimation().reanimateClip({ caller, projectId: id, clipId });
    },

    // --- Composer (clip-composer / WS3) -----------------------------------

    /**
     * Read a project's composition (its clips in order_idx order) — the same
     * read model the editor consumes. Ownership-checked; never mutates state.
     */
    async getComposition(caller: AuthContext, id: string): Promise<ClipViewDto[]> {
      await ownedOrThrow(caller, id);
      return requireComposer().getComposition({ caller, projectId: id });
    },

    /**
     * Replace a project's composition with the given ordered entries (clip
     * list). Ownership-checked; the composer stage validates each entry's
     * sourceFrameId ∈ project.frames + the N-cap and assigns order_idx by array
     * position. No credit side-effects (holds are placed at animate). Returns
     * the fresh composition (with minted clip ids).
     */
    async setComposition(
      caller: AuthContext,
      id: string,
      entries: ClipComposerEntryDto[],
    ): Promise<ClipViewDto[]> {
      await ownedOrThrow(caller, id);
      return requireComposer().setComposition({ caller, projectId: id, entries });
    },

    /**
     * Continue from the preview gate into the composer: awaiting_decision →
     * composing (FSM-guarded, idempotent). Ownership-checked; no credit side-
     * effects (the composer is free).
     */
    async continueToComposing(
      caller: AuthContext,
      id: string,
    ): Promise<{ id: string; status: ProjectState }> {
      await ownedOrThrow(caller, id);
      return requireComposer().continueToComposing({ caller, projectId: id });
    },
  };
}

export type ProjectsService = ReturnType<typeof createProjectsService>;
