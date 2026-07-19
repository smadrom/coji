/** Jobs module barrel: the runner + the single applyJobResult writer. */
export {
  applyJobResult,
  type ApplyOutcome,
  type ApplyResult,
  type DbLike,
} from './apply-job-result.ts';
export {
  claimNextJob,
  executeJob,
  runOnce,
  type ClaimedJob,
  type RunnerDb,
  type RunnerOptions,
} from './runner.ts';
export {
  decideApplication,
  type Decision,
  type IncomingResult,
  type JobRowView,
} from './apply-decision.ts';
export { isClaimable, isTerminal, leaseExpiry, type ClaimableRowView } from './lease.ts';
export { resolveProjectTransition, type TransitionContext } from './transition-policy.ts';
