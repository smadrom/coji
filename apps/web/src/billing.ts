/**
 * Billing API helpers — raw fetch shims until task #23 lands the billing
 * endpoints in the App type and treaty client.
 *
 * GET  /billing/balance  → { credits: number; packs: CreditPack[] }
 * POST /billing/checkout { packId } → { checkoutUrl: string }
 *
 * TODO(#23): replace fetch() calls with treaty client once the billing routes
 * are in the App type.
 */

import { ApiError, BASE_URL, authHeaders } from './api.ts';

export interface CreditPack {
  id: string;
  /** Human-readable label, e.g. "Starter — 50 credits" */
  label: string;
  credits: number;
  /** Price in USD cents */
  priceCents: number;
}

export interface BillingBalance {
  credits: number;
  packs: CreditPack[];
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

/** GET /billing/balance — returns credit balance + available packs. */
export async function getBillingBalance(): Promise<BillingBalance> {
  const res = await fetch(`${BASE_URL}/billing/balance`, { headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<BillingBalance>;
}

/** POST /billing/checkout { packId } — returns a Stripe (or Noop) checkout URL. */
export async function createCheckout(packId: string): Promise<CheckoutResponse> {
  const res = await fetch(`${BASE_URL}/billing/checkout`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ packId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<CheckoutResponse>;
}

// ---------------------------------------------------------------------------
// Static fallback packs shown when #23 has not yet landed
// ---------------------------------------------------------------------------

export const FALLBACK_PACKS: CreditPack[] = [
  { id: 'starter', label: 'Starter', credits: 50, priceCents: 500 },
  { id: 'creator', label: 'Creator', credits: 200, priceCents: 1600 },
  { id: 'pro', label: 'Pro', credits: 600, priceCents: 4000 },
];

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export { formatPrice };
