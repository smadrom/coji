/**
 * DB-backed integration test for the P4 export/render stage (task #20).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL). Skipped when
 * no DB is configured so CI stays green; runs in full once a DB is available
 * (matches the P0.3/P0.6 CI-deferred posture).
 *
 * Covers the end-to-end async flow against the REAL enqueue path + REAL runner:
 *   - enqueue creates a pending render job + a renders row + a render HOLD, and
 *     moves clips_ready→editing;
 *   - the runner (Noop render provider + local-fs storage) drains the job and,
 *     via applyJobResult, moves editing→rendered, sets renders.output_url,
 *     converts the hold→debit, and rolls up credits_spent;
 *   - insufficient balance is rejected before any hold/job is created;
 *   - a failing render provider refunds the hold and leaves the project in
 *     `editing` (re-exportable), credits_spent unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
  type RenderProvider,
} from '@coji/shared/providers';
import { eq } from 'drizzle-orm';
import {
  clips,
  creditLedger,
  frames,
  projects,
  providerJobs,
  renders,
  stagePrices,
} from '../../db/tables.ts';
import {
  type TestDb,
  applyMigrations,
  hasTestDb,
  openTestDb,
  truncateAll,
} from '../../db/testing.ts';
import { balance } from '../credits/ledger.ts';
import { type RunnerDb, runOnce } from '../jobs/runner.ts';
import { InsufficientCreditsError } from './image-stage.ts';
import { enqueueExport, getProjectClips } from './render-stage.ts';

const RUN = hasTestDb();
const RENDER_PRICE = 50;
const caller = { userId: 'user_render' };

describe.skipIf(!RUN)('P4 export/render stage (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  const baseProviders = {
    image: new NoopImageProvider(),
    animation: new NoopAnimationProvider(),
    render: new NoopRenderProvider(),
    storage: new LocalFilesystemStorageProvider({ baseDir: '.omc/tmp/storage-test-p4' }),
  };

  beforeAll(async () => {
    ({ db, client } = openTestDb());
    await applyMigrations(db);
  });
  afterAll(async () => {
    await client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(client);
    await db
      .insert(stagePrices)
      .values([{ stage: 'render', unit: 'per_export', credits: RENDER_PRICE }]);
  });

  /** Seed a project in clips_ready with 4 completed clips + a topup. */
  async function seedClipsReady(creditsToTopup = 200) {
    const [project] = await db
      .insert(projects)
      .values({ userId: caller.userId, prompt: 'a person', status: 'clips_ready' })
      .returning();
    for (let idx = 0; idx < 4; idx++) {
      const [frame] = await db
        .insert(frames)
        .values({ projectId: project!.id, idx, status: 'completed', imageRef: `k/${idx}` })
        .returning();
      await db.insert(clips).values({
        frameId: frame!.id,
        status: 'completed',
        videoUrl: `https://cdn/clip-${idx}.mp4`,
      });
    }
    if (creditsToTopup > 0) {
      await db.insert(creditLedger).values({
        userId: caller.userId,
        kind: 'topup',
        credits: creditsToTopup,
        balanceAfter: creditsToTopup,
      });
    }
    return project!;
  }

  test('enqueue creates a pending render job + renders row + hold, clips_ready→editing', async () => {
    const project = await seedClipsReady();
    const { jobId, status, renderAttempt } = await enqueueExport(db, {
      caller,
      projectId: project.id,
    });
    expect(status).toBe('enqueued');
    expect(renderAttempt).toBe(0);

    const [job] = await db.select().from(providerJobs).where(eq(providerJobs.id, jobId));
    expect(job!.kind).toBe('render');
    expect(job!.status).toBe('pending');
    expect(job!.idempotencyKey).toBe(`${project.id}:0`);
    // Composition inputProps carry the 4 clip URLs.
    const composition = (job!.payload as { composition: { clips: { videoUrl: string }[] } })
      .composition;
    expect(composition.clips).toHaveLength(4);

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('editing');
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(200 - RENDER_PRICE);
  });

  test('insufficient balance is rejected before any hold/job', async () => {
    const project = await seedClipsReady(RENDER_PRICE - 1);
    await expect(enqueueExport(db, { caller, projectId: project.id })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    const jobs = await db.select().from(providerJobs).where(eq(providerJobs.projectId, project.id));
    expect(jobs).toHaveLength(0);
  });

  test('full happy path: export → runner → rendered + hold→debit + output_url', async () => {
    const project = await seedClipsReady();
    await enqueueExport(db, { caller, projectId: project.id });

    const processed = await runOnce(db as unknown as RunnerDb, {
      instanceId: 'inst-1',
      leaseTtlMs: 60_000,
      providers: baseProviders,
    });
    expect(processed).not.toBeNull();

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('rendered');
    expect(p!.creditsSpent).toBe(RENDER_PRICE);

    const [renderRow] = await db.select().from(renders).where(eq(renders.projectId, project.id));
    expect(renderRow!.status).toBe('completed');
    expect(renderRow!.outputUrl).toBeTruthy();

    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(200 - RENDER_PRICE);
  });

  test('getProjectClips maps stored durationSeconds → durationInFrames (30fps), omits when null', async () => {
    const [project] = await db
      .insert(projects)
      .values({ userId: caller.userId, prompt: 'a person', status: 'clips_ready' })
      .returning();
    // Frame 0: known duration → durationInFrames = round(2.5 * 30) = 75.
    const [f0] = await db
      .insert(frames)
      .values({ projectId: project!.id, idx: 0, status: 'completed', imageRef: 'k/0' })
      .returning();
    await db.insert(clips).values({
      frameId: f0!.id,
      status: 'completed',
      videoUrl: 'https://cdn/clip-0.mp4',
      durationSeconds: 2.5,
    });
    // Frame 1: no duration → durationInFrames omitted.
    const [f1] = await db
      .insert(frames)
      .values({ projectId: project!.id, idx: 1, status: 'completed', imageRef: 'k/1' })
      .returning();
    await db.insert(clips).values({
      frameId: f1!.id,
      status: 'completed',
      videoUrl: 'https://cdn/clip-1.mp4',
    });

    const views = await getProjectClips(db, project!.id);
    expect(views).toHaveLength(2);
    const [v0, v1] = views;
    expect(v0!.idx).toBe(0);
    expect(v0!.durationInFrames).toBe(75);
    expect(v1!.idx).toBe(1);
    expect(v1!.durationInFrames).toBeUndefined();
  });

  test('a failing render refunds the hold and leaves the project in editing', async () => {
    const project = await seedClipsReady();
    await enqueueExport(db, { caller, projectId: project.id });

    const failingRender: RenderProvider = {
      async render() {
        throw new Error('simulated remotion failure');
      },
    };
    await runOnce(db as unknown as RunnerDb, {
      instanceId: 'inst-1',
      leaseTtlMs: 60_000,
      providers: { ...baseProviders, render: failingRender },
    });

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('editing');
    expect(p!.creditsSpent).toBe(0);

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, caller.userId));
    expect(ledger.some((e) => e.kind === 'refund')).toBe(true);
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(200);
  });
});
