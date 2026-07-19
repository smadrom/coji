/**
 * NoopPaymentProvider — the CI/dev default payment seam. NEVER calls a payment
 * processor. It mints a deterministic fake checkout URL and verifies webhooks
 * with the same HMAC-SHA256 scheme a real provider would, so the billing
 * module's signature/idempotency logic is exercised end-to-end for free.
 *
 * BARRED in production: the billing wiring must throw at boot if this is selected
 * while NODE_ENV=production (a real processor is mandatory for real money).
 */
import { createHmac } from 'node:crypto';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentProvider,
  PaymentWebhookResult,
} from './payments.ts';

/** Shape of the deterministic Noop webhook body (what a test 'confirm' posts). */
export interface NoopPaymentEvent {
  externalId: string;
  userId: string;
  creditsToGrant: number;
  idempotencyKey: string;
}

/** Compute the HMAC-SHA256 hex signature for a Noop webhook body. */
export function noopPaymentSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export class NoopPaymentProvider implements PaymentProvider {
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const externalId = `noop-cs-${input.userId}-${input.pack.packId}-${Date.now()}`;
    // The fake URL carries the grant params so a test/dev can 'confirm' it.
    const params = new URLSearchParams({
      session: externalId,
      user: input.userId,
      credits: String(input.pack.credits),
    });
    return {
      externalId,
      checkoutUrl: `https://noop.checkout.local/pay?${params.toString()}`,
    };
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): PaymentWebhookResult | null {
    const sigHeader = headers['x-noop-signature'] ?? headers['X-Noop-Signature'] ?? '';
    const received = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const expected = noopPaymentSignature(rawBody, secret);
    if (!received || !timingSafeEqualHex(expected, received)) {
      throw new Error('NoopPaymentProvider: invalid webhook signature');
    }
    const event = JSON.parse(rawBody) as Partial<NoopPaymentEvent>;
    if (
      typeof event.userId !== 'string' ||
      typeof event.creditsToGrant !== 'number' ||
      typeof event.idempotencyKey !== 'string' ||
      typeof event.externalId !== 'string'
    ) {
      throw new Error('NoopPaymentProvider: malformed webhook body');
    }
    return {
      externalId: event.externalId,
      userId: event.userId,
      creditsToGrant: event.creditsToGrant,
      idempotencyKey: event.idempotencyKey,
    };
  }
}

/** Constant-time hex string comparison. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
