/**
 * Credit-ledger pure logic (no DB) — the decision/math layer behind the
 * DB-backed ledger operations in ./ledger.ts.
 *
 * Keeping the math and idempotency decisions pure makes them unit-testable
 * without a live Postgres: the DB layer reads the current balance + any
 * existing settlement row, asks these functions what to do, then writes.
 *
 * Ledger model (ADR-6): append-only entries; user balance = latest
 * `balance_after`. Each paid stage: hold → debit (success) / refund (failure).
 * Settlement entries (debit/refund) are keyed to a provider_job_id so a
 * double-apply is a no-op.
 */
import type { LedgerKind } from './types.ts';

/** A minimal view of an existing ledger entry needed for decisions. */
export interface LedgerEntryView {
  kind: LedgerKind;
  credits: number;
  providerJobId: string | null;
}

/** The computed effect of appending a new entry. */
export interface LedgerEffect {
  /** Signed delta applied to the running balance (hold/debit negative, refund/topup positive). */
  delta: number;
  /** Resulting balance after applying `delta` to `currentBalance`. */
  balanceAfter: number;
}

/**
 * Sign convention for each ledger kind's effect on the running balance.
 *   hold   → reserve funds now (negative)
 *   debit  → settle a hold as a real charge; the hold already moved the balance,
 *            so a debit is balance-neutral (the hold IS the deduction).
 *   refund → release a hold back to the user (positive)
 *   topup  → add funds (positive)
 *
 * This "hold = the deduction, debit = neutral settlement, refund = give back"
 * model keeps `balance_after` monotonic-friendly and makes
 * `credits_spent = sum(holds settled as debit)` straightforward.
 */
export function ledgerDelta(kind: LedgerKind, credits: number): number {
  const amount = Math.abs(credits);
  switch (kind) {
    case 'hold':
      return -amount;
    case 'refund':
      return amount;
    case 'topup':
      return amount;
    case 'debit':
      return 0;
  }
}

/** Compute the balance effect of a new entry given the current balance. */
export function computeEffect(
  kind: LedgerKind,
  credits: number,
  currentBalance: number,
): LedgerEffect {
  const delta = ledgerDelta(kind, credits);
  return { delta, balanceAfter: currentBalance + delta };
}

/**
 * Decide whether a settlement (debit|refund) for a given job should be applied
 * or is a no-op because that job already has a settlement of that kind.
 *
 * Idempotency rule: at most one settlement entry per (providerJobId, kind),
 * enforced in the DB by a UNIQUE index; this function lets callers short-circuit
 * before attempting the insert.
 */
export function isSettlementNoop(
  jobId: string,
  kind: 'debit' | 'refund',
  existing: readonly LedgerEntryView[],
): boolean {
  return existing.some((e) => e.providerJobId === jobId && e.kind === kind);
}

/**
 * Find the hold amount placed for a job (the amount a debit settles or a refund
 * returns). Returns undefined when no hold exists for the job.
 */
export function holdAmountForJob(
  jobId: string,
  existing: readonly LedgerEntryView[],
): number | undefined {
  const hold = existing.find((e) => e.providerJobId === jobId && e.kind === 'hold');
  return hold ? Math.abs(hold.credits) : undefined;
}

/** True when a user's balance can cover an additional hold of `credits`. */
export function canAfford(currentBalance: number, credits: number): boolean {
  return currentBalance >= Math.abs(credits);
}
