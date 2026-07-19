CREATE TYPE "public"."audio_mode" AS ENUM('tts', 'audio_url');--> statement-breakpoint
CREATE TYPE "public"."clip_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."frame_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('image', 'animation', 'render');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('hold', 'debit', 'refund', 'topup');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'images_ready', 'awaiting_decision', 'animating', 'clips_ready', 'editing', 'rendered', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."render_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."stage" AS ENUM('image', 'animation', 'render');--> statement-breakpoint
CREATE TYPE "public"."stage_price_unit" AS ENUM('per_set', 'per_clip', 'per_export');--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"frame_id" uuid NOT NULL,
	"heygen_video_id" text,
	"video_url" text,
	"status" "clip_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid,
	"stage" text,
	"kind" "ledger_kind" NOT NULL,
	"credits" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"provider_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"image_ref" text,
	"caption" text,
	"status" "frame_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"audio_mode" "audio_mode" DEFAULT 'tts' NOT NULL,
	"script" text,
	"voice_id" text,
	"audio_url" text,
	"credits_spent" integer DEFAULT 0 NOT NULL,
	"render_attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"output_url" text,
	"status" "render_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" "stage" NOT NULL,
	"unit" "stage_price_unit" NOT NULL,
	"credits" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_frame_id_frames_id_fk" FOREIGN KEY ("frame_id") REFERENCES "public"."frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_provider_job_id_provider_jobs_id_fk" FOREIGN KEY ("provider_job_id") REFERENCES "public"."provider_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frames" ADD CONSTRAINT "frames_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clips_frame_id_idx" ON "clips" USING btree ("frame_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_id_idx" ON "credit_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_project_id_idx" ON "credit_ledger" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_provider_job_id_idx" ON "credit_ledger" USING btree ("provider_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_job_kind_uidx" ON "credit_ledger" USING btree ("provider_job_id","kind");--> statement-breakpoint
CREATE INDEX "frames_project_id_idx" ON "frames" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "frames_project_idx_uidx" ON "frames" USING btree ("project_id","idx");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "provider_jobs_project_id_idx" ON "provider_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "provider_jobs_status_lease_idx" ON "provider_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "renders_project_id_idx" ON "renders" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_prices_stage_unit_uidx" ON "stage_prices" USING btree ("stage","unit");