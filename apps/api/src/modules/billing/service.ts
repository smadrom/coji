/**
 * Billing service (P-pay / #23).
 *
 * Bridges the PaymentProvider seam and the credit ledger:
 *   - checkout: validate the pack → provider.createCheckout → return the URL;
 *   - balance: current credit balance + the pack catalog;
 *   - grantFromWebhook: verify the payment webhook → idempotent ledger top-up
 *     (keyed on the payment idempotencyKey, so a replay never double-credits).
 *
 * Pure of HTTP concerns (routes wrap it). DB-bound; uses the ledger's
 * topupForPayment for the hard idempotency guarantee.
 */
import type { PaymentProvider } from '@coji/shared/providers';
import { balance, topupForPayment } from '../credits/ledger.ts';
import { getPack, packCatalog } from './packs.ts';

/** Minimal DB surface (db or tx). Drizzle's generics are version-fragile. */
// biome-ignore lint/suspicious/noExplicitAny: structural surface over Drizzle's db/tx
type AnyDb = any;

export class UnknownPackError extends Error {
  readonly status = 400;
  constructor(packId: string) {
    super(`Unknown credit pack '${packId}'`);
    this.name = 'UnknownPackError';
  }
}

export class WebhookSignatureError extends Error {
  readonly status = 400;
  constructor(message = 'invalid payment webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export interface BillingDeps {
  db: AnyDb;
  provider: PaymentProvider;
}

export function createBillingService(deps: BillingDeps) {
  return {
    /** Create a checkout session for a credit pack; returns the redirect URL. */
    async checkout(args: { userId: string; packId: string }): Promise<{
      checkoutUrl: string;
      externalId: string;
    }> {
      const pack = getPack(args.packId);
      if (!pack) throw new UnknownPackError(args.packId);
      const session = await deps.provider.createCheckout({ userId: args.userId, pack });
      return { checkoutUrl: session.checkoutUrl, externalId: session.externalId };
    },

    /** Current credit balance + the purchasable pack catalog. */
    async balance(
      userId: string,
    ): Promise<{ balance: number; packs: ReturnType<typeof packCatalog> }> {
      const bal = await deps.db.transaction((tx: AnyDb) => balance(tx, userId));
      return { balance: bal, packs: packCatalog() };
    },

    /**
     * Verify + apply a payment webhook. Returns whether a grant was applied
     * ('granted' / 'duplicate' / 'ignored'). Throws WebhookSignatureError on a
     * bad signature (→ 400, no write). Idempotent: a replayed event with the same
     * idempotencyKey grants once.
     */
    async grantFromWebhook(args: {
      rawBody: string;
      headers: Record<string, string | string[] | undefined>;
      secret: string;
    }): Promise<{ result: 'granted' | 'duplicate' | 'ignored'; balance?: number }> {
      let parsed: ReturnType<PaymentProvider['verifyWebhook']>;
      try {
        parsed = deps.provider.verifyWebhook(args.rawBody, args.headers, args.secret);
      } catch (err) {
        throw new WebhookSignatureError(err instanceof Error ? err.message : undefined);
      }
      if (!parsed) return { result: 'ignored' };

      const outcome = await deps.db.transaction((tx: AnyDb) =>
        topupForPayment(tx, {
          userId: parsed.userId,
          credits: parsed.creditsToGrant,
          paymentRef: parsed.idempotencyKey,
        }),
      );
      return { result: outcome.applied ? 'granted' : 'duplicate', balance: outcome.balance };
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
