/**
 * applyJobResult decision logic (pure, no DB).
 *
 * `applyJobResult` is the ONLY writer of provider-job-driven FSM transitions +
 * child-row updates + ledger settlement. It must be:
 *   - idempotent: re-applying the same result is a no-op;
 *   - attempt-aware: a result for a superseded/already-retried attempt is
 *     dropped, never applied to the current attempt.
 *
 * This module decides — given the persisted job row and the incoming result —
 * whether to APPLY, NOOP (already applied), or DROP (superseded/unexpected),
 * so the DB transaction layer in ./apply-job-result.ts stays thin and the
 * branching is unit-testable without Postgres.
 */

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type ResultStatus = 'completed' | 'failed';

/** The persisted provider-job row fields the decision needs. */
export interface JobRowView {
  id: string;
  /** Current persisted status of THIS attempt row. */
  status: JobStatus;
  /** Attempt number this row represents. */
  attempts: number;
}

/** A result arriving from a webhook, reconciler, or the runner itself. */
export interface IncomingResult {
  /** The job row id the result targets (encodes the exact attempt). */
  jobId: string;
  status: ResultStatus;
  /** Attempt the producer believes it ran (optional cross-check). */
  attempt?: number;
}

export type Decision =
  | { action: 'apply'; status: ResultStatus }
  | { action: 'noop'; reason: string }
  | { action: 'drop'; reason: string };

/**
 * Decide how to handle `result` against the persisted `job` row.
 *
 * Rules:
 *  - A result whose targeted jobId differs from the row → drop (wrong target).
 *  - Job already terminal (completed/failed):
 *      - same terminal status as the result → noop (idempotent re-apply);
 *      - different terminal status → drop (superseded/conflicting attempt).
 *  - Job non-terminal (pending/processing) and result attempt (if provided)
 *    does not match the row's attempts → drop (superseded attempt).
 *  - Otherwise → apply.
 */
export function decideApplication(job: JobRowView, result: IncomingResult): Decision {
  if (result.jobId !== job.id) {
    return { action: 'drop', reason: 'result targets a different job row' };
  }

  if (job.status === 'completed' || job.status === 'failed') {
    if (job.status === result.status) {
      return { action: 'noop', reason: `job already ${job.status}` };
    }
    return {
      action: 'drop',
      reason: `job already terminal as '${job.status}', result claims '${result.status}'`,
    };
  }

  if (result.attempt !== undefined && result.attempt !== job.attempts) {
    return {
      action: 'drop',
      reason: `result for attempt ${result.attempt} but row is on attempt ${job.attempts} (superseded)`,
    };
  }

  return { action: 'apply', status: result.status };
}
