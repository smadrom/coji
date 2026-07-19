/**
 * P4 export acceptance — HTTP/Eden layer (app.handle), zero DB.
 *
 * Drives POST /projects/:id/export through the real routes + service, backed by
 * an in-memory repo + an in-memory RenderStagePort that enforces the same state
 * guard, render-hold, and idempotency rules as the DB impl. The DB-backed
 * export→runner(Noop render)→rendered + hold→debit/refund path is covered by the
 * gated jobs integration suite.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { ProjectState } from './fsm.ts';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import {
  type ImageStagePort,
  type ProjectsRepository,
  type RenderStagePort,
  createProjectsService,
} from './service.ts';

const RENDER_COST = 50;

function createStore() {
  const repo = createInMemoryProjectsRepository();
  const statuses = new Map<string, ProjectState>();
  const wrappedRepo: ProjectsRepository = {
    async create(input) {
      const rec = await repo.create(input);
      statuses.set(rec.id, rec.status as ProjectState);
      return rec;
    },
    async findById(id) {
      const rec = await repo.findById(id);
      if (!rec) return null;
      return { ...rec, status: statuses.get(id) ?? (rec.status as ProjectState) };
    },
    listOwned: (userId) => repo.listOwned(userId),
  };
  return { repo: wrappedRepo, statuses };
}

function buildApp(opts: { balance?: number } = {}) {
  const { repo, statuses } = createStore();
  const balance = opts.balance ?? 1000;
  const exported: string[] = [];

  const imageStage: ImageStagePort = {
    async enqueue() {
      return { jobId: crypto.randomUUID(), status: 'enqueued' };
    },
    async frames() {
      return [0, 1, 2, 3].map((idx) => ({
        idx,
        status: 'completed',
        imageRef: `k/${idx}`,
        caption: 'c',
      }));
    },
    async cost() {
      return 10;
    },
  };

  const renderStage: RenderStagePort & { exported: string[] } = {
    exported,
    async export({ projectId }) {
      const cur = statuses.get(projectId);
      if (cur !== 'clips_ready' && cur !== 'editing') {
        throw statusErr(409, `export requires clips_ready|editing, got ${cur}`);
      }
      if (balance < RENDER_COST) throw statusErr(402, 'insufficient credits');
      statuses.set(projectId, 'editing');
      exported.push(projectId);
      return { jobId: crypto.randomUUID(), status: 'enqueued', renderAttempt: 0 };
    },
    async render(projectId) {
      return exported.includes(projectId) ? { status: 'processing', outputUrl: null } : null;
    },
    async cost() {
      return RENDER_COST;
    },
  };

  const service = createProjectsService(repo, imageStage, undefined, renderStage);
  const app = new Elysia().use(projectsRoutes(service));
  return { app, statuses, renderStage };
}

function statusErr(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

const post = (headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
});

let ctx: ReturnType<typeof buildApp>;
beforeEach(() => {
  ctx = buildApp();
});

async function newProject(app = ctx.app, userId = 'u'): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ prompt: 'a person' }),
    }),
  );
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe('export (202 async render)', () => {
  test('clips_ready → 202 + render job enqueued', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'clips_ready');

    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; status: string; renderAttempt: number };
    expect(body.status).toBe('enqueued');
    expect(body.renderAttempt).toBe(0);
    expect(ctx.renderStage.exported).toContain(id);
  });

  test('export from editing is allowed (re-export)', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'editing');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(202);
  });

  test('export from wrong state is 409', async () => {
    const id = await newProject(); // draft
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(409);
    expect(ctx.renderStage.exported).toHaveLength(0);
  });

  test('insufficient balance is rejected (402) before enqueuing', async () => {
    const local = buildApp({ balance: 0 });
    const id = await newProject(local.app);
    local.statuses.set(id, 'clips_ready');
    const res = await local.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(402);
    expect(local.renderStage.exported).toHaveLength(0);
  });

  test('cross-user export is 404', async () => {
    const id = await newProject(ctx.app, 'owner');
    ctx.statuses.set(id, 'clips_ready');
    const res = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'attacker' })),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated export is 401', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'clips_ready');
    const res = await ctx.app.handle(new Request(`http://localhost/projects/${id}/export`, post()));
    expect(res.status).toBe(401);
  });

  test('GET project view exposes render status after export', async () => {
    const id = await newProject();
    ctx.statuses.set(id, 'clips_ready');
    await ctx.app.handle(
      new Request(`http://localhost/projects/${id}/export`, post({ 'x-user-id': 'u' })),
    );

    const getRes = await ctx.app.handle(
      new Request(`http://localhost/projects/${id}`, { headers: { 'x-user-id': 'u' } }),
    );
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as { render?: { status: string } | null };
    expect(view.render?.status).toBe('processing');
  });
});
