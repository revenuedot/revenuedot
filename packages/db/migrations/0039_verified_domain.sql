ALTER TABLE "verified_pages" ADD COLUMN "custom_domain" text;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_token" text;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_error" text;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_hostname_id" text;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD COLUMN "domain_ssl_status" text;--> statement-breakpoint
CREATE UNIQUE INDEX "verified_pages_custom" ON "verified_pages" USING btree ("custom_domain") WHERE "verified_pages"."domain_status" = 'verified';