ALTER TABLE "clips" ADD COLUMN "script" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "order_idx" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "clips_order_idx" ON "clips" USING btree ("order_idx");--> statement-breakpoint
-- Backfill legacy 4-clip rows (clip-composer): order_idx = source frame's idx so
-- existing projects keep their storyboard order once ordering moves off frames.idx.
-- script stays '' (column default). Idempotent: re-running just re-sets the same value.
UPDATE "clips" SET "order_idx" = "frames"."idx"
  FROM "frames" WHERE "clips"."frame_id" = "frames"."id";
--> statement-breakpoint
-- ROLLBACK (manual): the change is additive, so reverting is dropping the two
-- columns + the index:
--   DROP INDEX "clips_order_idx";
--   ALTER TABLE "clips" DROP COLUMN "order_idx";
--   ALTER TABLE "clips" DROP COLUMN "script";
