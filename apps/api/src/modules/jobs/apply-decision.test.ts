import { describe, expect, test } from 'bun:test';
import { type JobRowView, decideApplication } from './apply-decision.ts';

const baseJob = (over: Partial<JobRowView> = {}): JobRowView => ({
  id: 'job1',
  status: 'processing',
  attempts: 0,
  ...over,
});

describe('decideApplication', () => {
  test('applies a fresh result to a processing job', () => {
    const d = decideApplication(baseJob(), { jobId: 'job1', status: 'completed' });
    expect(d).toEqual({ action: 'apply', status: 'completed' });
  });

  test('applies a fresh failure result', () => {
    const d = decideApplication(baseJob(), { jobId: 'job1', status: 'failed' });
    expect(d).toEqual({ action: 'apply', status: 'failed' });
  });

  test('drops a result targeting a different job row', () => {
    const d = decideApplication(baseJob(), { jobId: 'other', status: 'completed' });
    expect(d.action).toBe('drop');
  });

  test('idempotent: re-applying the same terminal status is a no-op', () => {
    const completed = baseJob({ status: 'completed' });
    expect(decideApplication(completed, { jobId: 'job1', status: 'completed' }).action).toBe(
      'noop',
    );
    const failed = baseJob({ status: 'failed' });
    expect(decideApplication(failed, { jobId: 'job1', status: 'failed' }).action).toBe('noop');
  });

  test('drops a conflicting terminal result (already completed, result says failed)', () => {
    const completed = baseJob({ status: 'completed' });
    const d = decideApplication(completed, { jobId: 'job1', status: 'failed' });
    expect(d.action).toBe('drop');
  });

  test('drops a result for a superseded attempt', () => {
    // Row is on attempt 1 (it was retried); a late webhook for attempt 0 arrives.
    const job = baseJob({ attempts: 1, status: 'processing' });
    const d = decideApplication(job, { jobId: 'job1', status: 'completed', attempt: 0 });
    expect(d.action).toBe('drop');
  });

  test('applies when the result attempt matches the row attempt', () => {
    const job = baseJob({ attempts: 1, status: 'processing' });
    const d = decideApplication(job, { jobId: 'job1', status: 'completed', attempt: 1 });
    expect(d).toEqual({ action: 'apply', status: 'completed' });
  });

  test('applies to a pending job (runner picked it up then resolved)', () => {
    const job = baseJob({ status: 'pending' });
    expect(decideApplication(job, { jobId: 'job1', status: 'completed' }).action).toBe('apply');
  });
});
