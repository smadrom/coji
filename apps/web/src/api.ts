/**
 * Typed Eden treaty client + wrappers for all project lifecycle endpoints.
 *
 * All routes live in the App type (POST /projects, GET /projects/:id,
 * generate-images, preview, cancel, retry, continue, export). Each wrapper
 * unwraps the `{ data, error, status }` tuple and throws `ApiError` on
 * failure so call sites stay unchanged.
 */
import { createCojiClient } from '@coji/shared/client';
import type { Storyboard } from '@coji/shared/storyboard';

/**
 * Eden's `treaty(domain)` requires an ABSOLUTE origin — it does not accept a
 * relative base like `/api`. Given `/api`, treaty treats the first path segment
 * as the hostname, so the browser fetches `https://api/...` → ERR_NAME_NOT_RESOLVED
 * (surfaced in the UI as a bogus "HTTP 503"). Raw-fetch shims are unaffected
 * because the browser resolves a relative `/api/...` same-origin.
 *
 * Fix: when VITE_API_URL is a same-origin path (`/api`), qualify it with
 * `window.location.origin` so treaty gets an absolute base. The `/api` prefix is
 * preserved, so nginx's `/api/`-strip still maps to `/projects` on the api
 * container (see Gotchas #10). Absolute VITE_API_URL values pass through as-is.
 */
const RAW_BASE_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? 'http://localhost:3001';

export const BASE_URL =
  RAW_BASE_URL.startsWith('/') && typeof window !== 'undefined'
    ? window.location.origin + RAW_BASE_URL
    : RAW_BASE_URL;

export const api = createCojiClient(BASE_URL);

// ---------------------------------------------------------------------------
// Auth helper — bearer token from active session, falling back to dev env
// ---------------------------------------------------------------------------

/**
 * Returns headers for API calls. Reads the session token from localStorage
 * (written by SessionProvider in session.tsx) when available, falling back
 * to the VITE_DEV_TOKEN env for pure-dev mode (no sign-in).
 *
 * Also forwards `x-user-id` while the API stub (task #22) requires it.
 */
export function authHeaders(): Record<string, string> {
  const sessionToken = localStorage.getItem('coji_token');
  const sessionUserId = localStorage.getItem('coji_user_id');
  const devToken =
    (import.meta as { env?: { VITE_DEV_TOKEN?: string } }).env?.VITE_DEV_TOKEN ?? 'dev-token';
  const token = sessionToken ?? devToken;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  // x-user-id stub: required until #22 replaces resolveAuth() in the API
  const userId = sessionUserId ?? 'dev';
  headers['x-user-id'] = userId;
  return headers;
}

// ---------------------------------------------------------------------------
// Shared response types (kept for callers that import them directly)
// ---------------------------------------------------------------------------

export interface FrameRow {
  id: string;
  idx: number;
  status: 'pending' | 'generating' | 'ready' | 'failed';
  /** Signed URL — present once status === 'ready'. */
  signedUrl?: string;
  caption?: string;
}

export interface GenerateImagesResponse {
  jobId: string;
}

export interface ClipRow {
  id: string;
  /** Backing shot (frame) id — clip-composer restores the chosen shot per beat. */
  sourceFrameId?: string;
  /** 0-based clip index (order_idx since clip-composer). */
  idx: number;
  /**
   * Same-origin `/files` URL of the rendered clip. Null for non-completed clips
   * (failed/animating/pending) — nothing to play yet (C2 widened the view).
   */
  videoUrl: string | null;
  /** Duration in frames (derived from the clip's duration + fps). */
  durationInFrames?: number;
  /** Lifecycle for the editor (re-animation surfaces 'animating'/'failed'). */
  status: 'pending' | 'animating' | 'completed' | 'failed';
  /** Persisted editor in-point (frames @30fps); null/undefined until trimmed. */
  trimStartFrame?: number | null;
  /** Persisted editor out-point (frames @30fps); null/undefined until trimmed. */
  trimEndFrame?: number | null;
  /**
   * Per-clip VO line (clip-composer). Empty string for legacy 4-clip rows;
   * surfaced so the composer screen can show and edit the beat's spoken text.
   */
  script: string;
}

/**
 * Latest render status surfaced on the project view (singular `render`, matching
 * the API's ProjectViewSchema). As of backend #3, `outputUrl` is a SAME-ORIGIN
 * `/files/<key>` URL so the browser can inline-preview + download the final cut
 * (Brave blocks cross-origin <video> — Gotchas #13). Null until an export runs.
 */
export interface RenderStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  outputUrl: string | null;
}

export interface ParsedScene {
  idx: number;
  time: string;
  voLine: string;
  avatarAction: string;
  suggestedFrameIdx: number;
}

export interface ProjectDetailWithFrames {
  id: string;
  status: string;
  prompt: string;
  audioMode: string;
  /** Saved storyboard (shot presets/camera), when present. */
  storyboard?: Storyboard;
  /** Audio URL (TTS output or supplied audio_url). */
  audioUrl?: string;
  creditCost?: number;
  /** Populated once generate-images job runs. */
  frames?: FrameRow[];
  /** Populated once animation stage completes (clips_ready). */
  clips?: ClipRow[];
  /**
   * Latest render status (singular) — mirrors the API's ProjectViewSchema.
   * Present once an export has been triggered; `outputUrl` is same-origin.
   */
  render?: RenderStatus | null;
  /** True once the editor's one-shot auto-trim has run for this project. */
  autoTrimmed?: boolean;
  /** Parsed storyboard scenes (present when created in storyboard mode). */
  storyboardScenes?: ParsedScene[] | null;
  /** Total credits charged across all stages. */
  creditsSpent: number;
}

/** POST /projects/:id/export — triggers server-side Remotion render */
export interface ExportResponse {
  jobId: string;
}

export interface AnimationEstimate {
  /** Credit cost for the animation stage. */
  credits: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — unwrap treaty result or throw ApiError
// ---------------------------------------------------------------------------

// TreatyResponse data is a union of all status-code shapes; accept unknown so
// the helper works regardless of the per-route union.
interface TreatyLike {
  data: unknown;
  error: { value: unknown } | null;
  status: number;
}

function treatyError(result: TreatyLike): ApiError {
  const errVal = result.error?.value;
  const message =
    errVal != null && typeof errVal === 'object' && 'error' in errVal
      ? String((errVal as { error: unknown }).error)
      : `HTTP ${result.status}`;
  return new ApiError(result.status, message);
}

function unwrap<T>(result: TreatyLike): T {
  if (result.error != null || result.data == null) throw treatyError(result);
  return result.data as T;
}

// For 202-accepting endpoints where treaty may return data=null on success.
function unwrapAccepted<T>(result: TreatyLike): T {
  if (result.error != null) throw treatyError(result);
  return (result.data ?? {}) as T;
}

// ---------------------------------------------------------------------------
// GET /projects — gallery list of the caller's own projects
// ---------------------------------------------------------------------------

/** One row in the projects gallery (owner's projects, newest first). */
export interface ProjectListItem {
  id: string;
  status: string;
  prompt: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** Signed URL of the first stored frame — null until images exist. */
  previewUrl?: string | null;
  /** Total credits charged across all stages (0 until charges start). */
  creditsSpent: number;
}

/** GET /projects — the caller's projects, newest first. */
export async function listProjects(): Promise<ProjectListItem[]> {
  const result = await api.projects.get({ headers: authHeaders() });
  return unwrap<ProjectListItem[]>(result);
}

// ---------------------------------------------------------------------------
// generate-images
// ---------------------------------------------------------------------------

/** POST /projects/:id/generate-images — returns 202 */
export async function generateImages(projectId: string): Promise<GenerateImagesResponse> {
  const result = await api
    .projects({ id: projectId })
    ['generate-images'].post({}, { headers: authHeaders() });
  return unwrapAccepted<GenerateImagesResponse>(result);
}

// ---------------------------------------------------------------------------
// GET project with frames / clips / renders
// ---------------------------------------------------------------------------

/** GET /projects/:id — with frames/clips/renders */
export async function getProject(projectId: string): Promise<ProjectDetailWithFrames> {
  const result = await api.projects({ id: projectId }).get({ headers: authHeaders() });
  // Cast via unknown: App type's frames shape uses imageRef/caption (server-side
  // names) while ProjectDetailWithFrames uses the client-side FrameRow names.
  // The runtime values satisfy the interface; the cast is intentional.
  return unwrap<unknown>(result) as ProjectDetailWithFrames;
}

// ---------------------------------------------------------------------------
// Animation estimate — raw fetch shim (route not yet in App type)
// ---------------------------------------------------------------------------

/** GET /projects/:id/animation-estimate */
export async function getAnimationEstimate(projectId: string): Promise<AnimationEstimate> {
  const res = await fetch(`${BASE_URL}/projects/${projectId}/animation-estimate`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<AnimationEstimate>;
}

/** Credit cost of the export/render stage (shown before the user commits). */
export interface RenderEstimate {
  credits: number;
}

/**
 * GET /projects/:id/render-estimate — raw-fetch shim (route not yet in the App
 * type). Returns the export/render credit cost so the editor can show it before
 * the user exports. Gracefully degrades: callers treat a 404 (endpoint not yet
 * deployed) as "estimate unavailable" and hide the number.
 */
export async function getRenderEstimate(projectId: string): Promise<RenderEstimate> {
  const res = await fetch(`${BASE_URL}/projects/${projectId}/render-estimate`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<RenderEstimate>;
}

// ---------------------------------------------------------------------------
// Transition actions (cancel / retry / continue)
// ---------------------------------------------------------------------------

/** POST /projects/:id/preview — open the preview gate (images_ready → awaiting_decision, idempotent) */
export async function openPreview(projectId: string): Promise<void> {
  const result = await api.projects({ id: projectId }).preview.post({}, { headers: authHeaders() });
  unwrap(result);
}

/** POST /projects/:id/cancel */
export async function cancelProject(projectId: string): Promise<void> {
  const result = await api.projects({ id: projectId }).cancel.post({}, { headers: authHeaders() });
  unwrap(result);
}

/** POST /projects/:id/retry { prompt?, storyboard? } — re-generate the image set */
export async function retryProject(
  projectId: string,
  prompt?: string,
  storyboard?: Storyboard,
): Promise<void> {
  const result = await api
    .projects({ id: projectId })
    .retry.post({ prompt, storyboard }, { headers: authHeaders() });
  unwrap(result);
}

/** POST /projects/:id/continue — triggers animation stage */
export async function continueProject(projectId: string): Promise<void> {
  const result = await api
    .projects({ id: projectId })
    .continue.post({}, { headers: authHeaders() });
  unwrap(result);
}

// ---------------------------------------------------------------------------
// Export / render (P4)
// ---------------------------------------------------------------------------

/** Per-clip in/out trim (frames), ordered to match the project's completed clips. */
export interface ClipTrim {
  startFrom: number;
  endAt: number;
}

/**
 * One entry in an explicit ORDERED export selection (E1 reorder/delete). Render
 * order = array position; omitted clips are excluded. Optional startFrom/endAt
 * override the persisted trim.
 */
export interface ClipSelection {
  clipId: string;
  startFrom?: number;
  endAt?: number;
}

/**
 * POST /projects/:id/export — triggers the server-side render job (202).
 *
 * Pass `clips` (ordered selection by clip id) when the editor order/inclusion
 * has changed (reorder/delete) — the render uses exactly those clips in that
 * order. `clips` takes precedence over the legacy positional `trims`.
 */
export async function exportProject(
  projectId: string,
  body?: { clips?: ClipSelection[]; trims?: ClipTrim[] },
): Promise<ExportResponse> {
  const result = await api
    .projects({ id: projectId })
    .export.post(body ?? {}, { headers: authHeaders() });
  return unwrapAccepted<ExportResponse>(result);
}

// ---------------------------------------------------------------------------
// Persist editor trims (B1)
// ---------------------------------------------------------------------------

/** One persisted per-clip trim, addressed by clip id (frames @30fps). */
export interface SaveTrim {
  clipId: string;
  startFrame: number;
  endFrame: number;
}

/** Result of saving trims — how many were applied + the project's auto_trimmed flag. */
export interface SaveTrimsResult {
  saved: number;
  autoTrimmed: boolean;
}

/**
 * POST /projects/:id/trims — persist the editor's per-clip in/out trims. The
 * first save flips the project's `auto_trimmed` flag so auto-trim never re-runs
 * over manual edits. Addressed by clipId (not idx) so reorder/delete is safe.
 */
export async function saveTrims(projectId: string, trims: SaveTrim[]): Promise<SaveTrimsResult> {
  const result = await api
    .projects({ id: projectId })
    .trims.post({ trims }, { headers: authHeaders() });
  return unwrap<SaveTrimsResult>(result);
}

// ---------------------------------------------------------------------------
// Voices (D1) — TTS voice catalog for the /new picker
// ---------------------------------------------------------------------------

/** A selectable TTS voice. `id` is persisted as projects.voice_id on create. */
export interface Voice {
  id: string;
  name: string;
  locale: string;
  gender?: string;
  /** Browser-playable sample (may be absent for some voices). */
  previewUrl?: string;
}

/** GET /v2/voices — the cached voice catalog (same for everyone). */
export async function listVoices(): Promise<Voice[]> {
  const result = await api.v2.voices.get({ headers: authHeaders() });
  return unwrap<Voice[]>(result);
}

// ---------------------------------------------------------------------------
// Storyboard parsing (AI)
// ---------------------------------------------------------------------------

/**
 * POST /ai/parse-storyboard — LLM parses raw storyboard text into an image
 * generation prompt + N scenes with suggested frame assignments.
 */
export async function parseStoryboard(
  text: string,
): Promise<{ imagePrompt: string; scenes: ParsedScene[] }> {
  const res = await fetch(`${BASE_URL}/ai/parse-storyboard`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<{ imagePrompt: string; scenes: ParsedScene[] }>;
}

// ---------------------------------------------------------------------------
// Re-edit a rendered project (reopen → editing)
// ---------------------------------------------------------------------------

/**
 * POST /projects/:id/reopen — move a `rendered` project back to `editing` so the
 * user can re-trim/reorder and re-export. Raw-fetch shim (route may not be in the
 * App type yet); callers should handle a 404/501 as "re-edit not available yet".
 */
export async function reopenProject(projectId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/projects/${projectId}/reopen`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
}

// ---------------------------------------------------------------------------
// Composer routes (WS3 / clip-composer)
// ---------------------------------------------------------------------------

/**
 * One authored beat entry — mirrors ClipComposerEntryDto from the backend schema.
 * `clipId` is present when updating an existing clip; absent for a new beat.
 */
export interface ClipComposerEntry {
  clipId?: string;
  sourceFrameId: string;
  script: string;
  orderIdx: number;
}

/**
 * GET /projects/:id/composition — the project's current clip list in order_idx
 * order (ClipViewDto[]). Returns an empty array when no beats have been authored.
 */
export async function getComposition(projectId: string): Promise<ClipRow[]> {
  const result = await api.projects({ id: projectId }).composition.get({ headers: authHeaders() });
  return unwrap<ClipRow[]>(result);
}

/**
 * PUT /projects/:id/composition — replace the whole composition with the given
 * ordered list of beats. Returns the fresh composition (minted ids included).
 */
export async function setComposition(
  projectId: string,
  clips: ClipComposerEntry[],
): Promise<ClipRow[]> {
  const result = await api
    .projects({ id: projectId })
    .composition.put({ clips }, { headers: authHeaders() });
  return unwrap<ClipRow[]>(result);
}

/**
 * POST /projects/:id/continue-to-composing — transition awaiting_decision →
 * composing (idempotent). Returns the project's new status.
 */
export async function continueToComposing(
  projectId: string,
): Promise<{ id: string; status: string }> {
  const result = await api
    .projects({ id: projectId })
    ['continue-to-composing'].post({}, { headers: authHeaders() });
  return unwrap<{ id: string; status: string }>(result);
}

// ---------------------------------------------------------------------------
// Re-animate one clip (C2)
// ---------------------------------------------------------------------------

/** 202 response for an accepted single-clip re-animation. */
export interface ReanimateResponse {
  jobId: string;
  attempt: number;
  status: 'animating';
}

/**
 * POST /projects/:id/clips/:clipId/reanimate — re-animate a single failed clip.
 * The project re-enters `animating` while the runner re-runs just this clip;
 * the caller then waits (AnimatingScreen) until it returns to clips_ready.
 */
export async function reanimateClip(projectId: string, clipId: string): Promise<ReanimateResponse> {
  const result = await api
    .projects({ id: projectId })
    .clips({ clipId })
    .reanimate.post({}, { headers: authHeaders() });
  return unwrapAccepted<ReanimateResponse>(result);
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isInsufficientCredits() {
    return this.status === 402;
  }
}
