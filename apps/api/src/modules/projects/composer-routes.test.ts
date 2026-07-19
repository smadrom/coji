/**
 * HTTP acceptance tests for the composer routes (clip-composer / WS3+WS7).
 *
 * Drives the real Elysia routes via `app.handle` against an in-memory repo +
 * a fake ComposerStagePort. Zero DB, zero paid API — runs unconditionally in CI.
 *
 * Covers:
 *   GET  /projects/:id/composition        → 200 ClipViewDto[]
 *   PUT  /projects/:id/composition        → 200 ClipViewDto[] (replace)
 *   POST /projects/:id/continue-to-composing → 200 { id, status }
 *
 * Ownership + auth guard (cross-user → 404, unauthenticated → 401) for each
 * route. Invalid body for PUT → 422 (TypeBox validation).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import type { ClipViewDto } from './schema.ts';
import {
  type AnimationStagePort,
  type ComposerStagePort,
  type ImageStagePort,
  createProjectsService,
} from './service.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeImageStage(): ImageStagePort {
  return {
    async enqueue() {
      return { jobId: crypto.randomUUID(), status: 'enqueued' };
    },
    async frames() {
      return [0, 1, 2, 3].map((idx) => ({
        idx,
        status: 'completed' as const,
        imageRef: `k/${idx}`,
        caption: null,
      }));
    },
    async cost() {
      return 10;
    },
  };
}

/** Minimal animation stage so the service construction doesn't throw. */
function makeAnimationStage(): AnimationStagePort {
  return {
    async reanimateClip() {
      return { jobId: crypto.randomUUID(), attempt: 0, status: 'animating' };
    },
  };
}

/** A fake ClipViewDto the test composer returns. */
const FAKE_CLIPS: ClipViewDto[] = [
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    idx: 0,
    videoUrl: null,
    status: 'pending',
    script: 'First line.',
  },
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    idx: 1,
    videoUrl: null,
    status: 'pending',
    script: 'Second line.',
  },
];

interface FakeComposerCalls {
  get: { projectId: string }[];
  set: { projectId: string; entries: unknown[] }[];
  continueToComposing: { projectId: string }[];
}

function makeComposerStage(calls: FakeComposerCalls): ComposerStagePort {
  return {
    async getComposition({ projectId }) {
      calls.get.push({ projectId });
      return FAKE_CLIPS;
    },
    async setComposition({ projectId, entries }) {
      calls.set.push({ projectId, entries });
      return FAKE_CLIPS;
    },
    async continueToComposing({ projectId }) {
      calls.continueToComposing.push({ projectId });
      return { id: projectId, status: 'composing' as const };
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function buildApp() {
  const repo = createInMemoryProjectsRepository();
  const calls: FakeComposerCalls = { get: [], set: [], continueToComposing: [] };
  const composerStage = makeComposerStage(calls);
  const service = createProjectsService(
    repo,
    makeImageStage(),
    undefined,
    undefined,
    makeAnimationStage(),
    composerStage,
  );
  const app = new Elysia().use(projectsRoutes(service));
  return { app, calls };
}

function authHeaders(userId?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (userId) h['x-user-id'] = userId;
  return h;
}

let ctx: ReturnType<typeof buildApp>;

beforeEach(() => {
  ctx = buildApp();
});

async function newProject(userId = 'owner'): Promise<string> {
  const res = await ctx.app.handle(
    new Request('http://localhost/projects', {
      method: 'POST',
      headers: authHeaders(userId),
      body: JSON.stringify({ prompt: 'a test prompt' }),
    }),
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

// ---------------------------------------------------------------------------
// GET /projects/:id/composition
// ---------------------------------------------------------------------------

describe('GET /projects/:id/composition', () => {
  test('returns 200 + ClipViewDto[] for the owner', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        headers: authHeaders('owner'),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClipViewDto[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]?.script).toBe('First line.');
  });

  test('port is called with the correct projectId', async () => {
    const id = await newProject();
    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        headers: authHeaders('owner'),
      }),
    );
    expect(ctx.calls.get).toHaveLength(1);
    expect(ctx.calls.get[0]?.projectId).toBe(id);
  });

  test('cross-user request → 404', async () => {
    const id = await newProject('owner');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        headers: authHeaders('attacker'),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated request → 401', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(new Request(`http://localhost/projects/${id}/composition`));
    expect(res.status).toBe(401);
  });

  test('unknown project → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${fakeId}/composition`, {
        headers: authHeaders('owner'),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /projects/:id/composition
// ---------------------------------------------------------------------------

const VALID_FRAME_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

describe('PUT /projects/:id/composition', () => {
  test('returns 200 + ClipViewDto[] for the owner', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: authHeaders('owner'),
        body: JSON.stringify({
          clips: [
            { sourceFrameId: VALID_FRAME_ID, script: 'Beat one.', orderIdx: 0 },
            { sourceFrameId: VALID_FRAME_ID, script: 'Beat two.', orderIdx: 1 },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClipViewDto[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  test('port receives the entries in order', async () => {
    const id = await newProject();
    const entries = [
      { sourceFrameId: VALID_FRAME_ID, script: 'Line A.', orderIdx: 0 },
      { sourceFrameId: VALID_FRAME_ID, script: 'Line B.', orderIdx: 1 },
    ];
    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: authHeaders('owner'),
        body: JSON.stringify({ clips: entries }),
      }),
    );
    expect(ctx.calls.set).toHaveLength(1);
    expect(ctx.calls.set[0]?.projectId).toBe(id);
    expect((ctx.calls.set[0]?.entries as unknown[]).length).toBe(2);
  });

  test('empty clips array clears the composition', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: authHeaders('owner'),
        body: JSON.stringify({ clips: [] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(ctx.calls.set[0]?.entries).toHaveLength(0);
  });

  test('cross-user request → 404', async () => {
    const id = await newProject('owner');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: authHeaders('attacker'),
        body: JSON.stringify({ clips: [] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated request → 401', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clips: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('missing body → 422 (TypeBox validation)', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/composition`, {
        method: 'PUT',
        headers: authHeaders('owner'),
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/continue-to-composing
// ---------------------------------------------------------------------------

describe('POST /projects/:id/continue-to-composing', () => {
  test('returns 200 + { id, status } for the owner', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/continue-to-composing`, {
        method: 'POST',
        headers: authHeaders('owner'),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe('composing');
  });

  test('port is called with the correct projectId', async () => {
    const id = await newProject();
    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/continue-to-composing`, {
        method: 'POST',
        headers: authHeaders('owner'),
      }),
    );
    expect(ctx.calls.continueToComposing).toHaveLength(1);
    expect(ctx.calls.continueToComposing[0]?.projectId).toBe(id);
  });

  test('cross-user request → 404', async () => {
    const id = await newProject('owner');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/continue-to-composing`, {
        method: 'POST',
        headers: authHeaders('attacker'),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated request → 401', async () => {
    const id = await newProject();
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/continue-to-composing`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(401);
  });

  test('unknown project → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${fakeId}/continue-to-composing`, {
        method: 'POST',
        headers: authHeaders('owner'),
      }),
    );
    expect(res.status).toBe(404);
  });
});
