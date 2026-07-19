import { describe, expect, test } from 'bun:test';
import { JOB_KINDS, PROJECT_STATUSES } from '@coji/shared';
import { getTableName } from 'drizzle-orm';
import {
  audioModeEnum,
  clips,
  creditLedger,
  frames,
  jobKindEnum,
  jobStatusEnum,
  ledgerKindEnum,
  projectStatusEnum,
  projects,
  providerJobs,
  renders,
  stagePriceUnitEnum,
  stagePrices,
} from './tables.ts';

describe('coji Drizzle schema', () => {
  test('exports the expected tables with snake_case names', () => {
    expect(getTableName(projects)).toBe('projects');
    expect(getTableName(frames)).toBe('frames');
    expect(getTableName(clips)).toBe('clips');
    expect(getTableName(renders)).toBe('renders');
    expect(getTableName(providerJobs)).toBe('provider_jobs');
    expect(getTableName(stagePrices)).toBe('stage_prices');
    expect(getTableName(creditLedger)).toBe('credit_ledger');
  });

  test('enum value lists are single-sourced from @coji/shared where shared', () => {
    expect(projectStatusEnum.enumValues).toEqual([...PROJECT_STATUSES]);
    expect(jobKindEnum.enumValues).toEqual([...JOB_KINDS]);
  });

  test('bounded pricing units only (no usage-metered units in v1)', () => {
    expect(stagePriceUnitEnum.enumValues).toEqual(['per_set', 'per_clip', 'per_export']);
  });

  test('ledger kinds are hold/debit/refund/topup', () => {
    expect(ledgerKindEnum.enumValues).toEqual(['hold', 'debit', 'refund', 'topup']);
  });

  test('provider-job status mirrors the verified HeyGen vocabulary', () => {
    expect(jobStatusEnum.enumValues).toEqual(['pending', 'processing', 'completed', 'failed']);
  });

  test('audio mode is tts | audio_url', () => {
    expect(audioModeEnum.enumValues).toEqual(['tts', 'audio_url']);
  });

  test('idempotency_key is unique on provider_jobs (per-attempt rows)', () => {
    expect(providerJobs.idempotencyKey.isUnique).toBe(true);
  });

  test('ownership + parent references are NOT NULL on runtime rows', () => {
    expect(projects.userId.notNull).toBe(true);
    expect(frames.projectId.notNull).toBe(true);
    expect(clips.frameId.notNull).toBe(true);
    expect(renders.projectId.notNull).toBe(true);
    expect(providerJobs.projectId.notNull).toBe(true);
    expect(creditLedger.userId.notNull).toBe(true);
  });

  test('credits_spent and render_attempt default to 0', () => {
    expect(projects.creditsSpent.default).toBe(0);
    expect(projects.renderAttempt.default).toBe(0);
  });

  test('ledger nullable links: project_id and provider_job_id are nullable', () => {
    expect(creditLedger.projectId.notNull).toBe(false);
    expect(creditLedger.providerJobId.notNull).toBe(false);
  });
});
