ALTER TABLE "fx_rates" ADD COLUMN "source" text DEFAULT 'ecb' NOT NULL;--> statement-breakpoint
ALTER TABLE "fx_rates" DROP CONSTRAINT "fx_rates_pkey";--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_source_date_pk" PRIMARY KEY("source","date");
