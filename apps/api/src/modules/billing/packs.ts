/**
 * Credit packs (P-pay / #23) — the catalog of purchasable top-ups.
 *
 * Config map: packId → { credits, priceCents }. The price is what the payment
 * provider charges; the credits are granted to the ledger on successful payment.
 * Kept as a small static map for v1 (no admin UI); promote to a table later.
 */
import type { CreditPack } from '@coji/shared/providers';

export const CREDIT_PACKS: Record<string, CreditPack> = {
  starter: { packId: 'starter', credits: 100, priceCents: 1000 },
  pro: { packId: 'pro', credits: 500, priceCents: 4500 },
  studio: { packId: 'studio', credits: 1200, priceCents: 9900 },
};

/** Look up a pack by id, or undefined when unknown. */
export function getPack(packId: string): CreditPack | undefined {
  return CREDIT_PACKS[packId];
}

/** The catalog as an array (for GET /billing/balance). */
export function packCatalog(): CreditPack[] {
  return Object.values(CREDIT_PACKS);
}
