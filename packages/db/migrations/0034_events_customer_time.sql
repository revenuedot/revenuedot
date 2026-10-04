CREATE INDEX "events_customer_time" ON "events" USING btree ("customer_id","event_timestamp_ms","id");--> statement-breakpoint
DROP INDEX "events_customer";