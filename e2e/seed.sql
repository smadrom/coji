-- e2e seed (Phase 4a). Applied AFTER `drizzle-kit migrate` in the migrate step
-- of docker-compose.e2e.yml. SQL is the ONE seeding mechanism (no API path):
--
--   1. stage_prices  — paid stages 500 without a price row (Gotchas #7). Seed
--      the bounded v1 units (image/per_set, animation/per_clip, render/per_export).
--   2. credits       — the e2e user signs up through REAL Better Auth, so its
--      user-id is unknown at migrate time. Instead of seeding a fixed id, an
--      AFTER INSERT trigger on "user" appends a `topup` credit_ledger row for
--      every newly created user. balance = latest balance_after (ledger.ts), so
--      a single topup is enough; the trigger makes any signed-up e2e user funded.
--
-- Idempotent: safe to re-run (ON CONFLICT on stage_prices' unique (stage,unit);
-- CREATE OR REPLACE / DROP-IF-EXISTS on the trigger).

-- 1. Stage prices ----------------------------------------------------------
INSERT INTO stage_prices (stage, unit, credits, notes)
VALUES
  ('image',     'per_set',    10, 'e2e seed'),
  ('animation', 'per_clip',   20, 'e2e seed'),
  ('render',    'per_export', 30, 'e2e seed')
ON CONFLICT (stage, unit) DO UPDATE
  SET credits = EXCLUDED.credits;

-- 2. Auto-fund every new user on sign-up -----------------------------------
-- 100000 credits is far above any single e2e flow's hold (image 10 + animation
-- 4*20 + render 30), so funding is never the bottleneck under test.
CREATE OR REPLACE FUNCTION e2e_grant_credits() RETURNS trigger AS $$
BEGIN
  INSERT INTO credit_ledger (user_id, kind, credits, balance_after)
  VALUES (NEW.id, 'topup', 100000, 100000);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS e2e_grant_credits_trg ON "user";
CREATE TRIGGER e2e_grant_credits_trg
  AFTER INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION e2e_grant_credits();
