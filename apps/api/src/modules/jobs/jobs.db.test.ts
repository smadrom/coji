/**
 * DB-backed integration tests for the orchestration core (P0.6).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL). When no DB
 * is configured the whole suite is skipped so CI stays green; it runs in full
 * once a DB is available (CI-deferred, matching the P0.3 migration-apply call).
 *
 * Covers the task's required scenarios:
 *   - applyJobResult idempotency (double-apply = no-op)
 *   - superseded-attempt result dropped
 *   - credit hold→debit (success) and hold→refund (failure) math + credits_spent
 *   - SELECT ... FOR UPDATE SKIP LOCKED concurrent-claim (no double-claim)
 *   - stale-claim reclaim by another instance
 *   - full draft→...→rendered happy path on Noop providers + local-fs storage
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
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
import { balance, placeHold } from '../credits/ledger.ts';
import { applyJobResult } from './apply-job-result.ts';
import { claimNextJob, runOnce } from './runner.ts';

const RUN = hasTestDb();

describe.skipIf(!RUN)('orchestration core (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  const providers = {
    image: new NoopImageProvider(),
    animation: new NoopAnimationProvider(),
    render: new NoopRenderProvider(),
    storage: new LocalFilesystemStorageProvider({ baseDir: '.storage-test' }),
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
    // Seed bounded stage prices.
    await db.insert(stagePrices).values([
      { stage: 'image', unit: 'per_set', credits: 10 },
      { stage: 'animation', unit: 'per_clip', credits: 5 },
      { stage: 'render', unit: 'per_export', credits: 20 },
    ]);
  });

  async function seedProject(userId = 'user_1') {
    const [project] = await db
      .insert(projects)
      .values({ userId, prompt: 'a person in 4 shots', status: 'draft' })
      .returning();
    return project!;
  }

  async function seedImageJob(projectId: string, attempt = 0) {
    // Frames the image job will fill.
    await db
      .insert(frames)
      .values([0, 1, 2, 3].map((idx) => ({ projectId, idx, status: 'pending' as const })));
    const [job] = await db
      .insert(providerJobs)
      .values({
        projectId,
        kind: 'image',
        provider: 'noop',
        status: 'processing',
        attempts: attempt,
        idempotencyKey: `${projectId}:${attempt}`,
        payload: { prompt: 'a person in 4 shots' },
      })
      .returning();
    return job!;
  }

  test('image success: hold→debit, frames filled, credits_spent rolled up, → images_ready', async () => {
    const project = await seedProject();
    const job = await seedImageJob(project.id);
    await db.transaction(async (tx) =>
      placeHold(tx, {
        userId: project.userId,
        projectId: project.id,
        stage: 'image',
        credits: 10,
        jobId: job.id,
      }),
    );
    expect(await db.transaction((tx) => balance(tx, project.userId))).toBe(-10);

    const outcome = await applyJobResult(db, job.id, {
      status: 'completed',
      frames: [0, 1, 2, 3].map((idx) => ({ idx, imageRef: `k/${idx}`, caption: `c${idx}` })),
    });
    expect(outcome.action).toBe('applied');
    expect(outcome.projectTransition).toBe('images_ready');

    const filled = await db.select().from(frames).where(eq(frames.projectId, project.id));
    expect(filled.every((f) => f.status === 'completed' && f.imageRef)).toBe(true);

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('images_ready');
    expect(p!.creditsSpent).toBe(10);
    // hold(-10) then debit(neutral) → balance stays -10; credits_spent captures the 10.
    expect(await db.transaction((tx) => balance(tx, project.userId))).toBe(-10);
  });

  test('applyJobResult is idempotent: double-apply is a no-op', async () => {
    const project = await seedProject();
    const job = await seedImageJob(project.id);
    await db.transaction(async (tx) =>
      placeHold(tx, {
        userId: project.userId,
        projectId: project.id,
        stage: 'image',
        credits: 10,
        jobId: job.id,
      }),
    );
    const result = {
      status: 'completed' as const,
      frames: [0, 1, 2, 3].map((idx) => ({ idx, imageRef: `k/${idx}`, caption: `c${idx}` })),
    };
    const first = await applyJobResult(db, job.id, result);
    const second = await applyJobResult(db, job.id, result);
    expect(first.action).toBe('applied');
    expect(second.action).toBe('noop');

    // Exactly one debit entry for the job.
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.providerJobId, job.id));
    expect(ledger.filter((e) => e.kind === 'debit').length).toBe(1);
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.creditsSpent).toBe(10); // not double-counted
  });

  test('image failure: hold→full refund, frames failed, no credits_spent', async () => {
    const project = await seedProject();
    const job = await seedImageJob(project.id);
    await db.transaction(async (tx) =>
      placeHold(tx, {
        userId: project.userId,
        projectId: project.id,
        stage: 'image',
        credits: 10,
        jobId: job.id,
      }),
    );
    const outcome = await applyJobResult(db, job.id, { status: 'failed', failureMessage: 'boom' });
    expect(outcome.action).toBe('applied');
    expect(outcome.projectTransition).toBe('failed');

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.providerJobId, job.id));
    expect(ledger.some((e) => e.kind === 'refund')).toBe(true);
    expect(await db.transaction((tx) => balance(tx, project.userId))).toBe(0); // fully refunded
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.creditsSpent).toBe(0);
  });

  test('superseded-attempt result is dropped, current attempt untouched', async () => {
    const project = await seedProject();
    // Current row is on attempt 1.
    const job = await seedImageJob(project.id, 1);
    await db.transaction(async (tx) =>
      placeHold(tx, {
        userId: project.userId,
        projectId: project.id,
        stage: 'image',
        credits: 10,
        jobId: job.id,
      }),
    );
    // A late webhook for attempt 0 arrives.
    const outcome = await applyJobResult(db, job.id, {
      status: 'completed',
      attempt: 0,
      frames: [{ idx: 0, imageRef: 'stale', caption: 'stale' }],
    });
    expect(outcome.action).toBe('dropped');
    const [j] = await db.select().from(providerJobs).where(eq(providerJobs.id, job.id));
    expect(j!.status).toBe('processing'); // unchanged
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.providerJobId, job.id));
    expect(ledger.some((e) => e.kind === 'debit')).toBe(false);
  });

  test('SKIP LOCKED: concurrent claims never grab the same row', async () => {
    const project = await seedProject();
    // Two distinct pending jobs.
    await db.insert(providerJobs).values([
      {
        projectId: project.id,
        kind: 'render',
        provider: 'noop',
        status: 'pending',
        attempts: 0,
        idempotencyKey: `${project.id}:r0`,
        payload: {},
      },
      {
        projectId: project.id,
        kind: 'render',
        provider: 'noop',
        status: 'pending',
        attempts: 0,
        idempotencyKey: `${project.id}:r1`,
        payload: {},
      },
    ]);
    const [a, b] = await Promise.all([
      claimNextJob(db, { instanceId: 'inst-a', leaseTtlMs: 60_000 }),
      claimNextJob(db, { instanceId: 'inst-b', leaseTtlMs: 60_000 }),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id); // never the same row
  });

  test('stale-lease row is reclaimable by another instance', async () => {
    const project = await seedProject();
    const past = new Date(Date.now() - 120_000);
    const [job] = await db
      .insert(providerJobs)
      .values({
        projectId: project.id,
        kind: 'render',
        provider: 'noop',
        status: 'processing',
        attempts: 0,
        idempotencyKey: `${project.id}:stale`,
        payload: {},
        claimedAt: past,
        claimedBy: 'dead-instance',
        leaseExpiresAt: past, // lease already expired
      })
      .returning();
    const reclaimed = await claimNextJob(db, { instanceId: 'inst-live', leaseTtlMs: 60_000 });
    expect(reclaimed?.id).toBe(job!.id);
    const [row] = await db.select().from(providerJobs).where(eq(providerJobs.id, job!.id));
    expect(row!.claimedBy).toBe('inst-live');
  });

  test('full render happy path via runOnce on Noop providers', async () => {
    const project = await seedProject();
    // Put project into editing so a render can transition it to rendered.
    await db.update(projects).set({ status: 'editing' }).where(eq(projects.id, project.id));
    await db.insert(renders).values({ projectId: project.id, status: 'pending' });
    const [job] = await db
      .insert(providerJobs)
      .values({
        projectId: project.id,
        kind: 'render',
        provider: 'noop',
        status: 'pending',
        attempts: 0,
        idempotencyKey: `${project.id}:render:0`,
        payload: { composition: { clips: [] } },
      })
      .returning();
    await db.transaction(async (tx) =>
      placeHold(tx, {
        userId: project.userId,
        projectId: project.id,
        stage: 'render',
        credits: 20,
        jobId: job!.id,
      }),
    );

    const processed = await runOnce(db, {
      instanceId: 'inst-1',
      leaseTtlMs: 60_000,
      providers,
    });
    expect(processed).toBe(job!.id);

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('rendered');
    expect(p!.creditsSpent).toBe(20);
    const [r] = await db.select().from(renders).where(eq(renders.projectId, project.id));
    expect(r!.status).toBe('completed');
    expect(r!.outputUrl).toBeTruthy();
  });
});
