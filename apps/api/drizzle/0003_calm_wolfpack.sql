ALTER TABLE "projects" ADD COLUMN "style" text DEFAULT 'american' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "locale" text DEFAULT 'en-US' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "gender" text DEFAULT 'female' NOT NULL;