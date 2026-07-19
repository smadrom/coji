/**
 * Bun test preload (task #22). Runs before any test module is imported, so it
 * can set env that `env.ts` reads at evaluation time.
 *
 * Enables the AUTH_TEST_HEADER escape hatch so the app.handle suites can supply
 * identity via `x-user-id` and exercise the REAL ownership guard without minting
 * a live Better Auth session. This flag defaults OFF and is never set in
 * production. DB-gated auth tests that need real sessions run their own setup.
 */
process.env.AUTH_TEST_HEADER ??= 'true';
