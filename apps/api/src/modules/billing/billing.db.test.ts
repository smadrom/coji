/**
 * DB-backed test for the real payment top-up idempotency (P-pay / #23).
 *
 * GATED on Postgres (TEST_DATABASE_URL / DATABASE_URL); skipped otherwise.
 * Verifies the ledger's topupForPayment is idempotent on payment_ref (the
 * UNIQUE index is the hard guarantee) so a replayed payment webhook grants once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { creditLedger } from '../../db/tables.ts';
import {
  type TestDb,
  applyMigrations,
  hasTestDb,
  openTestDb,
  truncateAll,
} from '../../db/testing.ts';
import { balance, topupForPayment } from '../credits/ledger.ts';

const RUN = hasTestDb();

describe.skipIf(!RUN)('payment top-up (DB-backed)', () => {
  let db: TestDb;
  let client: ReturnType<typeof openTestDb>['client'];

  beforeAll(async () => {
    ({ db, client } = openTestDb());
    await applyMigrations(db);
  });
  afterAll(async () => {
    await client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(client);
  });

  test('first top-up grants; replay with the same paymentRef is a no-op', async () => {
    const first = await db.transaction((tx) =>
      topupForPayment(tx, { userId: 'u1', credits: 100, paymentRef: 'cs_1' }),
    );
    expect(first.applied).toBe(true);
    expect(first.balance).toBe(100);

    const replay = await db.transaction((tx) =>
      topupForPayment(tx, { userId: 'u1', credits: 100, paymentRef: 'cs_1' }),
    );
    expect(replay.applied).toBe(false);
    expect(replay.balance).toBe(100); // not 200

    // Exactly one topup entry for that paymentRef.
    const entries = await db.select().from(creditLedger).where(eq(creditLedger.paymentRef, 'cs_1'));
    expect(entries).toHaveLength(1);
    expect(await db.transaction((tx) => balance(tx, 'u1'))).toBe(100);
  });

  test('distinct paymentRefs each grant', async () => {
    await db.transaction((tx) =>
      topupForPayment(tx, { userId: 'u2', credits: 100, paymentRef: 'a' }),
    );
    await db.transaction((tx) =>
      topupForPayment(tx, { userId: 'u2', credits: 50, paymentRef: 'b' }),
    );
    expect(await db.transaction((tx) => balance(tx, 'u2'))).toBe(150);
  });
});
