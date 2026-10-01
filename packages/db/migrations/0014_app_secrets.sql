ALTER TABLE "apps" ADD COLUMN "secrets" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "secret_hints" jsonb DEFAULT '{}'::jsonb NOT NULL;