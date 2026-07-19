/**
 * Credit-ledger DB operations (P0.6).
 *
 * Append-only ledger; user balance = latest `balance_after`. Each paid stage:
 *   placeHold → convertHoldToDebit (success) | refundHold (failure).
 * Settlement (debit/refund) is idempotent: keyed to provider_job_id and guarded
 * by the UNIQUE (provider_job_id, kind) index, so a double-apply is a no-op.
 *
 * `credits_spent` on the project is rolled up transactionally in the SAME
 * transaction as the debit/refund (callers pass a `tx`); never updated
 * out-of-band. See applyJobResult (the single writer) for the orchestration.
 *
 * The functions take a transaction/db handle (`Tx`) so callers compose them
 * inside `db.transaction(...)`. Pure math/idempotency decisions live in
 * ./ledger-logic.ts and are unit-tested without a DB.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { creditLedger, projects } from '../../db/tables.ts';
import { computeEffect, holdAmountForJob, isSettlementNoop } from './ledger-logic.ts';
import type { LedgerEntryView } from './ledger-logic.ts';
import type { Stage } from './types.ts';

/**
 * Minimal transactional DB surface this module needs. `db` and a `tx` both
 * satisfy it, so ledger ops compose inside `db.transaction(tx => ...)`.
 */
export type Tx = {
  // biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's tx/db (its generics are version-fragile)
  select: (...args: any[]) => any;
  // biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's tx/db (its generics are version-fragile)
  insert: (...args: any[]) => any;
  // biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's tx/db (its generics are version-fragile)
  update: (...args: any[]) => any;
};

/** Latest balance for a user (0 when the user has no ledger entries yet). */
export async function balance(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .select({ balanceAfter: creditLedger.balanceAfter })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(1);
  return rows[0]?.balanceAfter ?? 0;
}

/** All ledger entries linked to a provider job (for idempotency decisions). */
async function entriesForJob(tx: Tx, jobId: string): Promise<LedgerEntryView[]> {
  const rows = await tx
    .select({
      kind: creditLedger.kind,
      credits: creditLedger.credits,
      providerJobId: creditLedger.providerJobId,
    })
    .from(creditLedger)
    .where(eq(creditLedger.providerJobId, jobId));
  return rows as LedgerEntryView[];
}

async function appendEntry(
  tx: Tx,
  entry: {
    userId: string;
    projectId: string | null;
    stage: string | null;
    kind: 'hold' | 'debit' | 'refund' | 'topup';
    credits: number;
    providerJobId: string | null;
    paymentRef?: string | null;
  },
): Promise<number> {
  const current = await balance(tx, entry.userId);
  const { balanceAfter } = computeEffect(entry.kind, entry.credits, current);
  await tx.insert(creditLedger).values({
    userId: entry.userId,
    projectId: entry.projectId,
    stage: entry.stage,
    kind: entry.kind,
    credits: Math.abs(entry.credits),
    balanceAfter,
    providerJobId: entry.providerJobId,
    paymentRef: entry.paymentRef ?? null,
  });
  return balanceAfter;
}

/** Add funds (unconditional). Use `topupForPayment` for the idempotent webhook path. */
export async function topup(tx: Tx, userId: string, credits: number): Promise<number> {
  return appendEntry(tx, {
    userId,
    projectId: null,
    stage: null,
    kind: 'topup',
    credits,
    providerJobId: null,
  });
}

/**
 * Idempotent top-up driven by a payment. Keyed on the payment's idempotency key
 * (`paymentRef`): a replayed payment webhook is a NO-OP (returns the current
 * balance), so a customer is never double-credited. The DB-level UNIQUE index on
 * `payment_ref` is the hard guarantee; this check short-circuits before insert.
 */
export async function topupForPayment(
  tx: Tx,
  args: { userId: string; credits: number; paymentRef: string },
): Promise<{ applied: boolean; balance: number }> {
  const existing = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.paymentRef, args.paymentRef))
    .limit(1);
  if (existing[0]) {
    return { applied: false, balance: await balance(tx, args.userId) };
  }
  const newBalance = await appendEntry(tx, {
    userId: args.userId,
    projectId: null,
    stage: null,
    kind: 'topup',
    credits: args.credits,
    providerJobId: null,
    paymentRef: args.paymentRef,
  });
  return { applied: true, balance: newBalance };
}

/**
 * Reserve `credits` for a job before a paid stage. One hold per job (the job's
 * idempotency key already makes the job unique). Returns the new balance.
 */
export async function placeHold(
  tx: Tx,
  args: { userId: string; projectId: string; stage: Stage; credits: number; jobId: string },
): Promise<number> {
  const existing = await entriesForJob(tx, args.jobId);
  if (existing.some((e) => e.kind === 'hold')) {
    // Idempotent: a hold already exists for this job.
    return balance(tx, args.userId);
  }
  return appendEntry(tx, {
    userId: args.userId,
    projectId: args.projectId,
    stage: args.stage,
    kind: 'hold',
    credits: args.credits,
    providerJobId: args.jobId,
  });
}

/**
 * Settle a job's hold as a real charge on SUCCESS. Idempotent (no-op if already
 * debited/refunded). Rolls up `projects.credits_spent` in the SAME tx.
 */
export async function convertHoldToDebit(
  tx: Tx,
  args: { userId: string; projectId: string; stage: Stage; jobId: string },
): Promise<{ applied: boolean; balance: number }> {
  const existing = await entriesForJob(tx, args.jobId);
  if (
    isSettlementNoop(args.jobId, 'debit', existing) ||
    isSettlementNoop(args.jobId, 'refund', existing)
  ) {
    return { applied: false, balance: await balance(tx, args.userId) };
  }
  const held = holdAmountForJob(args.jobId, existing);
  if (held === undefined) {
    throw new Error(`convertHoldToDebit: no hold found for job ${args.jobId}`);
  }
  const newBalance = await appendEntry(tx, {
    userId: args.userId,
    projectId: args.projectId,
    stage: args.stage,
    kind: 'debit',
    credits: held,
    providerJobId: args.jobId,
  });
  // credits_spent rollup, same transaction as the settlement.
  await tx
    .update(projects)
    .set({ creditsSpent: sql`${projects.creditsSpent} + ${held}` })
    .where(eq(projects.id, args.projectId));
  return { applied: true, balance: newBalance };
}

/**
 * Release a job's hold back to the user on FAILURE. Idempotent (no-op if already
 * settled). No credits_spent change (nothing was consumed).
 */
export async function refundHold(
  tx: Tx,
  args: { userId: string; projectId: string; stage: Stage; jobId: string },
): Promise<{ applied: boolean; balance: number }> {
  const existing = await entriesForJob(tx, args.jobId);
  if (
    isSettlementNoop(args.jobId, 'refund', existing) ||
    isSettlementNoop(args.jobId, 'debit', existing)
  ) {
    return { applied: false, balance: await balance(tx, args.userId) };
  }
  const held = holdAmountForJob(args.jobId, existing);
  if (held === undefined) {
    throw new Error(`refundHold: no hold found for job ${args.jobId}`);
  }
  const newBalance = await appendEntry(tx, {
    userId: args.userId,
    projectId: args.projectId,
    stage: args.stage,
    kind: 'refund',
    credits: held,
    providerJobId: args.jobId,
  });
  return { applied: true, balance: newBalance };
}
