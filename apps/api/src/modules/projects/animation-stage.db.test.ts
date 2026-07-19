/**
 * DB-backed integration test for the P3 animation stage (task #18).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL); skipped
 * otherwise so CI stays green. Exercises the REAL enqueue + runner (submit) +
 * reconciler (resolve) + applyJobResult settlement on Noop providers + local-fs:
 *   - continue → 4 animation jobs + per-clip holds; runner submits; reconciler
 *     resolves all 4 → clips_ready + 4 hold→debit + credits_spent;
 *   - 2-of-4 terminally fail → clips_ready (settle-based: ≥1 success advances;
 *     failed clips refunded, succeeded debited);
 *   - all 4 fail → failed (full refund);
 *   - retryAnimationFrame bumps the attempt + resets the clip while animating;
 *   - reconciler completes a job whose webhook was "lost";
 *   - max-age sweep moves a stuck job → failed (refund).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
} from '@coji/shared/providers';
import type { AnimationProvider, AnimationResult, Providers } from '@coji/shared/providers';
import { eq } from 'drizzle-orm';
import {
  clips,
  creditLedger,
  frames,
  projects,
  providerJobs,
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
import { reconcileOnce } from '../jobs/reconciler.ts';
import { type RunnerDb, runOnce } from '../jobs/runner.ts';
import { enqueueAnimation, retryAnimationFrame } from './animation-stage.ts';

const RUN = hasTestDb();
const PER_CLIP = 5;
const caller = { userId: 'user_anim' };

/** Drain all claimable jobs (submit pass) then reconcile (resolve pass), N times. */
async function drainAndReconcile(db: RunnerDb, providers: Providers, rounds = 3) {
  for (let r = 0; r < rounds; r++) {
    while ((await runOnce(db, { instanceId: 'inst', leaseTtlMs: 60_000, providers })) !== null) {
      /* drain submits */
    }
    await reconcileOnce(db, { providers, staleMs: 0, maxAgeMs: 60 * 60_000 });
  }
}

describe.skipIf(!RUN)('P3 animation stage (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  const providers: Providers = {
    image: new NoopImageProvider(),
    animation: new NoopAnimationProvider(),
    render: new NoopRenderProvider(),
    storage: new LocalFilesystemStorageProvider({ baseDir: '.omc/tmp/storage-test-p3' }),
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
      .values([{ stage: 'animation', unit: 'per_clip', credits: PER_CLIP }]);
  });

  /** Seed a project in awaiting_decision with 4 completed frames + a balance. */
  async function seedReadyProject(topup = 1000) {
    const [project] = await db
      .insert(projects)
      .values({
        userId: caller.userId,
        prompt: 'p',
        status: 'awaiting_decision',
        audioMode: 'tts',
        script: 'hello world',
        voiceId: 'voice_1',
      })
      .returning();
    await db.insert(frames).values(
      [0, 1, 2, 3].map((idx) => ({
        projectId: project!.id,
        idx,
        status: 'completed' as const,
        imageRef: `projects/${project!.id}/frames/${idx}`,
      })),
    );
    if (topup > 0) {
      await db
        .insert(creditLedger)
        .values({ userId: caller.userId, kind: 'topup', credits: topup, balanceAfter: topup });
    }
    return project!;
  }

  test('continue → 4 jobs + per-clip holds; runner+reconciler → clips_ready + debits', async () => {
    const project = await seedReadyProject();
    const { jobIds } = await enqueueAnimation(db, { caller, projectId: project.id });
    expect(jobIds).toHaveLength(4);

    // 4 holds placed; balance dropped by 4 × per_clip; project animating.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000 - 4 * PER_CLIP);
    let [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('animating');

    await drainAndReconcile(db as unknown as RunnerDb, providers);

    [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('clips_ready');
    expect(p!.creditsSpent).toBe(4 * PER_CLIP);

    const clipRows = await db.select().from(clips);
    expect(clipRows.length).toBe(4);
    expect(clipRows.every((c) => c.status === 'completed' && c.videoUrl)).toBe(true);
    // 4 holds (-) + 4 debits (neutral) → balance still down 4×per_clip.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000 - 4 * PER_CLIP);
  });

  test('2-of-4 terminally fail → clips_ready (settle-based; failed clips refunded)', async () => {
    const project = await seedReadyProject();
    await enqueueAnimation(db, { caller, projectId: project.id });

    // A provider that terminally fails the first two frames (by frameRef idx).
    const failFrames = new Set<string>();
    const allFrames = await db.select().from(frames).where(eq(frames.projectId, project.id));
    for (const f of allFrames.filter((x) => x.idx < 2)) failFrames.add(f.imageRef as string);

    const flaky: AnimationProvider = {
      async submit(input) {
        if (failFrames.has(input.frameRef)) {
          throw new Error('terminal: simulated heygen failure');
        }
        return { externalId: `ok-${input.callbackId}` };
      },
      async fetchResult(externalId): Promise<AnimationResult> {
        return { externalId, status: 'completed', videoUrl: `noop://clip/${externalId}.mp4` };
      },
    };

    await drainAndReconcile(db as unknown as RunnerDb, { ...providers, animation: flaky });

    // 2 succeeded, 2 terminally failed → all clips settled with ≥1 success, so
    // the project advances to clips_ready (a terminal clip failure must not
    // strand it on the animating spinner). The editor/render works with the 2.
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('clips_ready');

    // Refund happened for the 2 failed frames: balance back up by 2×per_clip.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(
      1000 - 4 * PER_CLIP + 2 * PER_CLIP,
    );

    // Exactly 2 clips completed, 2 failed.
    const clipRows = await db.select().from(clips);
    expect(clipRows.filter((c) => c.status === 'completed').length).toBe(2);
    expect(clipRows.filter((c) => c.status === 'failed').length).toBe(2);
  });

  test('all 4 clips fail → project failed (full refund)', async () => {
    const project = await seedReadyProject();
    await enqueueAnimation(db, { caller, projectId: project.id });

    const allFail: AnimationProvider = {
      async submit() {
        throw new Error('terminal: simulated heygen failure');
      },
      async fetchResult(externalId): Promise<AnimationResult> {
        return { externalId, status: 'failed', failureMessage: 'x' };
      },
    };

    await drainAndReconcile(db as unknown as RunnerDb, { ...providers, animation: allFail });

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('failed');
    // All 4 holds refunded → back to the original balance.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000);
  });

  test('retryAnimationFrame bumps the attempt + resets the clip while animating', async () => {
    const project = await seedReadyProject();
    await enqueueAnimation(db, { caller, projectId: project.id });
    const allFrames = await db.select().from(frames).where(eq(frames.projectId, project.id));

    // Submit-only (no resolve) keeps the project in `animating` with clips
    // pending — the window in which a frame can be retried.
    while (
      (await runOnce(db as unknown as RunnerDb, {
        instanceId: 'i',
        leaseTtlMs: 60_000,
        providers,
      })) !== null
    ) {
      /* submit all */
    }
    const [p0] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p0!.status).toBe('animating');

    const { attempt } = await retryAnimationFrame(db, {
      caller,
      projectId: project.id,
      frameId: allFrames[0]!.id,
    });
    expect(attempt).toBe(1);
    const clipRows = await db.select().from(clips).where(eq(clips.frameId, allFrames[0]!.id));
    expect(clipRows[0]!.status).toBe('pending');
  });

  test('reconciler completes a job whose webhook was "lost"', async () => {
    const project = await seedReadyProject();
    await enqueueAnimation(db, { caller, projectId: project.id });
    // Submit pass only (no resolution) — simulates webhooks never arriving.
    while (
      (await runOnce(db as unknown as RunnerDb, {
        instanceId: 'i',
        leaseTtlMs: 60_000,
        providers,
      })) !== null
    ) {
      /* submit all */
    }
    let clipRows = await db.select().from(clips);
    expect(clipRows.every((c) => c.status === 'pending')).toBe(true);

    // Reconciler polls (staleMs 0) and resolves them via the Noop fetchResult.
    await reconcileOnce(db as unknown as RunnerDb, {
      providers,
      staleMs: 0,
      maxAgeMs: 60 * 60_000,
    });

    clipRows = await db.select().from(clips);
    expect(clipRows.every((c) => c.status === 'completed')).toBe(true);
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('clips_ready');
  });

  test('max-age sweep moves a stuck job → failed + refund', async () => {
    const project = await seedReadyProject();
    await enqueueAnimation(db, { caller, projectId: project.id });
    // Don't submit/resolve. Sweep everything older than maxAge 0 → failed+refund.
    const before = await db.transaction((tx) => balance(tx, caller.userId));
    expect(before).toBe(1000 - 4 * PER_CLIP);

    const res = await reconcileOnce(db as unknown as RunnerDb, {
      providers,
      staleMs: 60_000,
      maxAgeMs: 0,
    });
    expect(res.swept).toBe(4);

    const jobs = await db.select().from(providerJobs).where(eq(providerJobs.projectId, project.id));
    expect(jobs.every((j) => j.status === 'failed')).toBe(true);
    // All 4 holds refunded → back to the original balance.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000);
  });
});
