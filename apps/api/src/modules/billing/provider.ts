/**
 * Payment provider factory (P-pay / #23).
 *
 * Selects the PaymentProvider from PAYMENTS_PROVIDER (default `noop`). The Noop
 * provider is BARRED in production — selecting it (or falling back to it) while
 * NODE_ENV=production throws at boot, so real money never flows through the fake.
 */
import { NoopPaymentProvider, type PaymentProvider } from '@coji/shared/providers';
import { env } from '../../env.ts';
import { StripeProvider } from '../../providers/stripe.ts';

/** Payment config; reads live `process.env` so the boot gate is testable. */
export interface PaymentConfig {
  provider: string;
  isProd: boolean;
  stripeApiKey: string;
  successUrl: string;
  cancelUrl: string;
}

function configFromProcess(): PaymentConfig {
  // Read process.env directly (not the frozen `env` snapshot) so tests can flip
  // the prod gate per-case. Falls back to the env defaults where unset.
  return {
    provider: process.env.PAYMENTS_PROVIDER ?? env.paymentsProvider,
    isProd: (process.env.NODE_ENV ?? env.nodeEnv) === 'production',
    stripeApiKey: process.env.STRIPE_API_KEY ?? env.stripeApiKey,
    successUrl: process.env.PAYMENTS_SUCCESS_URL ?? env.paymentsSuccessUrl,
    cancelUrl: process.env.PAYMENTS_CANCEL_URL ?? env.paymentsCancelUrl,
  };
}

export function createPaymentProvider(
  config: PaymentConfig = configFromProcess(),
): PaymentProvider {
  const { provider: selected, isProd } = config;

  if (selected === 'noop') {
    if (isProd) {
      throw new Error(
        'PAYMENTS_PROVIDER=noop is barred in production. Set PAYMENTS_PROVIDER=stripe with a real STRIPE_API_KEY.',
      );
    }
    return new NoopPaymentProvider();
  }

  if (selected === 'stripe') {
    return new StripeProvider({
      apiKey: config.stripeApiKey,
      successUrl: config.successUrl,
      cancelUrl: config.cancelUrl,
    });
  }

  throw new Error(`Unknown PAYMENTS_PROVIDER='${selected}'. Use 'noop' (default) or 'stripe'.`);
}

let cached: PaymentProvider | undefined;
export function getPaymentProvider(): PaymentProvider {
  if (!cached) cached = createPaymentProvider();
  return cached;
}
