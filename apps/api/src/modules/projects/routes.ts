/**
 * Projects routes (P0.7) — mounted on the literal Eden `.use()` chain.
 *
 * TypeBox schemas (./schema.ts) drive validation, OpenAPI, and MCP tool shapes.
 * Every project-scoped route resolves the caller via `requireAuth` and reads
 * through the service, which enforces the ownership guard.
 *
 * The routes factory takes the service so the app wires the Drizzle-backed one
 * and acceptance tests inject an in-memory one. GET /projects/:id opts into MCP
 * (`detail.mcp: true`) as a read-only tool; POST does not.
 */
import { Elysia, t } from 'elysia';
import { OwnershipError, UnauthenticatedError, requireAuth } from '../auth/context.ts';
import {
  ClipViewSchema,
  ComposeBodySchema,
  ContinueResponseSchema,
  ExportBodySchema,
  ExportResponseSchema,
  GenerateImagesResponseSchema,
  ParsedSceneSchema,
  ProjectListSchema,
  ProjectViewSchema,
  RetryBodySchema,
  RetryResponseSchema,
  SaveTrimsBodySchema,
  StoryboardSchema,
  TransitionResponseSchema,
} from './schema.ts';
import { ProjectNotFoundError, type ProjectsService } from './service.ts';

const CreateProjectBody = t.Object({
  prompt: t.String({ minLength: 1 }),
  audioMode: t.Optional(t.Union([t.Literal('tts'), t.Literal('audio_url')])),
  script: t.Optional(t.Union([t.String(), t.Null()])),
  voiceId: t.Optional(t.Union([t.String(), t.Null()])),
  audioUrl: t.Optional(t.Union([t.String(), t.Null()])),
  // Avatars-voices phase: style → look + default voice; locale → spoken
  // language; gender → which default voice. All optional (style defaults to
  // american; locale/voice/gender derive from it). Validated as known literals.
  style: t.Optional(t.Union([t.Literal('american'), t.Literal('russian')])),
  locale: t.Optional(t.Union([t.Literal('en-US'), t.Literal('ru-RU')])),
  gender: t.Optional(t.Union([t.Literal('female'), t.Literal('male')])),
  storyboard: t.Optional(StoryboardSchema),
  storyboardScenes: t.Optional(t.Union([t.Array(ParsedSceneSchema), t.Null()])),
  quality: t.Optional(t.Union([t.Literal('draft'), t.Literal('max')])),
});

export function projectsRoutes(service: ProjectsService) {
  return (
    new Elysia({ name: 'projects', prefix: '/projects' })
      .onError(({ error, set }) => {
        // Map domain errors to HTTP status codes.
        const status = (error as { status?: number }).status;
        if (
          error instanceof UnauthenticatedError ||
          error instanceof OwnershipError ||
          error instanceof ProjectNotFoundError ||
          typeof status === 'number'
        ) {
          set.status = status ?? 500;
          return { error: (error as Error).message };
        }
        return undefined;
      })
      .post(
        '',
        async ({ body, request }) => {
          const caller = await requireAuth(request.headers);
          return service.create(caller, body);
        },
        {
          body: CreateProjectBody,
          detail: { summary: 'Create a project (draft)', tags: ['projects'] },
        },
      )
      .get(
        '',
        async ({ request }) => {
          const caller = await requireAuth(request.headers);
          return service.listOwned(caller);
        },
        {
          response: ProjectListSchema,
          // Read-only → opt into MCP exposure.
          detail: {
            summary: 'List the caller’s projects (owner only)',
            tags: ['projects'],
            mcp: true,
          },
        },
      )
      .get(
        '/:id',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.getOwnedView(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: ProjectViewSchema,
          // Read-only → opt into MCP exposure.
          detail: { summary: 'Get a project by id (owner only)', tags: ['projects'], mcp: true },
        },
      )
      .post(
        '/:id/generate-images',
        async ({ params, request, set }) => {
          const caller = await requireAuth(request.headers);
          const result = await service.generateImages(caller, params.id);
          // Accepted — the runner does the work asynchronously.
          set.status = 202;
          return result;
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: { 202: GenerateImagesResponseSchema },
          detail: {
            summary: 'Enqueue async 4-frame image generation (202)',
            tags: ['projects'],
          },
        },
      )
      // --- Preview gate (P2) ----------------------------------------------
      .post(
        '/:id/preview',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.loadPreview(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: TransitionResponseSchema,
          detail: {
            summary: 'Open preview: images_ready → awaiting_decision (idempotent)',
            tags: ['projects'],
          },
        },
      )
      .post(
        '/:id/cancel',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.cancel(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: TransitionResponseSchema,
          detail: { summary: 'Cancel a project → cancelled', tags: ['projects'] },
        },
      )
      .post(
        '/:id/retry',
        async ({ params, body, request }) => {
          const caller = await requireAuth(request.headers);
          return service.retry(caller, params.id, body.prompt, body.storyboard);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: RetryBodySchema,
          response: RetryResponseSchema,
          detail: {
            summary: 'Retry image set (optional modified prompt) → re-enqueue',
            tags: ['projects'],
          },
        },
      )
      .post(
        '/:id/continue',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.continue(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: ContinueResponseSchema,
          detail: {
            summary: 'Continue → animating (returns animation credit estimate)',
            tags: ['projects'],
          },
        },
      )
      // --- Export / render (P4) -------------------------------------------
      .post(
        '/:id/export',
        async ({ params, request, set, body }) => {
          const caller = await requireAuth(request.headers);
          // `clips` (explicit ordered selection, E1) takes precedence over the
          // legacy positional `trims` in the render-stage builder.
          const result = await service.export(caller, params.id, body?.trims, body?.clips);
          // Accepted — the runner renders asynchronously.
          set.status = 202;
          return result;
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: t.Optional(ExportBodySchema),
          response: { 202: ExportResponseSchema },
          detail: {
            summary: 'Enqueue async final render (202)',
            tags: ['projects'],
          },
        },
      )
      // --- Editor trims (B1) ----------------------------------------------
      .post(
        '/:id/trims',
        async ({ params, body, request }) => {
          const caller = await requireAuth(request.headers);
          return service.saveTrims(caller, params.id, body.trims);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: SaveTrimsBodySchema,
          response: t.Object({ saved: t.Integer(), autoTrimmed: t.Boolean() }),
          detail: {
            summary: 'Persist the editor’s per-clip trims (sets auto_trimmed once)',
            tags: ['projects'],
          },
        },
      )
      // --- Re-edit (done-screen "re-edit") --------------------------------
      .post(
        '/:id/reopen',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.reopen(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: TransitionResponseSchema,
          detail: {
            summary: 'Re-open a rendered project → editing (re-edit; no charge)',
            tags: ['projects'],
          },
        },
      )
      // --- Cost estimates (E2 cost-before-confirm; read-only, no FSM change) ---
      .get(
        '/:id/animation-estimate',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.animationEstimate(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: t.Object({ credits: t.Integer() }),
          detail: {
            summary: 'Animation credit estimate (read-only, owner)',
            tags: ['projects'],
          },
        },
      )
      .get(
        '/:id/render-estimate',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.renderEstimate(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: t.Object({ credits: t.Integer() }),
          detail: {
            summary: 'Render (export) credit estimate (read-only, owner)',
            tags: ['projects'],
          },
        },
      )
      // --- Re-animate one clip (C2) ---------------------------------------
      .post(
        '/:id/clips/:clipId/reanimate',
        async ({ params, request, set }) => {
          const caller = await requireAuth(request.headers);
          const result = await service.reanimateClip(caller, params.id, params.clipId);
          // Accepted — the runner re-animates this clip asynchronously.
          set.status = 202;
          return result;
        },
        {
          params: t.Object({
            id: t.String({ format: 'uuid' }),
            clipId: t.String({ format: 'uuid' }),
          }),
          response: {
            202: t.Object({
              jobId: t.String({ format: 'uuid' }),
              attempt: t.Integer(),
              status: t.Literal('animating'),
            }),
          },
          detail: {
            summary: 'Re-animate a single clip (202) → re-enters animating',
            tags: ['projects'],
          },
        },
      )
      // --- Composer (clip-composer / WS3) ---------------------------------
      .get(
        '/:id/composition',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.getComposition(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: t.Array(ClipViewSchema),
          // Read-only → opt into MCP exposure.
          detail: {
            summary: 'Get a project’s composition (clip list, owner only)',
            tags: ['projects'],
            mcp: true,
          },
        },
      )
      .put(
        '/:id/composition',
        async ({ params, body, request }) => {
          const caller = await requireAuth(request.headers);
          return service.setComposition(caller, params.id, body.clips);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: ComposeBodySchema,
          response: t.Array(ClipViewSchema),
          detail: {
            summary: 'Replace a project’s composition (clip list, owner only)',
            tags: ['projects'],
          },
        },
      )
      .post(
        '/:id/continue-to-composing',
        async ({ params, request }) => {
          const caller = await requireAuth(request.headers);
          return service.continueToComposing(caller, params.id);
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          response: TransitionResponseSchema,
          detail: {
            summary: 'Continue → composing (awaiting_decision → composing)',
            tags: ['projects'],
          },
        },
      )
  );
}

/** Route metadata for the MCP registry (kept in sync with the routes above). */
export const projectsMcpRoutes = [
  { method: 'POST', path: '/projects', summary: 'Create a project (draft)', mcp: false },
  {
    method: 'GET',
    path: '/projects',
    summary: 'List the caller’s projects (owner only)',
    mcp: true,
  },
  { method: 'GET', path: '/projects/:id', summary: 'Get a project by id (owner only)', mcp: true },
  {
    method: 'GET',
    path: '/projects/:id/composition',
    summary: 'Get a project’s composition (clip list, owner only)',
    mcp: true,
  },
];
