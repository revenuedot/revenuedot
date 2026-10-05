CREATE TABLE "journey_sends" (
	"user_id" text NOT NULL,
	"step" text NOT NULL,
	"token_hash" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_sends_user_id_step_pk" PRIMARY KEY("user_id","step")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "standard_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rc_import_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "product_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "journey_path" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by" text;--> statement-breakpoint
ALTER TABLE "journey_sends" ADD CONSTRAINT "journey_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_sends_token" ON "journey_sends" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "journey_sends_time" ON "journey_sends" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "transactions_live_sales" ON "transactions" USING btree ("project_id","created_at") WHERE "transactions"."source" IS NULL AND NOT "transactions"."is_sandbox" AND "transactions"."revenue_usd" > 0 AND "transactions"."kind" IN ('purchase', 'renewal', 'one_time');--> statement-breakpoint
CREATE INDEX "transactions_sandbox" ON "transactions" USING btree ("project_id","created_at") WHERE "transactions"."is_sandbox";--> statement-breakpoint
CREATE UNIQUE INDEX "users_referral_code" ON "users" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "users_referred_by" ON "users" USING btree ("referred_by");--> statement-breakpoint
-- Accounts already on Standard keep their billing start as the Standard start, so a later cancellation can be asked about.
UPDATE "billing_accounts" SET "standard_started_at" = "created_at" WHERE "plan" = 'standard' AND "standard_started_at" IS NULL;
