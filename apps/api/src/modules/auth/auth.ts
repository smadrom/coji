/**
 * Better Auth instance (task #22).
 *
 * Email+password sign-up/sign-in with bearer sessions (token in
 * `Authorization: Bearer <token>`), backed by the Drizzle adapter over the
 * existing Postgres (auth tables in db/auth-schema.ts). The handler is mounted
 * on the literal Eden `.use()` chain at /api/auth/* in app.ts.
 *
 * Security: BETTER_AUTH_SECRET MUST be a real value in production — we throw at
 * import time if it is left at the dev fallback while NODE_ENV=production, so a
 * misconfigured prod deploy fails fast instead of running with a known secret.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import * as authSchema from '../../db/auth-schema.ts';
import { db } from '../../db/index.ts';
import { env } from '../../env.ts';

const DEV_SECRET = 'dev-secret-change-me';
if (env.nodeEnv === 'production' && env.betterAuthSecret === DEV_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET must be set to a real value in production (it is still the dev fallback).',
  );
}

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  emailAndPassword: { enabled: true },
  // Bearer: accept the session via `Authorization: Bearer <token>` (the web app
  // stores the token rather than relying on cross-origin cookies).
  plugins: [bearer()],
});

export type Auth = typeof auth;
