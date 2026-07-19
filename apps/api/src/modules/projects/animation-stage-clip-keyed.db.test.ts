/**
 * DB-backed tests for the clip-keyed animation stage (clip-composer / WS4+WS7).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL); skipped in
 * CI. Run on central: `bun test apps/api/src/modules/projects/animation-stage-clip-keyed.db.test.ts`
 *
 * Key differences from the legacy animation-stage.db.test.ts (frame-keyed):
 *   - Idempotency key is `${clipId}:${attempt}`, NOT `${frameId}:${attempt}`.
 *   - A frame may back multiple clips (reuse); each clip settles independently.
 *   - compose 9 clips from 4 frames → 9 jobs / 9 holds, each keyed by clipId.
 *   - Double-call to enqueueAnimation is a no-op (idempotent on the attempt set).
 *   - Regenerate one failed clip (retryAnimationClip) places exactly one new hold
 *     under the next attempt; the other clips are unaffected.
 *   - Credit ledger nets to per_clip × N_succeeded after settlement.
 *
 * Uses Noop providers + local-fs storage — never calls a paid API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  LocalFilesystemStorageProvider,
  NoopAnimationProvider,
  NoopImageProvider,
  NoopRenderProvider,
} from '@coji/shared/providers';
import type { AnimationProvider, AnimationResult, Providers } from '@coji/shared/providers';
import { eq, inArray } from 'drizzle-orm';
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
import {
  animationIdempotencyKey,
  enqueueAnimation,
  retryAnimationClip,
} from './animation-stage.ts';

const RUN = hasTestDb();
const PER_CLIP = 5;
const caller = { userId: 'user_clipkeyed' };

/** Run the submit + reconcile loop until no more jobs are claimable. */
async function drainAndReconcile(db: RunnerDb, providers: Providers, rounds = 4) {
  for (let r = 0; r < rounds; r++) {
    while ((await runOnce(db, { instanceId: 'inst', leaseTtlMs: 60_000, providers })) !== null) {
      /* drain submits */
    }
    await reconcileOnce(db, { providers, staleMs: 0, maxAgeMs: 60 * 60_000 });
  }
}

describe.skipIf(!RUN)('clip-keyed animation stage (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  const providers: Providers = {
    image: new NoopImageProvider(),
    animation: new NoopAnimationProvider(),
    render: new NoopRenderProvider(),
    storage: new LocalFilesystemStorageProvider({
      baseDir: '.omc/tmp/storage-test-clip-keyed',
    }),
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

  /**
   * Seed a project in `composing` with 4 completed frames + a balance. The
   * project is ready to have a composition authored and then animated.
   */
  async function seedComposingProject(topup = 1000) {
    const [project] = await db
      .insert(projects)
      .values({
        userId: caller.userId,
        prompt: 'multi-beat ad',
        status: 'composing',
        audioMode: 'tts',
        script: 'Beat one. Beat two. Beat three. Beat four. Beat five.',
        voiceId: 'voice_1',
      })
      .returning();
    const frameRows = await db
      .insert(frames)
      .values(
        [0, 1, 2, 3].map((idx) => ({
          projectId: project!.id,
          idx,
          status: 'completed' as const,
          imageRef: `projects/${project!.id}/frames/${idx}.jpg`,
        })),
      )
      .returning();
    if (topup > 0) {
      await db
        .insert(creditLedger)
        .values({ userId: caller.userId, kind: 'topup', credits: topup, balanceAfter: topup });
    }
    return { project: project!, frames: frameRows };
  }

  /**
   * Insert N clip rows referencing the project's frames (cycling through 4 frames
   * so reuse is exercised). Returns the inserted clip ids.
   */
  async function seedComposition(
    projectId: string,
    frameRows: (typeof frames.$inferSelect)[],
    n: number,
  ) {
    const values = Array.from({ length: n }, (_, i) => ({
      frameId: frameRows[i % frameRows.length]!.id,
      script: `Beat ${i + 1} spoken line.`,
      orderIdx: i,
      status: 'pending' as const,
      attempt: 0,
    }));
    const inserted = await db.insert(clips).values(values).returning({ id: clips.id });
    return inserted.map((r) => r.id);
  }

  // -------------------------------------------------------------------------

  test('9 clips from 4 frames → 9 jobs keyed by clipId:0, 9 holds placed', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    const clipIds = await seedComposition(project.id, frameRows, 9);

    const { jobIds, status } = await enqueueAnimation(db, { caller, projectId: project.id });

    expect(status).toBe('enqueued');
    expect(jobIds).toHaveLength(9);

    // Each job's idempotency_key must be ${clipId}:0.
    const jobs = await db
      .select({ idempotencyKey: providerJobs.idempotencyKey, payload: providerJobs.payload })
      .from(providerJobs)
      .where(eq(providerJobs.projectId, project.id));
    expect(jobs).toHaveLength(9);

    for (const clipId of clipIds) {
      const expectedKey = animationIdempotencyKey(clipId, 0);
      expect(jobs.some((j) => j.idempotencyKey === expectedKey)).toBe(true);
      // payload.clipId matches the clip id used as the key.
      const job = jobs.find((j) => j.idempotencyKey === expectedKey);
      expect((job!.payload as { clipId: string }).clipId).toBe(clipId);
    }

    // 9 holds placed; balance down by 9 × PER_CLIP.
    const bal = await db.transaction((tx) => balance(tx, caller.userId));
    expect(bal).toBe(1000 - 9 * PER_CLIP);

    // Project moved to animating.
    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('animating');
  });

  test('frame reuse: 2 clips sharing 1 frame each get their own independent job', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    // Both clips reference the SAME frame (index 0) — the defining reuse case.
    const [c1] = await db
      .insert(clips)
      .values({
        frameId: frameRows[0]!.id,
        script: 'Line A.',
        orderIdx: 0,
        status: 'pending',
        attempt: 0,
      })
      .returning({ id: clips.id });
    const [c2] = await db
      .insert(clips)
      .values({
        frameId: frameRows[0]!.id,
        script: 'Line B.',
        orderIdx: 1,
        status: 'pending',
        attempt: 0,
      })
      .returning({ id: clips.id });

    await enqueueAnimation(db, { caller, projectId: project.id });

    const jobs = await db
      .select({ ikey: providerJobs.idempotencyKey, payload: providerJobs.payload })
      .from(providerJobs)
      .where(eq(providerJobs.projectId, project.id));

    // 2 separate jobs — one per clip, NOT one per frame.
    expect(jobs).toHaveLength(2);
    const keys = jobs.map((j) => j.ikey);
    expect(keys).toContain(animationIdempotencyKey(c1!.id, 0));
    expect(keys).toContain(animationIdempotencyKey(c2!.id, 0));

    // Each job's payload.clipId must be its own clip.
    const jobByClip1 = jobs.find((j) => j.ikey === animationIdempotencyKey(c1!.id, 0));
    const jobByClip2 = jobs.find((j) => j.ikey === animationIdempotencyKey(c2!.id, 0));
    expect((jobByClip1!.payload as { clipId: string }).clipId).toBe(c1!.id);
    expect((jobByClip2!.payload as { clipId: string }).clipId).toBe(c2!.id);
  });

  test('double-call to enqueueAnimation is a no-op (idempotent)', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    await seedComposition(project.id, frameRows, 4);

    await enqueueAnimation(db, { caller, projectId: project.id });
    const { status: s2 } = await enqueueAnimation(db, { caller, projectId: project.id });

    // Second call must return already_enqueued, not place a second set of holds.
    expect(s2).toBe('already_enqueued');
    const jobCount = (
      await db.select().from(providerJobs).where(eq(providerJobs.projectId, project.id))
    ).length;
    expect(jobCount).toBe(4);
    // Balance still only down 4 × PER_CLIP (not 8).
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000 - 4 * PER_CLIP);
  });

  test('9 clips all complete → clips_ready; ledger nets to 9×PER_CLIP debit', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    await seedComposition(project.id, frameRows, 9);

    await enqueueAnimation(db, { caller, projectId: project.id });
    await drainAndReconcile(db as unknown as RunnerDb, providers);

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(p!.status).toBe('clips_ready');
    expect(p!.creditsSpent).toBe(9 * PER_CLIP);

    const allClips = await db.select().from(clips);
    expect(allClips.filter((c) => c.status === 'completed').length).toBe(9);
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(1000 - 9 * PER_CLIP);
  });

  test('1-of-9 fails → clips_ready (settle-based); failed clip refunded', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    const clipIds = await seedComposition(project.id, frameRows, 9);
    await enqueueAnimation(db, { caller, projectId: project.id });

    // Make the provider fail exactly one clip's job.
    const failClipId = clipIds[0]!;
    const failKey = animationIdempotencyKey(failClipId, 0);
    const flaky: AnimationProvider = {
      async submit(input) {
        if (input.callbackId === failKey) {
          throw new Error('terminal: simulated failure for clip 0');
        }
        return { externalId: `ok-${input.callbackId}` };
      },
      async fetchResult(externalId): Promise<AnimationResult> {
        return { externalId, status: 'completed', videoUrl: `noop://clip/${externalId}.mp4` };
      },
    };

    await drainAndReconcile(db as unknown as RunnerDb, { ...providers, animation: flaky });

    const [p] = await db.select().from(projects).where(eq(projects.id, project.id));
    // All clips settled with ≥1 success → clips_ready (not stranded on animating).
    expect(p!.status).toBe('clips_ready');

    // 1 hold refunded → balance back up by 1×PER_CLIP.
    expect(await db.transaction((tx) => balance(tx, caller.userId))).toBe(
      1000 - 9 * PER_CLIP + 1 * PER_CLIP,
    );

    const allClips = await db.select().from(clips);
    expect(allClips.filter((c) => c.status === 'completed').length).toBe(8);
    expect(allClips.filter((c) => c.status === 'failed').length).toBe(1);
  });

  test('retryAnimationClip places one new hold under clipId:1 (next attempt)', async () => {
    const { project, frames: frameRows } = await seedComposingProject();
    const clipIds = await seedComposition(project.id, frameRows, 3);
    await enqueueAnimation(db, { caller, projectId: project.id });

    // Submit only (no resolve) so the project stays in `animating`.
    while (
      (await runOnce(db as unknown as RunnerDb, {
        instanceId: 'i',
        leaseTtlMs: 60_000,
        providers,
      })) !== null
    ) {
      /* drain */
    }

    const clipToRetry = clipIds[0]!;
    const balBefore = await db.transaction((tx) => balance(tx, caller.userId));

    const { attempt } = await retryAnimationClip(db, {
      caller,
      projectId: project.id,
      clipId: clipToRetry,
    });

    expect(attempt).toBe(1);

    // New idempotency key is clipId:1.
    const newJob = await db
      .select()
      .from(providerJobs)
      .where(eq(providerJobs.idempotencyKey, animationIdempotencyKey(clipToRetry, 1)));
    expect(newJob).toHaveLength(1);
    expect((newJob[0]!.payload as { clipId: string }).clipId).toBe(clipToRetry);

    // One additional hold placed; balance down one more PER_CLIP.
    const balAfter = await db.transaction((tx) => balance(tx, caller.userId));
    expect(balAfter).toBe(balBefore - PER_CLIP);

    // The retried clip is back to pending.
    const [clipRow] = await db.select().from(clips).where(eq(clips.id, clipToRetry));
    expect(clipRow!.status).toBe('pending');
  });

  test('insufficient balance → 402, no holds placed, no jobs created', async () => {
    // Seed with exactly zero credits.
    const { project, frames: frameRows } = await seedComposingProject(0);
    await seedComposition(project.id, frameRows, 4);

    await expect(enqueueAnimation(db, { caller, projectId: project.id })).rejects.toMatchObject({
      status: 402,
    });

    const jobCount = (
      await db.select().from(providerJobs).where(eq(providerJobs.projectId, project.id))
    ).length;
    expect(jobCount).toBe(0);
  });

  test('getProjectClips returns clips in order_idx order (not frames.idx)', async () => {
    const { project, frames: frameRows } = await seedComposingProject();

    // Insert clips in REVERSE order_idx order to verify ORDER BY order_idx.
    await db.insert(clips).values([
      { frameId: frameRows[3]!.id, script: 'Last.', orderIdx: 3, status: 'pending', attempt: 0 },
      { frameId: frameRows[0]!.id, script: 'First.', orderIdx: 0, status: 'pending', attempt: 0 },
      { frameId: frameRows[2]!.id, script: 'Third.', orderIdx: 2, status: 'pending', attempt: 0 },
      { frameId: frameRows[1]!.id, script: 'Second.', orderIdx: 1, status: 'pending', attempt: 0 },
    ]);

    const { getProjectClips } = await import('./render-stage.ts');
    const result = await getProjectClips(db, project.id);

    expect(result.map((c) => c.script)).toEqual(['First.', 'Second.', 'Third.', 'Last.']);
    expect(result.map((c) => c.idx)).toEqual([0, 1, 2, 3]);
  });
});
