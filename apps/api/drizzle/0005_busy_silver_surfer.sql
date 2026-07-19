ALTER TABLE "clips" ADD COLUMN "trim_start_frame" integer;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "trim_end_frame" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_trimmed" boolean DEFAULT false NOT NULL;
