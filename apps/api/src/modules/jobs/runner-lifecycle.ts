import { getProviders } from '../../config/providers.ts';
/**
 * Runner lifecycle (P1 / task #14).
 *
 * Drives the unified runner (runOnce) on a background interval for the running
 * API server. This is started EXPLICITLY from server.ts on boot — never from
 * app.ts — so `app.handle(...)` acceptance tests never spawn a timer implicitly.
 *
 * Each tick drains the queue: it calls runOnce repeatedly until no job is
 * claimable (bounded per tick to avoid starving the event loop), so a burst of
 * enqueued jobs is processed promptly rather than one-per-interval.
 */
import { db } from '../../db/index.ts';
import { env } from '../../env.ts';
import { reconcileOnce } from './reconciler.ts';
import { type RunnerDb, runOnce } from './runner.ts';

/** Drain up to `maxPerTick` claimable jobs; returns how many were processed. */
export async function drainOnce(
  database: RunnerDb,
  opts: { instanceId: string; leaseTtlMs: number; maxPerTick?: number },
): Promise<number> {
  const max = opts.maxPerTick ?? 16;
  const providers = getProviders();
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const jobId = await runOnce(database, {
      instanceId: opts.instanceId,
      leaseTtlMs: opts.leaseTtlMs,
      providers,
    });
    if (!jobId) break; // queue drained
    processed += 1;
  }
  return processed;
}

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Start the background runner loop. Idempotent: a second call is a no-op while a
 * loop is already running. No-op (returns false) when RUNNER_ENABLED is false.
 */
export function startRunner(): boolean {
  if (!env.runnerEnabled) return false;
  if (timer) return true;
  let running = false;
  timer = setInterval(async () => {
    if (running) return; // don't overlap ticks
    running = true;
    try {
      await drainOnce(db as unknown as RunnerDb, {
        instanceId: env.runnerInstanceId,
        leaseTtlMs: env.leaseTtlMs,
      });
      // Reconcile async animation jobs (poll stuck + max-age sweep).
      await reconcileTick();
    } catch (err) {
      // Never let a tick error kill the loop; log and continue.
      console.error('[runner] tick error:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, env.runnerTickMs);
  // Don't keep the process alive solely for the runner.
  timer.unref?.();
  return true;
}

/** Stop the background runner loop (used in tests / graceful shutdown). */
export function stopRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Run one animation reconciliation pass (poll stuck jobs + max-age sweep). */
export async function reconcileTick(): Promise<{
  polled: number;
  completed: number;
  failed: number;
  swept: number;
}> {
  return reconcileOnce(db as unknown as RunnerDb, {
    providers: getProviders(),
    staleMs: env.reconcileStaleMs,
    maxAgeMs: env.reconcileMaxAgeMs,
  });
}

/**
 * Run a single drain + reconcile pass on demand (the dev tick route + tests call
 * this). Returns the number of jobs the drain processed.
 */
export async function tickOnce(): Promise<number> {
  const processed = await drainOnce(db as unknown as RunnerDb, {
    instanceId: env.runnerInstanceId,
    leaseTtlMs: env.leaseTtlMs,
  });
  await reconcileTick();
  return processed;
}
