/**
 * One-off backfill (F2) — re-host legacy absolute-URL clips to durable R2 keys.
 *
 * Old `clips.video_url` rows may hold an ABSOLUTE provider URL (HeyGen download
 * links live ~7d; R2 presigned URLs ~30min) instead of a storage KEY we control
 * (ADR-5 / Gotcha #14 — only one early test project was hand-fixed). Those clips stop
 * playing once the URL expires. This script finds completed clips whose
 * `video_url` is still an absolute http(s) URL, downloads the bytes (if the URL
 * is still reachable) and re-hosts them under the canonical key
 * `projects/<projectId>/clips/<clipId>.mp4`, then rewrites `video_url` to the
 * KEY. Browser/render URLs are minted fresh on read (clip-storage.ts), so a key
 * is durable where an absolute URL is not.
 *
 * Properties:
 *   - Idempotent: rows already holding a key are skipped; re-running is safe.
 *   - Non-destructive on failure: an unreachable URL is logged and left as-is
 *     (so a later re-run can pick it up if the source comes back).
 *   - Server-only: it refuses to run against the local-fs/Noop default unless
 *     `--allow-local` is passed, so it never auto-fires in CI.
 *
 * Run on the SERVER, post-deploy:
 *   STORAGE_PROVIDER=s3 bun apps/api/src/scripts/backfill-clip-keys.ts
 *   # local dry/testing against the filesystem fake:
 *   bun apps/api/src/scripts/backfill-clip-keys.ts --allow-local --dry-run
 */
import { eq } from 'drizzle-orm';
import { createProviders } from '../config/providers.ts';
import { db } from '../db/index.ts';
import { clips, frames } from '../db/schema.ts';
import { env } from '../env.ts';
import { persistClip } from '../modules/jobs/clip-storage.ts';

function isAbsoluteUrl(v: string | null): v is string {
  return !!v && (v.startsWith('http://') || v.startsWith('https://'));
}

type Outcome = 'rehosted' | 'unreachable' | 'skipped';

interface Counts {
  rehosted: number;
  unreachable: number;
  skipped: number;
  total: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
}

/**
 * Core backfill — injectable db/providers so it can be unit-tested against the
 * Noop providers without touching the real env-resolved singletons.
 */
export async function backfillClipKeys(
  database: typeof db,
  providers: ReturnType<typeof createProviders>,
  opts: BackfillOptions = {},
): Promise<Counts> {
  const counts: Counts = { rehosted: 0, unreachable: 0, skipped: 0, total: 0 };

  // Completed clips joined to their frame's project (for the canonical key).
  const rows = await database
    .select({
      clipId: clips.id,
      videoUrl: clips.videoUrl,
      status: clips.status,
      projectId: frames.projectId,
    })
    .from(clips)
    .innerJoin(frames, eq(clips.frameId, frames.id))
    .where(eq(clips.status, 'completed'));

  for (const row of rows) {
    counts.total += 1;

    if (!isAbsoluteUrl(row.videoUrl)) {
      // Already a storage key (or null) — nothing to do.
      counts.skipped += 1;
      log(row.clipId, 'skipped', 'already keyed or empty');
      continue;
    }

    const key = `projects/${row.projectId}/clips/${row.clipId}.mp4`;

    if (opts.dryRun) {
      log(row.clipId, 'rehosted', `[dry-run] would re-host ${row.videoUrl} -> ${key}`);
      counts.rehosted += 1;
      continue;
    }

    try {
      // persistClip downloads the (reachable) http(s) bytes and re-stores them
      // under `key`, returning the key. It throws if the download fails.
      const storedKey = await persistClip(providers, key, row.videoUrl);
      await database.update(clips).set({ videoUrl: storedKey }).where(eq(clips.id, row.clipId));
      counts.rehosted += 1;
      log(row.clipId, 'rehosted', `${row.videoUrl} -> ${storedKey}`);
    } catch (err) {
      // Unreachable / expired source — log and leave the row untouched so a
      // later re-run can retry if the source returns.
      counts.unreachable += 1;
      log(row.clipId, 'unreachable', err instanceof Error ? err.message : String(err));
    }
  }

  return counts;
}

function log(clipId: string, outcome: Outcome, detail: string): void {
  console.log(`[backfill-clip-keys] ${outcome.padEnd(11)} clip=${clipId} ${detail}`);
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when invoked directly (not when imported by a test).
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const allowLocal = args.has('--allow-local');
  const dryRun = args.has('--dry-run');

  // Guard: never auto-run against the local-fs/Noop default (CI safety). The
  // real backfill only makes sense against S3/R2 where keys are durable.
  if (env.storageProvider !== 's3' && !allowLocal) {
    console.error(
      `[backfill-clip-keys] refusing to run: STORAGE_PROVIDER='${env.storageProvider}' (expected 's3'). Pass --allow-local to run against the filesystem fake for testing.`,
    );
    process.exit(2);
  }

  console.log(
    `[backfill-clip-keys] starting (storage=${env.storageProvider}${dryRun ? ', dry-run' : ''})`,
  );
  const counts = await backfillClipKeys(db, createProviders(), { dryRun });
  console.log(
    `[backfill-clip-keys] done: ${counts.rehosted} rehosted, ` +
      `${counts.unreachable} unreachable, ${counts.skipped} skipped (of ${counts.total} completed clips)`,
  );
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[backfill-clip-keys] fatal:', err);
    process.exit(1);
  });
}
