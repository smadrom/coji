/**
 * e2e seed runner (Phase 4a). Applies ./seed.sql against DATABASE_URL using the
 * `postgres` client (already a dependency of the api image, so the migrate step
 * needs no psql binary). Run AFTER `drizzle-kit migrate`:
 *
 *   bun run db:migrate && bun run /app/e2e/seed.ts
 *
 * The file is executed as a single multi-statement batch via `.unsafe()`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('seed: DATABASE_URL is required');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'seed.sql'), 'utf8');

const client = postgres(databaseUrl, { prepare: false, max: 1 });
try {
  await client.unsafe(sql);
  console.log('seed: applied e2e/seed.sql (stage_prices + auto-credit trigger)');
} catch (err) {
  console.error('seed: failed', err);
  process.exit(1);
} finally {
  await client.end();
}
