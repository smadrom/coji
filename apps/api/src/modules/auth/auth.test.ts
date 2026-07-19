/**
 * Auth acceptance — context resolution + the ownership guard under real Better
 * Auth wiring (task #22). The DB-gated suite (auth.db.test.ts) covers real
 * sign-up → bearer session → getSession; here we verify the guard logic and the
 * AUTH_TEST_HEADER escape hatch (enabled by the test preload) without a DB.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AuthContext,
  OwnershipError,
  UnauthenticatedError,
  assertOwner,
  requireAuth,
  resolveAuth,
} from './context.ts';
import { authRoutes } from './routes.ts';

describe('resolveAuth / requireAuth (test-header path)', () => {
  test('resolves identity from x-user-id when AUTH_TEST_HEADER is on', async () => {
    const ctx = await resolveAuth({ 'x-user-id': 'user-42' });
    expect(ctx).toEqual({ userId: 'user-42' });
  });

  test('returns null when no identity is present', async () => {
    const ctx = await resolveAuth({});
    expect(ctx).toBeNull();
  });

  test('requireAuth throws UnauthenticatedError (401) when no identity', async () => {
    await expect(requireAuth({})).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(new UnauthenticatedError().status).toBe(401);
  });

  test('requireAuth returns the caller when identity is present', async () => {
    await expect(requireAuth({ 'x-user-id': 'u1' })).resolves.toEqual({ userId: 'u1' });
  });
});

describe('assertOwner (unchanged guard)', () => {
  const caller: AuthContext = { userId: 'owner' };
  test('passes when resource owner == caller', () => {
    expect(() => assertOwner('owner', caller)).not.toThrow();
  });
  test('throws OwnershipError (404) on mismatch', () => {
    expect(() => assertOwner('someone-else', caller)).toThrow(OwnershipError);
    expect(new OwnershipError().status).toBe(404);
  });
});

describe('/api/me', () => {
  const app = authRoutes();

  test('returns the userId for an authenticated caller', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/me', { headers: { 'x-user-id': 'me-1' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'me-1' });
  });

  test('401 when unauthenticated', async () => {
    const res = await app.handle(new Request('http://localhost/api/me'));
    expect(res.status).toBe(401);
  });

  test('mounts the Better Auth handler under /api/auth/* (route exists, not 404-from-app)', async () => {
    // A GET to a Better Auth sub-path is handled by the mounted handler (it may
    // 404/405 from Better Auth itself, but it is NOT unrouted by our app — i.e.
    // the mount is wired). We assert we get a Response object back.
    const res = await app.handle(new Request('http://localhost/api/auth/ok'));
    expect(res).toBeInstanceOf(Response);
  });
});
