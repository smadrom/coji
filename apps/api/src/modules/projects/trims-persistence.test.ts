/**
 * B1 — Trim persistence round-trip (task #18, target 3).
 *
 * Drives POST /projects/:id/trims through the real Elysia routes + service,
 * backed by an in-memory repo + an in-memory RenderStagePort. Zero DB, zero
 * paid API. Runs unconditionally in CI.
 *
 * Covers:
 *   1. POST /projects/:id/trims → 200, returns { saved, autoTrimmed }.
 *   2. First save sets autoTrimmed:true; second save stays true (idempotent).
 *   3. trimStartFrame / trimEndFrame are stored and reflected in clips[] on view.
 *   4. Cross-user trim save is 404.
 *   5. Unauthenticated trim save is 401.
 *   6. Unknown project is 404.
 *   7. Empty trims array is accepted (saved=0).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { ProjectState } from './fsm.ts';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import type { ClipViewDto } from './schema.ts';
import {
  type ImageStagePort,
  type ProjectsRepository,
  type RenderStagePort,
  createProjectsService,
} from './service.ts';

// ---------------------------------------------------------------------------
// In-memory clip store used by the fake render stage.
// ---------------------------------------------------------------------------

interface FakeClip {
  id: string;
  idx: number;
  videoUrl: string;
  trimStartFrame?: number | null;
  trimEndFrame?: number | null;
}

function buildApp() {
  const baseRepo = createInMemoryProjectsRepository();
  const statuses = new Map<string, ProjectState>();

  const wrappedRepo: ProjectsRepository = {
    async create(input) {
      const rec = await baseRepo.create(input);
      statuses.set(rec.id, rec.status as ProjectState);
      return rec;
    },
    async findById(id) {
      const rec = await baseRepo.findById(id);
      if (!rec) return null;
      return { ...rec, status: (statuses.get(id) ?? rec.status) as typeof rec.status };
    },
    listOwned: (userId) => baseRepo.listOwned(userId),
  };

  const clipStore = new Map<string, FakeClip[]>();
  const trimCalls: { projectId: string; trims: unknown[] }[] = [];

  const imageStage: ImageStagePort = {
    async enqueue() {
      return { jobId: crypto.randomUUID(), status: 'enqueued' };
    },
    async frames() {
      return [0, 1, 2, 3].map((idx) => ({
        idx,
        status: 'completed' as const,
        imageRef: `k/${idx}`,
        caption: 'c',
      }));
    },
    async cost() {
      return 10;
    },
  };

  const renderStage: RenderStagePort = {
    async export() {
      return { jobId: crypto.randomUUID(), status: 'enqueued', renderAttempt: 0 };
    },
    async render() {
      return null;
    },
    async cost() {
      return 50;
    },
    async clips(projectId): Promise<ClipViewDto[]> {
      return (clipStore.get(projectId) ?? []).map((c) => ({
        id: c.id,
        idx: c.idx,
        videoUrl: c.videoUrl,
        status: 'completed' as const,
        trimStartFrame: c.trimStartFrame ?? null,
        trimEndFrame: c.trimEndFrame ?? null,
        script: '',
      }));
    },
    async saveTrims({ projectId, trims }) {
      trimCalls.push({ projectId, trims });
      const clips = clipStore.get(projectId) ?? [];
      let saved = 0;
      for (const trim of trims) {
        const t = trim as { clipId: string; startFrame: number; endFrame: number };
        const clip = clips.find((c) => c.id === t.clipId);
        if (clip) {
          clip.trimStartFrame = t.startFrame;
          clip.trimEndFrame = t.endFrame;
          saved++;
        }
      }
      return { saved, autoTrimmed: true };
    },
  };

  const service = createProjectsService(wrappedRepo, imageStage, undefined, renderStage);
  const app = new Elysia().use(projectsRoutes(service));

  return { app, statuses, clipStore, trimCalls };
}

const postJson = (headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', ...headers },
});

let ctx: ReturnType<typeof buildApp>;

beforeEach(() => {
  ctx = buildApp();
});

async function newProject(app = ctx.app, userId = 'u'): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/projects', {
      ...postJson({ 'x-user-id': userId }),
      body: JSON.stringify({ prompt: 'a person' }),
    }),
  );
  const { id } = (await res.json()) as { id: string };
  return id;
}

function seedClips(projectId: string, count = 2): FakeClip[] {
  const clips: FakeClip[] = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    idx: i,
    videoUrl: `/files?key=clip-${i}.mp4`,
  }));
  ctx.clipStore.set(projectId, clips);
  return clips;
}

describe('POST /projects/:id/trims (B1)', () => {
  test('saves trims → 200 with { saved, autoTrimmed:true }', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');
    const clips = seedClips(id, 2);

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, {
        ...postJson({ 'x-user-id': 'u' }),
        body: JSON.stringify({
          trims: [
            { clipId: clips[0]!.id, startFrame: 5, endFrame: 25 },
            { clipId: clips[1]!.id, startFrame: 0, endFrame: 30 },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { saved: number; autoTrimmed: boolean };
    expect(data.saved).toBe(2);
    expect(data.autoTrimmed).toBe(true);
  });

  test('second save is idempotent — autoTrimmed stays true, no error', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');
    const clips = seedClips(id, 1);
    const body = JSON.stringify({
      trims: [{ clipId: clips[0]!.id, startFrame: 0, endFrame: 20 }],
    });
    const headers = postJson({ 'x-user-id': 'u' });

    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, { ...headers, body }),
    );
    const res2 = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, { ...headers, body }),
    );
    expect(res2.status).toBe(200);
    const data = (await res2.json()) as { autoTrimmed: boolean };
    expect(data.autoTrimmed).toBe(true);
    // Both calls went through the service.
    expect(ctx.trimCalls.filter((c) => c.projectId === id)).toHaveLength(2);
  });

  test('saved trims are reflected in clips[] on the project view', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');
    const clips = seedClips(id, 1);

    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, {
        ...postJson({ 'x-user-id': 'u' }),
        body: JSON.stringify({
          trims: [{ clipId: clips[0]!.id, startFrame: 3, endFrame: 27 }],
        }),
      }),
    );

    const viewRes = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}`, { headers: { 'x-user-id': 'u' } }),
    );
    expect(viewRes.status).toBe(200);
    const view = (await viewRes.json()) as {
      clips?: { id: string; trimStartFrame?: number | null; trimEndFrame?: number | null }[];
    };
    const clip = view.clips?.find((c) => c.id === clips[0]!.id);
    expect(clip).toBeDefined();
    expect(clip?.trimStartFrame).toBe(3);
    expect(clip?.trimEndFrame).toBe(27);
  });

  test('cross-user trim save is 404', async () => {
    const id = await newProject(ctx.app, 'owner');
    ctx.statuses.set(id, 'editing');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, {
        ...postJson({ 'x-user-id': 'attacker' }),
        body: JSON.stringify({ trims: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated trim save is 401', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, {
        ...postJson(),
        body: JSON.stringify({ trims: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('unknown project id is 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${fakeId}/trims`, {
        ...postJson({ 'x-user-id': 'u' }),
        body: JSON.stringify({ trims: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('empty trims array is accepted → saved=0', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/trims`, {
        ...postJson({ 'x-user-id': 'u' }),
        body: JSON.stringify({ trims: [] }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { saved: number };
    expect(data.saved).toBe(0);
  });
});
