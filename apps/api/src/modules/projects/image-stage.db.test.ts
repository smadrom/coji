/**
 * DB-backed integration test for the P1 image stage (task #14).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL). Skipped when
 * no DB is configured so CI stays green; runs in full once a DB is available
 * (matches the P0.3/P0.6 CI-deferred posture).
 *
 * Covers the end-to-end async flow against the REAL enqueue path + REAL runner:
 *   - enqueue creates a pending image job + 4 frame rows + an image HOLD;
 *   - the runner (Noop image provider + local-fs storage) drains the job and,
 *     via applyJobResult, moves draft→images_ready, fills the 4 frames,
 *     converts the hold→debit, and rolls up credits_spent;
 *   - insufficient balance is rejected before any hold/job is created;
 *   - all-or-nothing: a failing image provider refunds the ENTIRE hold and
 *     leaves credits_spent at 0 (frames marked failed), no images_ready.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
} from '@coji/shared/providers';
import type { ImageProvider } from '@coji/shared/providers';
import { eq } from 'drizzle-orm';
import { creditLedger, frames, projects, providerJobs, stagePrices } from '../../db/tables.ts';
import {
  type TestDb,
  applyMigrations,
  hasTestDb,
  openTestDb,
  truncateAll,
} from '../../db/testing.ts';
import { balance } from '../credits/ledger.ts';
import { type RunnerDb, runOnce } from '../jobs/runner.ts';
import { InsufficientCreditsError, enqueueImageGeneration } from './image-stage.ts';

const RUN = hasTestDb();
const IMAGE_PRICE = 10;
const caller = { userId: 'user_1' };

describe.skipIf(!RUN)('P1 image stage (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  const baseProviders = {
    image: new NoopImageProvider(),
    animation: new NoopAnimationProvider(),
    render: new NoopRenderProvider(),
    storage: new LocalFilesystemStorageProvider({ baseDir: '.omc/tmp/storage-test-p1' }),
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
      .values([{ stage: 'image', unit: 'per_set', credits: IMAGE_PRICE }]);
  });

  async function seedProject(creditsToTopup = 100) {
    const [project] = await db
      .insert(projects)
      .values({ userId: caller.userId, prompt: 'a person in 4 shots', status: 'draft' })
      .returning();
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

  test('enqueue creates a pending job + 4 frames + a hold (no inline await)', async () => {
    const project = await seedProject();
    const { jobId, status } = await enqueueImageGeneration(db, {
      caller,
      projectId: project.id,
      imageProviderName: 'noop',
    });
    expect(status).toBe('enqueued');

    const [job] = await db.select().from(providerJobs).where(eq(providerJobs.id, jobId));
    expect(job!.kind).toBe('image');
    expect(job!.status).toBe('pending');
    expect(job!.idempotencyKey).toBe(`${project.id}:0`);

    const frameRows = await db.select().from(frames).where(eq(frames.projectId, project.id));
    expect(frameRows).toHaveLength(4);

    // Hold placed; balance dropped by the price; project still draft.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(100 - IMAGE_PRICE);
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('draft');
  });

  test('enqueue is idempotent for the same attempt (no double charge)', async () => {
    const project = await seedProject();
    const first = await enqueueImageGeneration(db, {
      caller,
      projectId: project.id,
      imageProviderName: 'noop',
    });
    const second = await enqueueImageGeneration(db, {
      caller,
      projectId: project.id,
      imageProviderName: 'noop',
    });
    expect(second.jobId).toBe(first.jobId);
    expect(second.status).toBe('already_enqueued');
    const holds = (
      await db.select().from(creditLedger).where(eq(creditLedger.providerJobId, first.jobId))
    ).filter((e) => e.kind === 'hold');
    expect(holds).toHaveLength(1);
  });

  test('insufficient balance is rejected before any hold/job', async () => {
    const project = await seedProject(IMAGE_PRICE - 1); // can't cover the price
    await expect(
      enqueueImageGeneration(db, { caller, projectId: project.id, imageProviderName: 'noop' }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    const jobs = await db.select().from(providerJobs).where(eq(providerJobs.projectId, project.id));
    expect(jobs).toHaveLength(0);
  });

  test('full happy path: enqueue → runner → images_ready + hold→debit + credits_spent', async () => {
    const project = await seedProject();
    await enqueueImageGeneration(db, { caller, projectId: project.id, imageProviderName: 'noop' });

    const processed = await runOnce(db as unknown as RunnerDb, {
      instanceId: 'inst-1',
      leaseTtlMs: 60_000,
      providers: baseProviders,
    });
    expect(processed).not.toBeNull();

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('images_ready');
    expect(p!.creditsSpent).toBe(IMAGE_PRICE);

    const frameRows = await db.select().from(frames).where(eq(frames.projectId, project.id));
    expect(frameRows.every((f) => f.status === 'completed' && f.imageRef)).toBe(true);

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, caller.userId));
    expect(ledger.some((e) => e.kind === 'debit')).toBe(true);
    // hold(-10) + debit(neutral) on a 100 topup → balance 90.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(100 - IMAGE_PRICE);
  });

  test('all-or-nothing: a failing image provider refunds the ENTIRE hold', async () => {
    const project = await seedProject();
    await enqueueImageGeneration(db, { caller, projectId: project.id, imageProviderName: 'noop' });

    const failingImage: ImageProvider = {
      async generate() {
        throw new Error('simulated gemini failure');
      },
    };

    await runOnce(db as unknown as RunnerDb, {
      instanceId: 'inst-1',
      leaseTtlMs: 60_000,
      providers: { ...baseProviders, image: failingImage },
    });

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('failed');
    expect(p!.creditsSpent).toBe(0);

    const frameRows = await db.select().from(frames).where(eq(frames.projectId, project.id));
    expect(frameRows.every((f) => f.status === 'failed')).toBe(true);

    const ledger = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, caller.userId));
    expect(ledger.some((e) => e.kind === 'refund')).toBe(true);
    // hold(-10) then full refund(+10) on a 100 topup → back to 100.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(100);
  });
});
