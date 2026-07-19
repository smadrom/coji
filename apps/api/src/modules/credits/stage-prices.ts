/**
 * Stage-price lookup (P0.6).
 *
 * `stage_prices` is the single source of retail credit pricing, in BOUNDED
 * units only for v1 (`per_set` image, `per_clip` animation, `per_export`
 * render) so the exact hold is known before a paid call (ADR-6). The total
 * hold for a stage = unit credits × quantity (e.g. per_clip × 4 frames).
 */
import { and, eq } from 'drizzle-orm';
import { stagePrices } from '../../db/tables.ts';
import type { Tx } from './ledger.ts';
import type { Stage } from './types.ts';

export type BoundedUnit = 'per_set' | 'per_clip' | 'per_export';

/** The bounded unit each stage is priced in for v1. */
export const STAGE_UNIT: Record<Stage, BoundedUnit> = {
  image: 'per_set',
  animation: 'per_clip',
  render: 'per_export',
};

/** Look up the per-unit credit price for a stage. Throws if unconfigured. */
export async function unitPrice(tx: Tx, stage: Stage): Promise<number> {
  const unit = STAGE_UNIT[stage];
  const rows = await tx
    .select({ credits: stagePrices.credits })
    .from(stagePrices)
    .where(and(eq(stagePrices.stage, stage), eq(stagePrices.unit, unit)))
    .limit(1);
  const price = rows[0]?.credits;
  if (price === undefined) {
    throw new Error(`No stage_prices row for stage='${stage}' unit='${unit}'`);
  }
  return price;
}

/**
 * Total bounded hold for a stage = unit price × quantity.
 *   image  → quantity 1 (per_set)
 *   animation → quantity = frame count (per_clip, typically 4)
 *   render → quantity 1 (per_export)
 */
export async function stageHoldCredits(tx: Tx, stage: Stage, quantity = 1): Promise<number> {
  return (await unitPrice(tx, stage)) * quantity;
}
