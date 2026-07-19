/**
 * Billing HTTP acceptance (P-pay / #23) — app.handle, zero DB.
 *
 * Drives the real billing routes against an in-memory BillingService that models
 * the ledger top-up (with the same idempotency-by-paymentRef semantics) + the
 * Noop payment provider, so checkout / balance / webhook + the MCP exclusion are
 * exercised CI-green. The REAL ledger top-up idempotency against Postgres is in
 * billing.db.test.ts. Auth uses the x-user-id test header (AUTH_TEST_HEADER).
 */
import { describe, expect, test } from 'bun:test';
import { NoopPaymentProvider, noopPaymentSignature } from '@coji/shared/providers';
import { Elysia } from 'elysia';
import { mcpPlugin } from '../mcp/plugin.ts';
import { MCP_ROUTES } from '../registry.ts';
import { packCatalog } from './packs.ts';
import { billingRoutes } from './routes.ts';
import type { BillingService } from './service.ts';

const SECRET = 'test-pay-secret';

/** In-memory BillingService: real Noop provider + a balance map with paymentRef idempotency. */
function createFakeBillingService(): BillingService {
  const provider = new NoopPaymentProvider();
  const balances = new Map<string, number>();
  const seenRefs = new Set<string>();
  return {
    async checkout({ userId, packId }) {
      const pack = packCatalog().find((p) => p.packId === packId);
      if (!pack) {
        const e = new Error('unknown pack') as Error & { status: number };
        e.status = 400;
        throw e;
      }
      const s = await provider.createCheckout({ userId, pack });
      return { checkoutUrl: s.checkoutUrl, externalId: s.externalId };
    },
    async balance(userId) {
      return { balance: balances.get(userId) ?? 0, packs: packCatalog() };
    },
    async grantFromWebhook({ rawBody, headers, secret }) {
      let parsed: ReturnType<NoopPaymentProvider['verifyWebhook']>;
      try {
        parsed = provider.verifyWebhook(rawBody, headers, secret);
      } catch {
        const e = new Error('invalid signature') as Error & { status: number };
        e.status = 400;
        throw e;
      }
      if (!parsed) return { result: 'ignored' };
      if (seenRefs.has(parsed.idempotencyKey)) {
        return { result: 'duplicate', balance: balances.get(parsed.userId) ?? 0 };
      }
      seenRefs.add(parsed.idempotencyKey);
      const next = (balances.get(parsed.userId) ?? 0) + parsed.creditsToGrant;
      balances.set(parsed.userId, next);
      return { result: 'granted', balance: next };
    },
  };
}

function buildApp(service = createFakeBillingService()) {
  return new Elysia()
    .use(billingRoutes({ service, webhookSecret: SECRET }))
    .use(mcpPlugin(MCP_ROUTES));
}

const authed = (userId: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-user-id': userId,
  ...extra,
});

function webhook(body: string) {
  return new Request('http://localhost/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-noop-signature': noopPaymentSignature(body, SECRET),
    },
    body,
  });
}

describe('billing routes', () => {
  test('POST /billing/checkout (auth) returns a checkout URL', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/billing/checkout', {
        method: 'POST',
        headers: authed('u1'),
        body: JSON.stringify({ packId: 'starter' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkoutUrl: string; externalId: string };
    expect(body.checkoutUrl).toContain('http');
    expect(body.externalId).toBeTruthy();
  });

  test('checkout requires auth (401)', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId: 'starter' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('unknown pack → 400', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/billing/checkout', {
        method: 'POST',
        headers: authed('u1'),
        body: JSON.stringify({ packId: 'nope' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('GET /billing/balance returns balance + pack catalog', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/billing/balance', { headers: { 'x-user-id': 'u1' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: number; packs: { packId: string }[] };
    expect(body.balance).toBe(0);
    expect(body.packs.map((p) => p.packId)).toContain('starter');
  });

  test('webhook grants credits and balance reflects the top-up', async () => {
    const app = buildApp();
    const body = JSON.stringify({
      externalId: 'cs_1',
      userId: 'u1',
      creditsToGrant: 100,
      idempotencyKey: 'cs_1',
    });
    const res = await app.handle(webhook(body));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('granted');

    const bal = await app.handle(
      new Request('http://localhost/billing/balance', { headers: { 'x-user-id': 'u1' } }),
    );
    expect(((await bal.json()) as { balance: number }).balance).toBe(100);
  });

  test('webhook with a bad signature → 400, no write', async () => {
    const app = buildApp();
    const body = JSON.stringify({
      externalId: 'cs',
      userId: 'u1',
      creditsToGrant: 100,
      idempotencyKey: 'cs',
    });
    const res = await app.handle(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noop-signature': 'bad' },
        body,
      }),
    );
    expect(res.status).toBe(400);
    const bal = await app.handle(
      new Request('http://localhost/billing/balance', { headers: { 'x-user-id': 'u1' } }),
    );
    expect(((await bal.json()) as { balance: number }).balance).toBe(0);
  });

  test('idempotent replay → single grant', async () => {
    const app = buildApp();
    const body = JSON.stringify({
      externalId: 'cs_2',
      userId: 'u2',
      creditsToGrant: 100,
      idempotencyKey: 'cs_2',
    });
    const first = await app.handle(webhook(body));
    const second = await app.handle(webhook(body));
    expect(((await first.json()) as { result: string }).result).toBe('granted');
    expect(((await second.json()) as { result: string }).result).toBe('duplicate');

    const bal = await app.handle(
      new Request('http://localhost/billing/balance', { headers: { 'x-user-id': 'u2' } }),
    );
    expect(((await bal.json()) as { balance: number }).balance).toBe(100); // not 200
  });

  test('the payment webhook is NOT exposed as an MCP tool', async () => {
    const app = buildApp();
    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/list' }),
      }),
    );
    const { result } = (await res.json()) as { result: { tools: { path: string }[] } };
    expect(result.tools.some((t) => t.path.includes('/webhooks/stripe'))).toBe(false);
    expect(result.tools.some((t) => t.path.includes('/billing'))).toBe(false);
  });
});
