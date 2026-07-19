import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  CreditLedgerEntrySchema,
  FrameSchema,
  ProjectSchema,
  ProviderJobSchema,
  StagePriceSchema,
} from './schema.ts';

describe('projects TypeBox schemas', () => {
  test('a well-formed project validates', () => {
    const project = {
      id: '00000000-0000-0000-0000-000000000001',
      userId: 'user_1',
      prompt: 'a woman walking through a city in 4 shots',
      status: 'draft',
      audioMode: 'tts',
      script: null,
      voiceId: null,
      audioUrl: null,
      style: 'american',
      locale: 'en-US',
      gender: 'female',
      creditsSpent: 0,
      renderAttempt: 0,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    expect(Value.Check(ProjectSchema, project)).toBe(true);
  });

  test('an illegal project status is rejected', () => {
    const project = {
      id: '00000000-0000-0000-0000-000000000001',
      userId: 'user_1',
      prompt: 'x',
      status: 'bogus_state',
      audioMode: 'tts',
      script: null,
      voiceId: null,
      audioUrl: null,
      creditsSpent: 0,
      renderAttempt: 0,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    expect(Value.Check(ProjectSchema, project)).toBe(false);
  });

  test('frame idx is bounded to 0..3', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000002',
      projectId: '00000000-0000-0000-0000-000000000001',
      imageRef: 'projects/1/frames/0.png',
      caption: 'shot 1',
      status: 'completed',
      createdAt: '2026-06-08T00:00:00.000Z',
    };
    expect(Value.Check(FrameSchema, { ...base, idx: 0 })).toBe(true);
    expect(Value.Check(FrameSchema, { ...base, idx: 3 })).toBe(true);
    expect(Value.Check(FrameSchema, { ...base, idx: 4 })).toBe(false);
  });

  test('provider job accepts jsonb payload and bounded kind/status', () => {
    const job = {
      id: '00000000-0000-0000-0000-000000000003',
      projectId: '00000000-0000-0000-0000-000000000001',
      kind: 'image',
      provider: 'noop',
      externalId: null,
      status: 'pending',
      attempts: 0,
      idempotencyKey: '00000000-0000-0000-0000-000000000001:0',
      payload: { foo: 'bar' },
      result: null,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    expect(Value.Check(ProviderJobSchema, job)).toBe(true);
    expect(Value.Check(ProviderJobSchema, { ...job, kind: 'audio' })).toBe(false);
  });

  test('stage price only accepts bounded units', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000004',
      stage: 'image',
      credits: 10,
      notes: null,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    expect(Value.Check(StagePriceSchema, { ...base, unit: 'per_set' })).toBe(true);
    expect(Value.Check(StagePriceSchema, { ...base, unit: 'per_clip_second' })).toBe(false);
  });

  test('ledger entry accepts the four kinds and nullable links', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000005',
      userId: 'user_1',
      projectId: null,
      stage: null,
      credits: 100,
      balanceAfter: 100,
      providerJobId: null,
      createdAt: '2026-06-08T00:00:00.000Z',
    };
    for (const kind of ['hold', 'debit', 'refund', 'topup']) {
      expect(Value.Check(CreditLedgerEntrySchema, { ...base, kind })).toBe(true);
    }
    expect(Value.Check(CreditLedgerEntrySchema, { ...base, kind: 'chargeback' })).toBe(false);
  });
});
