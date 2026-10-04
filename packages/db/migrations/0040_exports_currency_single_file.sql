ALTER TABLE "export_jobs" ADD COLUMN "split_files" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing CSV exports keep their 10,000-row files, so pipelines that read _partN files do not break; new ones default to one file.
UPDATE "export_jobs" SET "split_files" = true WHERE "format" = 'csv';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vc_tx_project_created" ON "virtual_currency_transactions" USING btree ("project_id","created_at","id");