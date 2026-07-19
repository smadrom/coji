/**
 * P0 acceptance — HTTP/Eden layer (app.handle), zero DB, zero external calls.
 *
 * Builds a test app that mounts the real projects routes + MCP plugin against an
 * in-memory repository, so the create+read round-trip, the ownership guard, and
 * the OpenAPI/MCP generation are all exercised CI-green. The full DB-backed
 * draft→rendered pipeline (runner + applyJobResult + ledger on Noop providers +
 * local-fs storage) is covered by the gated modules/jobs/jobs.db.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mcpPlugin } from '../mcp/plugin.ts';
import { MCP_ROUTES } from '../registry.ts';
import { createInMemoryProjectsRepository } from './repository.ts';
import { projectsRoutes } from './routes.ts';
import { type ImageStagePort, createProjectsService } from './service.ts';

const IMAGE_COST = 10;

/**
 * In-memory ImageStagePort fake: records enqueue calls, simulates a configurable
 * balance for the pre-flight check, and returns deterministic frame progress —
 * so the HTTP layer (202, insufficient-balance, frame view) is testable with no
 * DB. The real DB-backed enqueue/settlement path is covered by the gated
 * modules/jobs/jobs.db.test.ts.
 */
function createFakeImageStage(opts: { balance?: number } = {}): ImageStagePort & {
  enqueued: string[];
} {
  const balance = opts.balance ?? 1000;
  const enqueued: string[] = [];
  return {
    enqueued,
    async enqueue({ projectId }) {
      if (balance < IMAGE_COST) {
        const err = new Error('Insufficient credits') as Error & { status: number };
        err.status = 402;
        throw err;
      }
      enqueued.push(projectId);
      return {
        jobId: `00000000-0000-0000-0000-0000000000${(enqueued.length + 10).toString().slice(-2)}`,
        status: 'enqueued',
      };
    },
    async frames() {
      return [0, 1, 2, 3].map((idx) => ({ idx, status: 'pending', imageRef: null, caption: null }));
    },
    async cost() {
      return IMAGE_COST;
    },
  };
}

function buildTestApp(stage: ImageStagePort = createFakeImageStage()) {
  const service = createProjectsService(createInMemoryProjectsRepository(), stage);
  return new Elysia().use(projectsRoutes(service)).use(mcpPlugin(MCP_ROUTES));
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('projects HTTP acceptance', () => {
  test('create + read round-trips for the owner', async () => {
    const app = buildTestApp();

    const createRes = await app.handle(
      new Request(
        'http://localhost/projects',
        json({ prompt: 'a woman in a red coat' }, { 'x-user-id': 'user-1' }),
      ),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      id: string;
      status: string;
      userId: string;
      prompt: string;
    };
    expect(created.status).toBe('draft');
    expect(created.userId).toBe('user-1');
    expect(created.prompt).toBe('a woman in a red coat');

    const getRes = await app.handle(
      new Request(`http://localhost/projects/${created.id}`, {
        headers: { 'x-user-id': 'user-1' },
      }),
    );
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string };
    expect(fetched.id).toBe(created.id);
  });

  test('defaults style→american, locale→en-US, and a matching voice', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/projects', json({ prompt: 'p' }, { 'x-user-id': 'u' })),
    );
    const created = (await res.json()) as {
      style: string;
      locale: string;
      gender: string;
      voiceId: string | null;
    };
    expect(created.style).toBe('american');
    expect(created.locale).toBe('en-US');
    expect(created.gender).toBe('female');
    // en-US/female default voice (HeyGen "Cassidy").
    expect(created.voiceId).toBe('16a09e4706f74997ba4ed05ea11470f6');
  });

  test('russian style derives ru-RU locale + a Russian voice', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request(
        'http://localhost/projects',
        json({ prompt: 'p', style: 'russian' }, { 'x-user-id': 'u' }),
      ),
    );
    const created = (await res.json()) as { style: string; locale: string; voiceId: string };
    expect(created.style).toBe('russian');
    expect(created.locale).toBe('ru-RU');
    // ru-RU/female default voice (HeyGen "Anya").
    expect(created.voiceId).toBe('37832e32d4f7475ab7a1cb0db8e5dd66');
  });

  test('cross-user read is rejected (404, ownership guard)', async () => {
    const app = buildTestApp();
    const createRes = await app.handle(
      new Request('http://localhost/projects', json({ prompt: 'mine' }, { 'x-user-id': 'owner' })),
    );
    const { id } = (await createRes.json()) as { id: string };

    const attackerRes = await app.handle(
      new Request(`http://localhost/projects/${id}`, { headers: { 'x-user-id': 'attacker' } }),
    );
    // 404, not 403 — does not leak existence of another user's project.
    expect(attackerRes.status).toBe(404);
  });

  test('unauthenticated calls are rejected (401)', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/projects', json({ prompt: 'x' })), // no x-user-id
    );
    expect(res.status).toBe(401);
  });

  test('reading a non-existent project is 404', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/projects/00000000-0000-0000-0000-000000000000', {
        headers: { 'x-user-id': 'user-1' },
      }),
    );
    expect(res.status).toBe(404);
  });

  test('an empty prompt is rejected by schema validation (422)', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/projects', json({ prompt: '' }, { 'x-user-id': 'user-1' })),
    );
    expect(res.status).toBe(422);
  });

  test('GET returns frame progress + image-stage cost estimate', async () => {
    const app = buildTestApp();
    const createRes = await app.handle(
      new Request('http://localhost/projects', json({ prompt: 'p' }, { 'x-user-id': 'u' })),
    );
    const { id } = (await createRes.json()) as { id: string };
    const getRes = await app.handle(
      new Request(`http://localhost/projects/${id}`, { headers: { 'x-user-id': 'u' } }),
    );
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as {
      frames: { idx: number; status: string }[];
      imageStageCost: number;
    };
    expect(view.frames).toHaveLength(4);
    expect(view.imageStageCost).toBe(IMAGE_COST);
  });
});

describe('GET /projects (list owned)', () => {
  const createFor = async (app: ReturnType<typeof buildTestApp>, userId: string, prompt: string) =>
    app.handle(new Request('http://localhost/projects', json({ prompt }, { 'x-user-id': userId })));

  test('returns only the caller’s own projects (ownership guard)', async () => {
    const app = buildTestApp();
    await createFor(app, 'owner', 'mine 1');
    await createFor(app, 'owner', 'mine 2');
    await createFor(app, 'other', 'not mine');

    const res = await app.handle(
      new Request('http://localhost/projects', { headers: { 'x-user-id': 'owner' } }),
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; prompt: string; status: string }[];
    expect(list).toHaveLength(2);
    const prompts = list.map((p) => p.prompt);
    expect(prompts).toContain('mine 1');
    expect(prompts).toContain('mine 2');
    expect(prompts).not.toContain('not mine');
    // Shape: gallery projection — no userId leak. (Recency order is asserted by
    // the DB-backed repo's `order by created_at desc`; the in-memory fake can't
    // tie-break two records created in the same millisecond.)
    for (const item of list) expect(item).not.toHaveProperty('userId');
  });

  test('unauthenticated list is rejected (401)', async () => {
    const app = buildTestApp();
    const res = await app.handle(new Request('http://localhost/projects')); // no x-user-id
    expect(res.status).toBe(401);
  });

  test('a user with no projects gets an empty list', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/projects', { headers: { 'x-user-id': 'nobody' } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(0);
  });
});

describe('generate-images (202 async)', () => {
  async function createProject(app: ReturnType<typeof buildTestApp>, userId: string) {
    const res = await app.handle(
      new Request(
        'http://localhost/projects',
        json({ prompt: 'a person' }, { 'x-user-id': userId }),
      ),
    );
    return (await res.json()) as { id: string };
  }

  test('returns 202 + jobId and records the enqueue (no inline await)', async () => {
    const stage = createFakeImageStage({ balance: 1000 });
    const app = buildTestApp(stage);
    const { id } = await createProject(app, 'u');

    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/generate-images`, {
        method: 'POST',
        headers: { 'x-user-id': 'u' },
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; status: string; projectStatus: string };
    expect(body.status).toBe('enqueued');
    expect(body.projectStatus).toBe('draft');
    expect(stage.enqueued).toContain(id);
  });

  test('insufficient balance is rejected (402) BEFORE enqueuing', async () => {
    const stage = createFakeImageStage({ balance: 0 });
    const app = buildTestApp(stage);
    const { id } = await createProject(app, 'u');

    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/generate-images`, {
        method: 'POST',
        headers: { 'x-user-id': 'u' },
      }),
    );
    expect(res.status).toBe(402);
    expect(stage.enqueued).toHaveLength(0);
  });

  test('cross-user generate-images is rejected (404)', async () => {
    const app = buildTestApp();
    const { id } = await createProject(app, 'owner');
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/generate-images`, {
        method: 'POST',
        headers: { 'x-user-id': 'attacker' },
      }),
    );
    expect(res.status).toBe(404);
  });

  test('unauthenticated generate-images is rejected (401)', async () => {
    const app = buildTestApp();
    const { id } = await createProject(app, 'owner');
    const res = await app.handle(
      new Request(`http://localhost/projects/${id}/generate-images`, { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('MCP exposure', () => {
  test('tools/list includes the read-only GET project route', async () => {
    const app = buildTestApp();
    const res = await app.handle(
      new Request('http://localhost/mcp', json({ method: 'tools/list' })),
    );
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as {
      result: { tools: { name: string; method: string; path: string }[] };
    };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('get_projects_id');
    expect(names).toContain('get_projects');
    // Every exposed tool is read-only.
    for (const tool of result.tools) expect(tool.method).toBe('GET');
  });

  test('tools/list EXCLUDES the mutating POST /projects route', async () => {
    const app = buildTestApp();
    const res = await app.handle(new Request('http://localhost/mcp/tools', { headers: {} }));
    const { tools } = (await res.json()) as { tools: { path: string; method: string }[] };
    const hasPostProjects = tools.some((t) => t.method === 'POST' && t.path === '/projects');
    expect(hasPostProjects).toBe(false);
  });
});
