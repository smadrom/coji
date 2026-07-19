/**
 * P2 preview-gate acceptance — HTTP/Eden layer (app.handle), zero DB.
 *
 * Drives cancel/retry/continue/preview as FSM transitions through the real
 * routes + service, backed by an in-memory repo + an in-memory PreviewGatePort
 * that enforces the same FSM rules as the DB impl. The DB-backed transitions +
 * fresh-hold accounting are covered by the gated jobs integration suite.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { type ProjectState, canTransition } from './fsm.ts';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import {
  type ImageStagePort,
  type PreviewGatePort,
  type ProjectsRepository,
  createProjectsService,
} from './service.ts';

const ANIMATION_ESTIMATE = 24; // per_clip(6) × 4 — arbitrary but deterministic

/** A mutable in-memory project store shared by the repo + the gate fake. */
function createStore() {
  const repo = createInMemoryProjectsRepository();
  // The in-memory repo holds records; expose a status setter the gate fake uses.
  const statuses = new Map<string, ProjectState>();
  const attempts = new Map<string, number>();

  const wrappedRepo: ProjectsRepository = {
    async create(input) {
      const rec = await repo.create(input);
      statuses.set(rec.id, rec.status as ProjectState);
      attempts.set(rec.id, -1);
      return rec;
    },
    async findById(id) {
      const rec = await repo.findById(id);
      if (!rec) return null;
      return { ...rec, status: statuses.get(id) ?? (rec.status as ProjectState) };
    },
    listOwned: (userId) => repo.listOwned(userId),
  };
  return { repo: wrappedRepo, statuses, attempts };
}

function buildApp() {
  const { repo, statuses, attempts } = createStore();

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

  const gate: PreviewGatePort = {
    async loadPreview({ projectId }) {
      const cur = statuses.get(projectId);
      if (cur === 'images_ready') statuses.set(projectId, 'awaiting_decision');
      return { id: projectId, status: statuses.get(projectId) as ProjectState };
    },
    async cancel({ projectId }) {
      const cur = statuses.get(projectId) as ProjectState;
      if (cur !== 'cancelled' && !canTransition(cur, 'cancelled')) {
        throw statusErr(409, `Illegal ${cur} → cancelled`);
      }
      statuses.set(projectId, 'cancelled');
      return { id: projectId, status: 'cancelled' };
    },
    async retry({ projectId }) {
      const cur = statuses.get(projectId) as ProjectState;
      if (cur !== 'awaiting_decision' && cur !== 'images_ready') {
        throw statusErr(409, `retry requires awaiting_decision|images_ready, got ${cur}`);
      }
      const next = (attempts.get(projectId) ?? -1) + 1;
      attempts.set(projectId, next);
      statuses.set(projectId, 'images_ready');
      return { id: projectId, status: 'images_ready', jobId: crypto.randomUUID(), attempt: next };
    },
    async continueToAnimating({ projectId }) {
      const cur = statuses.get(projectId) as ProjectState;
      if (!canTransition(cur, 'animating')) {
        throw statusErr(409, `Illegal ${cur} → animating`);
      }
      statuses.set(projectId, 'animating');
      return { id: projectId, status: 'animating', animationCreditEstimate: ANIMATION_ESTIMATE };
    },
  };

  const service = createProjectsService(repo, imageStage, gate);
  const app = new Elysia().use(projectsRoutes(service));
  return { app, statuses };
}

function statusErr(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

const post = (headers: Record<string, string> = {}, body?: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

let app: ReturnType<typeof buildApp>['app'];
let statuses: Map<string, ProjectState>;

beforeEach(() => {
  ({ app, statuses } = buildApp());
});

async function newProject(userId = 'u'): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/projects', post({ 'x-user-id': userId }, { prompt: 'a person' })),
  );
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe('preview gate — preview load', () => {
  test('images_ready → awaiting_decision (idempotent)', async () => {
    const id = await newProject();
    statuses.set(id, 'images_ready');

    const r1 = await app.handle(
      new Request(`http://localhost/projects/${id}/preview`, post({ 'x-user-id': 'u' })),
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).status).toBe('awaiting_decision');

    // second call is a no-op, stays awaiting_decision
    const r2 = await app.handle(
      new Request(`http://localhost/projects/${id}/preview`, post({ 'x-user-id': 'u' })),
    );
    expect((await r2.json()).status).toBe('awaiting_decision');
  });
});

describe('preview gate — cancel', () => {
  test('draft → cancelled', async () => {
    const id = await newProject();
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/cancel`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
  });

  test('cancel from a terminal state is 409', async () => {
    const id = await newProject();
    statuses.set(id, 'rendered');
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/cancel`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(409);
  });

  test('cross-user cancel is 404', async () => {
    const id = await newProject('owner');
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/cancel`, post({ 'x-user-id': 'attacker' })),
    );
    expect(res.status).toBe(404);
  });
});

describe('preview gate — retry', () => {
  test('awaiting_decision + modified prompt → re-enqueue, back to images_ready, attempt bumped', async () => {
    const id = await newProject();
    statuses.set(id, 'awaiting_decision');

    const res = await app.handle(
      new Request(
        `http://localhost/projects/${id}/retry`,
        post({ 'x-user-id': 'u' }, { prompt: 'new prompt' }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; jobId: string; attempt: number };
    expect(body.status).toBe('images_ready');
    expect(body.attempt).toBe(0);
    expect(body.jobId).toBeDefined();
  });

  test('retry with no prompt is allowed (reuses existing prompt)', async () => {
    const id = await newProject();
    statuses.set(id, 'images_ready');
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/retry`, post({ 'x-user-id': 'u' }, {})),
    );
    expect(res.status).toBe(200);
  });

  test('retry from draft is 409 (out of state)', async () => {
    const id = await newProject(); // draft
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/retry`, post({ 'x-user-id': 'u' }, {})),
    );
    expect(res.status).toBe(409);
  });
});

describe('preview gate — continue', () => {
  test('awaiting_decision → animating, returns animation credit estimate', async () => {
    const id = await newProject();
    statuses.set(id, 'awaiting_decision');

    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/continue`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; animationCreditEstimate: number };
    expect(body.status).toBe('animating');
    expect(body.animationCreditEstimate).toBe(ANIMATION_ESTIMATE);
  });

  test('continue from draft is 409', async () => {
    const id = await newProject(); // draft
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/continue`, post({ 'x-user-id': 'u' })),
    );
    expect(res.status).toBe(409);
  });

  test('unauthenticated continue is 401', async () => {
    const id = await newProject();
    statuses.set(id, 'awaiting_decision');
    const res = await app.handle(new Request(`http://localhost/projects/${id}/continue`, post()));
    expect(res.status).toBe(401);
  });
});
