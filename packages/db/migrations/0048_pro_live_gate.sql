ALTER TABLE "billing_accounts" ALTER COLUMN "plan" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "grace_ends_at" timestamp with time zone;ALTER TABLE "billing_accounts" ADD COLUMN "grace_ends_at" timestamp with time zone;--> statement-breakpoint
-- Two plans from 2026-10-05 (prd/cloud-billing/PRD.md): Cloud Standard is now Pro, and Cloud Free is no plan (building).
UPDATE "billing_accounts" SET "plan" = 'pro' WHERE "plan" = 'standard';--> statement-breakpoint
UPDATE "billing_accounts" SET "plan" = 'none' WHERE "plan" = 'free';--> statement-breakpoint
UPDATE "users" SET "plan" = 'pro' WHERE "plan" = 'standard';--> statement-breakpoint
UPDATE "users" SET "plan" = 'none' WHERE "plan" = 'free';
