/**
 * Auth context + ownership guard (task #22 — real Better Auth bearer sessions).
 *
 * `resolveAuth`/`requireAuth` read the caller identity from a Better Auth bearer
 * session (`Authorization: Bearer <token>`). They are async (the session lookup
 * is async); every project route awaits them.
 *
 * Test/dev escape hatch: when `AUTH_TEST_HEADER=true` (off in production) the
 * resolver also accepts an `x-user-id` header so the app.handle suites exercise
 * the REAL ownership guard without minting a live session. The guard logic
 * (assertOwner) + error types are UNCHANGED and permanent.
 */
import { env } from '../../env.ts';
import { auth } from './auth.ts';

export interface AuthContext {
  userId: string;
}

/** Thrown when no caller identity is present (→ 401). */
export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor() {
    super('Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Thrown when the caller is not the owner of a project-scoped resource.
 *
 * Defaults to 404 (not 403) so we don't leak the existence of another user's
 * project; the plan allows either 403/404 — 404 is the privacy-preserving choice.
 */
export class OwnershipError extends Error {
  readonly status = 404;
  constructor() {
    super('Not found');
    this.name = 'OwnershipError';
  }
}

/** Coerce mixed header inputs to a `Headers` object for Better Auth. */
function toHeaders(input: Headers | Record<string, string | undefined>): Headers {
  if (input instanceof Headers) return input;
  const h = new Headers();
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) h.set(k, v);
  }
  return h;
}

/**
 * Resolve the caller identity from request headers via the Better Auth session.
 * Returns null when no valid session is present (routes turn that into a 401).
 */
export async function resolveAuth(
  headers: Headers | Record<string, string | undefined>,
): Promise<AuthContext | null> {
  const h = toHeaders(headers);

  // Dev/test only: identity via x-user-id, never in production.
  if (env.authTestHeader) {
    const testUserId = h.get('x-user-id');
    if (testUserId) return { userId: testUserId };
  }

  const session = await auth.api.getSession({ headers: h });
  if (!session?.user?.id) return null;
  return { userId: session.user.id };
}

/** Like resolveAuth but throws 401 when no identity is present. */
export async function requireAuth(
  headers: Headers | Record<string, string | undefined>,
): Promise<AuthContext> {
  const ctx = await resolveAuth(headers);
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

/**
 * The ownership guard used by EVERY project-scoped route: the resource's owner
 * must equal the caller. Throws OwnershipError (404) otherwise.
 *
 * This is the single chokepoint the plan requires; credit holds are always
 * charged to the owner, who must equal the caller. UNCHANGED by the auth swap.
 */
export function assertOwner(resourceUserId: string, caller: AuthContext): void {
  if (resourceUserId !== caller.userId) throw new OwnershipError();
}
