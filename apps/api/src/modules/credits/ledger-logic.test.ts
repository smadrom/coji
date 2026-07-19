import { describe, expect, test } from 'bun:test';
import {
  type LedgerEntryView,
  canAfford,
  computeEffect,
  holdAmountForJob,
  isSettlementNoop,
  ledgerDelta,
} from './ledger-logic.ts';

describe('ledger pure logic', () => {
  test('hold reserves funds (negative delta)', () => {
    expect(ledgerDelta('hold', 10)).toBe(-10);
  });

  test('debit is a balance-neutral settlement of an existing hold', () => {
    expect(ledgerDelta('debit', 10)).toBe(0);
  });

  test('refund returns the held funds (positive delta)', () => {
    expect(ledgerDelta('refund', 10)).toBe(10);
  });

  test('topup adds funds (positive delta)', () => {
    expect(ledgerDelta('topup', 50)).toBe(50);
  });

  test('credits magnitude is used regardless of sign passed in', () => {
    expect(ledgerDelta('hold', -10)).toBe(-10);
    expect(ledgerDelta('refund', -10)).toBe(10);
  });

  test('full hold→debit→(no refund) cycle math', () => {
    // start 100, topup 0
    let balance = 100;
    // place a hold of 30
    const afterHold = computeEffect('hold', 30, balance);
    expect(afterHold.balanceAfter).toBe(70);
    balance = afterHold.balanceAfter;
    // success: debit settles the hold, balance unchanged (hold was the deduction)
    const afterDebit = computeEffect('debit', 30, balance);
    expect(afterDebit.balanceAfter).toBe(70);
  });

  test('full hold→refund cycle returns to the starting balance', () => {
    let balance = 100;
    const afterHold = computeEffect('hold', 30, balance);
    balance = afterHold.balanceAfter;
    expect(balance).toBe(70);
    const afterRefund = computeEffect('refund', 30, balance);
    expect(afterRefund.balanceAfter).toBe(100);
  });

  test('isSettlementNoop detects an existing settlement of the same kind for the job', () => {
    const existing: LedgerEntryView[] = [
      { kind: 'hold', credits: 30, providerJobId: 'job1' },
      { kind: 'debit', credits: 30, providerJobId: 'job1' },
    ];
    expect(isSettlementNoop('job1', 'debit', existing)).toBe(true);
    expect(isSettlementNoop('job1', 'refund', existing)).toBe(false);
    expect(isSettlementNoop('job2', 'debit', existing)).toBe(false);
  });

  test('holdAmountForJob returns the held magnitude or undefined', () => {
    const existing: LedgerEntryView[] = [{ kind: 'hold', credits: 30, providerJobId: 'job1' }];
    expect(holdAmountForJob('job1', existing)).toBe(30);
    expect(holdAmountForJob('job2', existing)).toBeUndefined();
  });

  test('canAfford gates a hold against the current balance', () => {
    expect(canAfford(100, 100)).toBe(true);
    expect(canAfford(100, 101)).toBe(false);
    expect(canAfford(0, 1)).toBe(false);
  });
});
