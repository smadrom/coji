/**
 * StripeProvider — real PaymentProvider against the Stripe REST API.
 *
 * Implemented with raw `fetch` (consistent with the HeyGen/S3 providers) so we
 * don't pull the full Stripe SDK; the API version is pinned explicitly via the
 * `Stripe-Version` header. Real calls happen only with a live STRIPE_API_KEY;
 * unit tests mock `globalThis.fetch`.
 *
 *   - createCheckout → POST /v1/checkout/sessions (mode=payment), credits + user
 *     carried in `metadata` so the webhook can grant them.
 *   - verifyWebhook → verifies the `Stripe-Signature` header (t=…,v1=HMAC) over
 *     the raw body, then maps `checkout.session.completed` → grant details. The
 *     session id is the idempotency key.
 *
 * NEVER import the job runner or ledger here — pure provider logic.
 */
import { createHmac } from 'node:crypto';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentProvider,
  PaymentWebhookResult,
} from '@coji/shared/providers';

/** Pinned Stripe API version (explicit per task requirement). */
const STRIPE_API_VERSION = '2024-06-20';
const STRIPE_BASE = 'https://api.stripe.com';
/** Stripe rejects signatures with a timestamp older than this (replay window). */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeProviderOptions {
  apiKey: string;
  successUrl: string;
  cancelUrl: string;
}

export class StripeProvider implements PaymentProvider {
  readonly #apiKey: string;
  readonly #successUrl: string;
  readonly #cancelUrl: string;

  constructor(opts: StripeProviderOptions) {
    if (!opts.apiKey) throw new Error('STRIPE_API_KEY is required for the Stripe payment provider');
    this.#apiKey = opts.apiKey;
    this.#successUrl = opts.successUrl;
    this.#cancelUrl = opts.cancelUrl;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    // application/x-www-form-urlencoded per the Stripe REST API.
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', input.successUrl ?? this.#successUrl);
    form.set('cancel_url', input.cancelUrl ?? this.#cancelUrl);
    form.set('client_reference_id', input.userId);
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][unit_amount]', String(input.pack.priceCents));
    form.set('line_items[0][price_data][product_data][name]', `${input.pack.credits} credits`);
    // Carried back on the webhook so we know who to credit and how much.
    form.set('metadata[user_id]', input.userId);
    form.set('metadata[credits]', String(input.pack.credits));
    form.set('metadata[pack_id]', input.pack.packId);

    const res = await fetch(`${STRIPE_BASE}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`Stripe createCheckout failed: ${res.status}`);
    }
    const session = (await res.json()) as { id: string; url: string };
    return { externalId: session.id, checkoutUrl: session.url };
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): PaymentWebhookResult | null {
    const sigHeader = headers['stripe-signature'] ?? headers['Stripe-Signature'] ?? '';
    const received = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!received) throw new Error('Stripe webhook: missing Stripe-Signature');

    // Header format: t=timestamp,v1=signature[,v1=...]
    const parts = Object.fromEntries(
      received.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k, v] as const;
      }),
    );
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) throw new Error('Stripe webhook: malformed signature header');

    // Reject stale signatures (replay protection).
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      throw new Error('Stripe webhook: signature timestamp outside tolerance');
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    if (!timingSafeEqualHex(expected, v1)) {
      throw new Error('Stripe webhook: signature mismatch');
    }

    const event = JSON.parse(rawBody) as {
      type: string;
      data?: { object?: Record<string, unknown> };
    };
    // Only checkout completion grants credits.
    if (event.type !== 'checkout.session.completed') return null;

    const obj = event.data?.object ?? {};
    const metadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};
    const userId = typeof metadata.user_id === 'string' ? metadata.user_id : undefined;
    const credits = Number(metadata.credits);
    const externalId = typeof obj.id === 'string' ? obj.id : undefined;
    if (!userId || !externalId || !Number.isFinite(credits) || credits <= 0) {
      throw new Error('Stripe webhook: completed session missing user_id/credits metadata');
    }
    return {
      externalId,
      userId,
      creditsToGrant: credits,
      // The session id is the stable idempotency key for the grant.
      idempotencyKey: externalId,
    };
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
