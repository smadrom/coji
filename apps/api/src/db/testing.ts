import { sql } from 'drizzle-orm';
/**
 * DB test harness (P0.6).
 *
 * Provides a Postgres-backed drizzle client for integration tests, plus helpers
 * to apply migrations and truncate tables between tests. DB-backed tests are
 * GATED on `DATABASE_URL` (or `TEST_DATABASE_URL`) being set, so CI without a
 * Postgres stays green and the same suite runs for real once a DB is available
 * (matches the P0.3 CI-deferred migration-apply decision).
 *
 * Usage:
 *   const dbAvailable = hasTestDb();
 *   describe.skipIf(!dbAvailable)('...', () => { ... });
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './tables.ts';

export function testDbUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

export function hasTestDb(): boolean {
  return testDbUrl() !== undefined && testDbUrl() !== '';
}

export type TestDb = ReturnType<typeof drizzle<typeof schema>> & { $client: postgres.Sql };

/** Open a drizzle client + raw sql client against the test DB. */
export function openTestDb(): { db: TestDb; client: postgres.Sql } {
  const url = testDbUrl();
  if (!url) throw new Error('No TEST_DATABASE_URL / DATABASE_URL set for DB tests');
  const client = postgres(url, { prepare: false, max: 8 });
  const db = drizzle(client, { schema }) as TestDb;
  return { db, client };
}

/** Apply the generated migrations to the test DB (idempotent). */
export async function applyMigrations(db: TestDb): Promise<void> {
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
}

/** Remove all rows from the coji-owned tables (fast inter-test reset). */
export async function truncateAll(client: postgres.Sql): Promise<void> {
  await client`TRUNCATE TABLE credit_ledger, provider_jobs, renders, clips, frames, stage_prices, projects RESTART IDENTITY CASCADE`;
}

export { sql };
