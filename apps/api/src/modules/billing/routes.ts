/**
 * Billing routes (P-pay / #23) — mounted on the literal Eden `.use()` chain.
 *
 *   - POST /billing/checkout  (auth)        → create a checkout session for a pack
 *   - GET  /billing/balance   (auth)        → current credit balance + pack catalog
 *   - POST /webhooks/stripe   (NO auth)     → raw-body, signature-verified top-up
 *
 * The webhook carries no auth header — the payment provider's signature IS the
 * auth. It reads the RAW body (signature is computed over exact bytes) and is in
 * the MCP deny-list (^/webhooks). Credits are granted via the idempotent ledger
 * top-up, so a replayed event never double-credits (200, duplicate).
 */
import { Elysia, t } from 'elysia';
import { UnauthenticatedError, requireAuth } from '../auth/context.ts';
import { type BillingService, UnknownPackError, WebhookSignatureError } from './service.ts';

const CheckoutBody = t.Object({ packId: t.String({ minLength: 1 }) });

export interface BillingRoutesDeps {
  service: BillingService;
  /** Secret for verifying the payment webhook signature. */
  webhookSecret: string;
}

export function billingRoutes(deps: BillingRoutesDeps) {
  const { service } = deps;
  return new Elysia({ name: 'billing' })
    .onError(({ error, set }) => {
      const status = (error as { status?: number }).status;
      if (
        error instanceof UnauthenticatedError ||
        error instanceof UnknownPackError ||
        error instanceof WebhookSignatureError ||
        typeof status === 'number'
      ) {
        set.status = status ?? 500;
        return { error: (error as Error).message };
      }
      return undefined;
    })
    .post(
      '/billing/checkout',
      async ({ body, request }) => {
        const caller = await requireAuth(request.headers);
        return service.checkout({ userId: caller.userId, packId: body.packId });
      },
      {
        body: CheckoutBody,
        response: t.Object({ checkoutUrl: t.String(), externalId: t.String() }),
        detail: { summary: 'Create a credit-pack checkout session', tags: ['billing'] },
      },
    )
    .get(
      '/billing/balance',
      async ({ request }) => {
        const caller = await requireAuth(request.headers);
        return service.balance(caller.userId);
      },
      {
        response: t.Object({
          balance: t.Integer(),
          packs: t.Array(
            t.Object({
              packId: t.String(),
              credits: t.Integer(),
              priceCents: t.Integer(),
            }),
          ),
        }),
        detail: { summary: 'Credit balance + pack catalog', tags: ['billing'] },
      },
    )
    .post(
      '/webhooks/stripe',
      async ({ request, set }) => {
        const rawBody = await request.text();
        const headers: Record<string, string> = {};
        request.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const outcome = await service.grantFromWebhook({
          rawBody,
          headers,
          secret: deps.webhookSecret,
        });
        set.status = 200;
        return { result: outcome.result };
      },
      {
        // Raw body for signature verification — do not let Elysia coerce it.
        parse: 'none',
        detail: { summary: 'Payment webhook (signature-verified credit top-up)', tags: ['system'] },
        response: t.Object({ result: t.String() }),
      },
    );
}

/** Route metadata for the MCP registry — billing is never an MCP tool. */
export const billingMcpRoutes = [
  { method: 'POST', path: '/billing/checkout', summary: 'Create checkout', mcp: false },
  { method: 'GET', path: '/billing/balance', summary: 'Credit balance', mcp: false },
  { method: 'POST', path: '/webhooks/stripe', summary: 'Payment webhook', mcp: false },
];
