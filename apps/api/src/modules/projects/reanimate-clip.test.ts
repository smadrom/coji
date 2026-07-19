/**
 * C2 — Re-animate a clip (task #18).
 *
 * Drives POST /projects/:id/clips/:clipId/reanimate through the real Elysia
 * routes + service, backed by an in-memory repo + an in-memory
 * AnimationStagePort. Zero DB, zero paid API. Runs unconditionally in CI.
 *
 * Covers:
 *   1. POST /…/reanimate → 202, returns { jobId, attempt, status:'animating' }.
 *   2. The fake port is called with the correct projectId + clipId.
 *   3. attempt is the value returned by the port (0 on first call).
 *   4. Cross-user re-animate is 404.
 *   5. Unauthenticated re-animate is 401.
 *   6. Unknown project is 404.
 *   7. Unknown clipId (port throws InvalidStateError) → 400.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import {
  type AnimationStagePort,
  type ImageStagePort,
  type ProjectsRepository,
  createProjectsService,
} from './service.ts';

// ---------------------------------------------------------------------------
// InvalidStateError is thrown by the real animation-stage when the clipId is
// not found on the project. Reproduce the minimal shape (status 400) so the
// fake port can signal the same error without a DB import.
// ---------------------------------------------------------------------------
class FakeInvalidStateError extends Error {
  readonly status = 400;
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidStateError';
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function buildApp() {
  const baseRepo = createInMemoryProjectsRepository();
  // Wrap the repo so we can override status (same trick as trims-persistence.test.ts).
  const statuses = new Map<string, string>();

  const wrappedRepo: ProjectsRepository = {
    async create(input) {
      const rec = await baseRepo.create(input);
      statuses.set(rec.id, rec.status as string);
      return rec;
    },
    async findById(id) {
      const rec = await baseRepo.findById(id);
      if (!rec) return null;
      return { ...rec, status: (statuses.get(id) ?? rec.status) as typeof rec.status };
    },
    listOwned: (userId) => baseRepo.listOwned(userId),
  };

  // Minimal image stage so project creation works.
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

  // Recorded calls so tests can assert the port was driven correctly.
  const reanmateCalls: { projectId: string; clipId: string }[] = [];

  // Tracks which clipIds to reject (simulate "clip not found on project").
  const badClips = new Set<string>();

  const animationStage: AnimationStagePort = {
    async reanimateClip({ projectId, clipId }) {
      if (badClips.has(clipId)) {
        throw new FakeInvalidStateError(`clip ${clipId} not found on project`);
      }
      reanmateCalls.push({ projectId, clipId });
      return { jobId: crypto.randomUUID(), attempt: 0, status: 'animating' };
    },
  };

  const service = createProjectsService(
    wrappedRepo,
    imageStage,
    undefined,
    undefined,
    animationStage,
  );
  const app = new Elysia().use(projectsRoutes(service));

  return { app, statuses, reanmateCalls, badClips };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postHeaders(userId?: string): HeadersInit {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (userId) h['x-user-id'] = userId;
  return h;
}

let ctx: ReturnType<typeof buildApp>;

beforeEach(() => {
  ctx = buildApp();
});

async function newProject(userId = 'u'): Promise<string> {
  const res = await ctx.app.handle(
    new Request('http://localhost/projects', {
      method: 'POST',
      headers: postHeaders(userId),
      body: JSON.stringify({ prompt: 'a person' }),
    }),
  );
  const { id } = (await res.json()) as { id: string };
  return id;
}

const FAKE_CLIP_ID = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /projects/:id/clips/:clipId/reanimate (C2)', () => {
  test('returns 202 with { jobId, attempt, status:"animating" }', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: postHeaders('u'),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; attempt: number; status: string };
    expect(typeof body.jobId).toBe('string');
    expect(body.attempt).toBe(0);
    expect(body.status).toBe('animating');
  });

  test('port is called with correct projectId and clipId', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');

    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: postHeaders('u'),
      }),
    );

    expect(ctx.reanmateCalls).toHaveLength(1);
    expect(ctx.reanmateCalls[0]!.projectId).toBe(id);
    expect(ctx.reanmateCalls[0]!.clipId).toBe(FAKE_CLIP_ID);
  });

  test('attempt from port is forwarded as-is (0 on first call)', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: postHeaders('u'),
      }),
    );
    const body = (await res.json()) as { attempt: number };
    expect(body.attempt).toBe(0);
  });

  test('cross-user re-animate is 404', async () => {
    const id = await newProject('owner');
    ctx.statuses.set(id, 'editing');

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: postHeaders('attacker'),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated re-animate is 401', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(401);
  });

  test('unknown project id is 404', async () => {
    const fakeProjectId = '00000000-0000-0000-0000-000000000099';

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${fakeProjectId}/clips/${FAKE_CLIP_ID}/reanimate`, {
        method: 'POST',
        headers: postHeaders('u'),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unknown clipId (port throws InvalidStateError) → 400', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');

    const BAD_CLIP = '22222222-2222-2222-2222-222222222222';
    ctx.badClips.add(BAD_CLIP);

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/clips/${BAD_CLIP}/reanimate`, {
        method: 'POST',
        headers: postHeaders('u'),
      }),
    );
    expect(res.status).toBe(400);
  });
});
