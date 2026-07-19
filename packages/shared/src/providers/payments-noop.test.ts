import { describe, expect, test } from 'bun:test';
import { NoopPaymentProvider, noopPaymentSignature } from './payments-noop.ts';
import type { CreditPack } from './payments.ts';

const SECRET = 'noop-secret';
const pack: CreditPack = { packId: 'starter', credits: 100, priceCents: 1000 };

describe('NoopPaymentProvider', () => {
  test('createCheckout returns a fake URL carrying the grant params', async () => {
    const p = new NoopPaymentProvider();
    const { checkoutUrl, externalId } = await p.createCheckout({ userId: 'u1', pack });
    expect(externalId).toContain('noop-cs-u1-starter');
    const url = new URL(checkoutUrl);
    expect(url.searchParams.get('user')).toBe('u1');
    expect(url.searchParams.get('credits')).toBe('100');
  });

  test('verifyWebhook accepts a correctly-signed body and returns the grant', () => {
    const p = new NoopPaymentProvider();
    const body = JSON.stringify({
      externalId: 'cs_1',
      userId: 'u1',
      creditsToGrant: 100,
      idempotencyKey: 'cs_1',
    });
    const result = p.verifyWebhook(
      body,
      { 'x-noop-signature': noopPaymentSignature(body, SECRET) },
      SECRET,
    );
    expect(result).toEqual({
      externalId: 'cs_1',
      userId: 'u1',
      creditsToGrant: 100,
      idempotencyKey: 'cs_1',
    });
  });

  test('verifyWebhook THROWS on a bad signature', () => {
    const p = new NoopPaymentProvider();
    const body = JSON.stringify({
      externalId: 'x',
      userId: 'u',
      creditsToGrant: 1,
      idempotencyKey: 'x',
    });
    expect(() => p.verifyWebhook(body, { 'x-noop-signature': 'wrong' }, SECRET)).toThrow();
  });

  test('verifyWebhook THROWS on a missing signature', () => {
    const p = new NoopPaymentProvider();
    const body = JSON.stringify({
      externalId: 'x',
      userId: 'u',
      creditsToGrant: 1,
      idempotencyKey: 'x',
    });
    expect(() => p.verifyWebhook(body, {}, SECRET)).toThrow();
  });

  test('verifyWebhook THROWS on a malformed (signed) body', () => {
    const p = new NoopPaymentProvider();
    const body = JSON.stringify({ userId: 'u' }); // missing fields
    expect(() =>
      p.verifyWebhook(body, { 'x-noop-signature': noopPaymentSignature(body, SECRET) }, SECRET),
    ).toThrow();
  });
});
