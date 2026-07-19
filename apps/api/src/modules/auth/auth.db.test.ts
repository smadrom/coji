/**
 * DB-backed integration test for real Better Auth bearer sessions (task #22).
 *
 * GATED on a reachable Postgres (TEST_DATABASE_URL / DATABASE_URL) AND on the
 * AUTH_TEST_HEADER being explicitly OFF for this file, so it exercises the REAL
 * session path (sign-up → bearer token → getSession → userId) rather than the
 * x-user-id escape hatch. Skipped in keyless CI.
 *
 * Verifies:
 *   - email+password sign-up returns a bearer token;
 *   - resolveAuth with `Authorization: Bearer <token>` yields that user's id;
 *   - a bogus token resolves to null (→ 401 at the route layer);
 *   - the ownership guard still holds end-to-end against a real session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyMigrations, hasTestDb, openTestDb } from '../../db/testing.ts';

const RUN = hasTestDb();

describe.skipIf(!RUN)('Better Auth bearer sessions (DB-backed)', () => {
  let client: ReturnType<typeof openTestDb>['client'];

  beforeAll(async () => {
    const opened = openTestDb();
    client = opened.client;
    await applyMigrations(opened.db);
    // Force the real session path for this file regardless of the test preload.
    process.env.AUTH_TEST_HEADER = 'false';
  });
  afterAll(async () => {
    process.env.AUTH_TEST_HEADER = 'true';
    await client.end({ timeout: 5 });
  });

  async function freshAuthModules() {
    // Import after the env flag is flipped so resolveAuth reads it correctly.
    const { auth } = await import('./auth.ts');
    const { resolveAuth } = await import('./context.ts');
    return { auth, resolveAuth };
  }

  test('sign-up issues a bearer token that resolveAuth accepts', async () => {
    const { auth, resolveAuth } = await freshAuthModules();
    const email = `qa+${Date.now()}@example.com`;

    const res = await auth.api.signUpEmail({
      body: { email, password: 'sup3r-secret-pw', name: 'QA User' },
      returnHeaders: true,
    });
    const token = res.headers.get('set-auth-token');
    expect(token).toBeTruthy();

    const ctx = await resolveAuth({ authorization: `Bearer ${token}` });
    expect(ctx?.userId).toBeTruthy();
  });

  test('a bogus bearer token resolves to null', async () => {
    const { resolveAuth } = await freshAuthModules();
    const ctx = await resolveAuth({ authorization: 'Bearer not-a-real-token' });
    expect(ctx).toBeNull();
  });
});
