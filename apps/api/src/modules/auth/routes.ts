/**
 * Better Auth HTTP plugin (task #22) — mounts the Better Auth handler on the
 * literal Eden `.use()` chain at /api/auth/* (sign-up / sign-in / session /
 * sign-out, bearer tokens). Also exposes GET /api/me as a typed convenience that
 * returns the current caller (401 when unauthenticated) so the web client and
 * Eden treaty get a first-class "who am I" endpoint.
 *
 * `auth.handler` is a standard Web `fetch` handler; `.mount()` forwards all
 * /api/auth/* requests to it. This does not break the Eden type spine — the
 * mounted handler is opaque to the type chain, and `export type App` stays valid.
 */
import { Elysia, t } from 'elysia';
import { auth } from './auth.ts';
import { UnauthenticatedError, requireAuth } from './context.ts';

export function authRoutes() {
  return new Elysia({ name: 'auth' })
    .all('/api/auth/*', ({ request }) => auth.handler(request))
    .onError(({ error, set }) => {
      if (error instanceof UnauthenticatedError) {
        set.status = 401;
        return { error: error.message };
      }
      return undefined;
    })
    .get(
      '/api/me',
      async ({ request }) => {
        const caller = await requireAuth(request.headers);
        return { userId: caller.userId };
      },
      {
        response: t.Object({ userId: t.String() }),
        detail: { summary: 'Current authenticated user', tags: ['auth'] },
      },
    );
}

/** Route prefixes that must never be exposed as MCP tools (auth handler is opaque). */
export const AUTH_MCP_DENY = ['/api/auth', '/api/me'];
