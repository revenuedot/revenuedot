CREATE TABLE "export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"destination" text NOT NULL,
	"destination_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"secret_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"compression" text DEFAULT 'gzip' NOT NULL,
	"schedule" text DEFAULT 'daily' NOT NULL,
	"hour_utc" integer DEFAULT 3 NOT NULL,
	"weekday" integer,
	"mode" text DEFAULT 'incremental' NOT NULL,
	"tables" jsonb NOT NULL,
	"environment" text DEFAULT 'both' NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "export_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" jsonb,
	"rows" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_as" text,
	"request" text,
	"request_body" text,
	"response_status" integer,
	"response_ms" integer,
	"response_body" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"app_id" text,
	"event_types" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"secret_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_job_id_export_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_jobs_project" ON "export_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "export_jobs_due" ON "export_jobs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "export_runs_job" ON "export_runs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "export_runs_due" ON "export_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_deliveries_due" ON "integration_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_deliveries_unique" ON "integration_deliveries" USING btree ("integration_id","event_id");--> statement-breakpoint
CREATE INDEX "integration_deliveries_log" ON "integration_deliveries" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integrations_project" ON "integrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "customers_project_first_seen" ON "customers" USING btree ("project_id","first_seen","id");--> statement-breakpoint
CREATE INDEX "events_project_created" ON "events" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "subscriptions_project_updated" ON "subscriptions" USING btree ("project_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "transactions_project_created" ON "transactions" USING btree ("project_id","created_at","id");