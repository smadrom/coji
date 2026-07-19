/**
 * BillingScreen — credit balance + pack selection → Stripe checkout.
 *
 * Fetches GET /billing/balance (task #23 shim). Falls back to static packs
 * when the endpoint is not yet live. On pack selection, POSTs
 * /billing/checkout → redirects to checkoutUrl. Handles success/cancel URL
 * params on return.
 */

import { useEffect, useState } from 'react';
import {
  type BillingBalance,
  type CreditPack,
  FALLBACK_PACKS,
  createCheckout,
  formatPrice,
  getBillingBalance,
} from './billing.ts';

interface Props {
  onBack: () => void;
}

export function BillingScreen({ onBack }: Props) {
  const [balance, setBalance] = useState<BillingBalance | null>(null);
  const [packs, setPacks] = useState<CreditPack[]>(FALLBACK_PACKS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null); // packId being purchased
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Check for success/cancel return from Stripe — computed once at render time
  // so we can show the banner. Clean the param immediately (idempotent).
  const billingParam = new URLSearchParams(window.location.search).get('billing');
  const checkoutSuccess = billingParam === 'success';
  const checkoutCancelled = billingParam === 'cancel';
  if (billingParam) {
    const url = new URL(window.location.href);
    url.searchParams.delete('billing');
    window.history.replaceState({}, '', url.toString());
  }

  useEffect(() => {
    getBillingBalance()
      .then((b) => {
        setBalance(b);
        if (b.packs.length > 0) setPacks(b.packs);
      })
      .catch((err: unknown) => {
        // #23 not yet landed — show static packs + no balance
        setLoadError(err instanceof Error ? err.message : 'Could not load balance.');
      });
  }, []); // fetch once on mount; parent triggers remount on checkout success

  async function handleBuy(pack: CreditPack) {
    setCheckoutBusy(pack.id);
    setCheckoutError(null);
    try {
      const { checkoutUrl } = await createCheckout(pack.id);
      window.location.href = checkoutUrl;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Checkout failed.');
      setCheckoutBusy(null);
    }
    // setCheckoutBusy(null) omitted on success — page navigates away
  }

  return (
    <div className="page">
      <div className="card" style={{ maxWidth: '480px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 className="card-title">Credits</h1>
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            ← Back
          </button>
        </div>

        {checkoutSuccess && (
          <div className="banner banner-info">
            Purchase complete — your credits have been added.
          </div>
        )}
        {checkoutCancelled && (
          <div className="banner banner-error">Checkout cancelled. No charge was made.</div>
        )}

        {/* Balance display */}
        <div
          style={{
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--gap-xs)',
          }}
        >
          <span className="card-subtitle">Current balance</span>
          {balance ? (
            <span style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.03em' }}>
              {balance.credits}{' '}
              <span style={{ fontSize: '1rem', color: 'var(--color-text-muted)', fontWeight: 400 }}>
                credits
              </span>
            </span>
          ) : loadError ? (
            <span className="card-subtitle">— (balance unavailable)</span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--gap-xs)' }}>
              <span className="spinner" style={{ fontSize: '0.85rem' }} />
              <span className="card-subtitle">Loading…</span>
            </span>
          )}
        </div>

        {checkoutError && <div className="banner banner-error">{checkoutError}</div>}

        {/* Credit cost reference */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--gap-xs)',
            padding: '0.75rem 1rem',
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Cost per stage
          </span>
          {(
            [
              ['Frame generation', '4 credits'],
              ['Animation (per clip)', '≈ 24 credits'],
              ['Export / render', '1 credit'],
            ] as const
          ).map(([label, cost]) => (
            <div
              key={label}
              style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}
            >
              <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
              <strong>{cost}</strong>
            </div>
          ))}
        </div>

        {/* Pack list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-sm)' }}>
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Buy credits
          </span>
          {packs.map((pack) => (
            <div
              key={pack.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 1rem',
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-xs)' }}>
                <span style={{ fontWeight: 600 }}>{pack.label}</span>
                <span className="card-subtitle">{pack.credits} credits</span>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={checkoutBusy !== null}
                onClick={() => handleBuy(pack)}
                style={{ minWidth: '90px' }}
              >
                {checkoutBusy === pack.id ? (
                  <>
                    <span className="spinner" style={{ fontSize: '0.8rem' }} />…
                  </>
                ) : (
                  formatPrice(pack.priceCents)
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
