ALTER TABLE "integration_deliveries" ADD COLUMN "attempt_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "attempt_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "integration_deliveries_attempt_log_age" ON "integration_deliveries" USING btree ("created_at") WHERE "integration_deliveries"."attempt_log" <> '[]'::jsonb;--> statement-breakpoint
CREATE INDEX "deliveries_attempt_log_age" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."attempt_log" <> '[]'::jsonb;