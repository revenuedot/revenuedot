CREATE TABLE "fx_rates" (
	"date" text PRIMARY KEY NOT NULL,
	"rates" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "non_subscriptions" ADD COLUMN "presented_offering_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "test_store_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "test_store_price_currency" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "presented_offering_id" text;