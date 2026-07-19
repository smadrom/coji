/**
 * Payment provider factory tests (P-pay / #23) — the prod-safety boot gate.
 *
 * createPaymentProvider reads env at call time, so each test sets the relevant
 * env vars then calls it. The critical invariant: the Noop provider is BARRED in
 * production (real money must never flow through the fake).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NoopPaymentProvider } from '@coji/shared/providers';
import { StripeProvider } from '../../providers/stripe.ts';
import { createPaymentProvider } from './provider.ts';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('createPaymentProvider', () => {
  test('defaults to Noop in non-production', () => {
    process.env.PAYMENTS_PROVIDER = 'noop';
    process.env.NODE_ENV = 'development';
    expect(createPaymentProvider()).toBeInstanceOf(NoopPaymentProvider);
  });

  test('Noop is BARRED in production (throws at boot)', () => {
    process.env.PAYMENTS_PROVIDER = 'noop';
    process.env.NODE_ENV = 'production';
    expect(() => createPaymentProvider()).toThrow(/barred in production/i);
  });

  test('selects Stripe when configured with an api key', () => {
    process.env.PAYMENTS_PROVIDER = 'stripe';
    process.env.STRIPE_API_KEY = 'sk_test_x';
    expect(createPaymentProvider()).toBeInstanceOf(StripeProvider);
  });

  test('Stripe without an api key throws', () => {
    process.env.PAYMENTS_PROVIDER = 'stripe';
    process.env.STRIPE_API_KEY = '';
    expect(() => createPaymentProvider()).toThrow(/STRIPE_API_KEY/);
  });

  test('an unknown provider throws', () => {
    process.env.PAYMENTS_PROVIDER = 'paypal';
    expect(() => createPaymentProvider()).toThrow(/Unknown PAYMENTS_PROVIDER/);
  });
});
