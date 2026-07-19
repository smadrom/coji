/**
 * Runner lease / stale-claim pure logic (no DB).
 *
 * The unified runner claims `provider_jobs` rows with
 * `SELECT ... FOR UPDATE SKIP LOCKED`, stamping `claimed_at`/`claimed_by` and
 * `lease_expires_at = now + LEASE_TTL`. A non-terminal row whose lease has
 * expired is reclaimable by another instance; the original instance's late
 * `applyJobResult` is then dropped as a superseded attempt (see apply-decision).
 *
 * These helpers keep the claim-eligibility math testable without Postgres; the
 * actual atomic claim is a single SQL UPDATE ... WHERE (see ./runner.ts).
 */

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ClaimableRowView {
  status: JobStatus;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
}

/** Terminal rows are never claimable. */
export function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * A row is claimable when it is non-terminal AND either:
 *   - unclaimed (no lease), or
 *   - its lease has expired (stale claim → reclaimable).
 */
export function isClaimable(row: ClaimableRowView, now: Date): boolean {
  if (isTerminal(row.status)) return false;
  if (row.leaseExpiresAt === null) return true; // never claimed
  return row.leaseExpiresAt.getTime() <= now.getTime(); // lease lapsed
}

/** Compute the new lease expiry for a claim made at `now`. */
export function leaseExpiry(now: Date, leaseTtlMs: number): Date {
  return new Date(now.getTime() + leaseTtlMs);
}
