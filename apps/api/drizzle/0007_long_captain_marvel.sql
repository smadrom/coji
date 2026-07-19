-- clip-composer: add the `composing` project_status enum value (awaiting_decision
-- → composing → animating). Postgres ALTER TYPE ADD VALUE must be its OWN migration
-- (cannot run inside a multi-statement tx with other DDL), hence a standalone 0007.
-- IF NOT EXISTS makes a re-run a no-op.
ALTER TYPE "public"."project_status" ADD VALUE IF NOT EXISTS 'composing' BEFORE 'animating';