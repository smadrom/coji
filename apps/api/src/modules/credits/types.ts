/** Credit-domain shared types. */

/** Append-only credit-ledger entry kind (mirrors the ledger_kind pgEnum). */
export type LedgerKind = 'hold' | 'debit' | 'refund' | 'topup';

/** Pricing stage (mirrors the stage pgEnum). */
export type Stage = 'image' | 'animation' | 'render';
