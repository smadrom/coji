/**
 * PaymentProvider seam — checkout + payment webhook for credit top-ups.
 *
 * Kept separate from the four pipeline seams (image/animation/render/storage):
 * payments are a billing concern, not part of the generation pipeline. A real
 * StripeProvider and a deterministic NoopPaymentProvider implement this; the
 * Noop is the CI default and is BARRED in production at boot.
 *
 * The webhook contract returns the data the billing module needs to grant
 * credits idempotently: which user, how many credits, and a stable
 * `idempotencyKey` (the payment/session id) the ledger keys the top-up on so a
 * replayed webhook never double-credits.
 */

/** A purchasable credit pack. */
export interface CreditPack {
  packId: string;
  credits: number;
  priceCents: number;
}

export interface CreateCheckoutInput {
  userId: string;
  pack: CreditPack;
  /** Where the provider should send the user back to after checkout. */
  successUrl?: string;
  cancelUrl?: string;
}

export interface CheckoutSession {
  /** URL the client redirects the user to in order to pay. */
  checkoutUrl: string;
  /** Provider-side identifier for the checkout/session. */
  externalId: string;
}

/** Result of verifying + parsing a payment webhook. */
export interface PaymentWebhookResult {
  externalId: string;
  userId: string;
  creditsToGrant: number;
  /** Stable key for idempotent crediting (e.g. the checkout/session id). */
  idempotencyKey: string;
}

export interface PaymentProvider {
  /** Create a checkout session for a credit pack; returns a redirect URL. */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /**
   * Verify a payment webhook's signature against the configured secret and parse
   * it. Returns the grant details on a successful payment event, or null when the
   * event is valid but not a credit-granting event. THROWS on signature failure.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): PaymentWebhookResult | null;
}
