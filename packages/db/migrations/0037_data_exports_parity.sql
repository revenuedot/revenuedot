ALTER TABLE "export_jobs" ADD COLUMN "interval_hours" integer;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "columns" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "files_deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sdk_events_project_received" ON "sdk_events" USING btree ("project_id","received_at");