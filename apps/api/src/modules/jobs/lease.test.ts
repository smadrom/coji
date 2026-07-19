import { describe, expect, test } from 'bun:test';
import { type ClaimableRowView, isClaimable, isTerminal, leaseExpiry } from './lease.ts';

const now = new Date('2026-06-08T12:00:00.000Z');

describe('runner lease logic', () => {
  test('terminal rows are never claimable', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
  });

  test('an unclaimed non-terminal row is claimable', () => {
    const row: ClaimableRowView = { status: 'pending', claimedAt: null, leaseExpiresAt: null };
    expect(isClaimable(row, now)).toBe(true);
  });

  test('a freshly-claimed row (lease in the future) is NOT claimable', () => {
    const row: ClaimableRowView = {
      status: 'processing',
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    };
    expect(isClaimable(row, now)).toBe(false);
  });

  test('a stale-lease row (lease in the past) is reclaimable', () => {
    const row: ClaimableRowView = {
      status: 'processing',
      claimedAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000),
    };
    expect(isClaimable(row, now)).toBe(true);
  });

  test('a terminal row with an expired lease is still NOT claimable', () => {
    const row: ClaimableRowView = {
      status: 'completed',
      claimedAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000),
    };
    expect(isClaimable(row, now)).toBe(false);
  });

  test('leaseExpiry adds the TTL to now', () => {
    expect(leaseExpiry(now, 60_000).toISOString()).toBe('2026-06-08T12:01:00.000Z');
  });
});
