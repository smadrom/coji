/**
 * Idempotent local-development seed.
 *
 * It adds stage prices and auto-funds local users so a fresh clone can exercise
 * the full Noop pipeline without configuring Stripe or editing the database by
 * hand. The hostname guard prevents accidental use against a remote database.
 */
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('db:seed:dev is disabled when NODE_ENV=production');
}

const hostname = new URL(databaseUrl).hostname;
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (!localHosts.has(hostname) && process.env.ALLOW_DEV_SEED !== 'true') {
  throw new Error(
    `Refusing to seed non-local database host '${hostname}'. Set ALLOW_DEV_SEED=true only if this is intentional.`,
  );
}

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

try {
  await sql.unsafe(`
    INSERT INTO stage_prices (stage, unit, credits, notes)
    VALUES
      ('image', 'per_set', 10, 'local development'),
      ('animation', 'per_clip', 20, 'local development'),
      ('render', 'per_export', 30, 'local development')
    ON CONFLICT (stage, unit) DO UPDATE
      SET credits = EXCLUDED.credits,
          notes = EXCLUDED.notes;

    INSERT INTO credit_ledger (user_id, kind, credits, balance_after)
    SELECT u.id, 'topup', 100000, 100000
    FROM "user" AS u
    WHERE NOT EXISTS (
      SELECT 1 FROM credit_ledger AS ledger WHERE ledger.user_id = u.id
    );

    CREATE OR REPLACE FUNCTION dev_grant_credits() RETURNS trigger AS $$
    BEGIN
      INSERT INTO credit_ledger (user_id, kind, credits, balance_after)
      VALUES (NEW.id, 'topup', 100000, 100000);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS dev_grant_credits_trg ON "user";
    CREATE TRIGGER dev_grant_credits_trg
      AFTER INSERT ON "user"
      FOR EACH ROW EXECUTE FUNCTION dev_grant_credits();
  `);
  console.log('Seeded local stage prices and development credits.');
} finally {
  await sql.end();
}
