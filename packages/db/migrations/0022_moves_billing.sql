CREATE TABLE "archive_blobs" (
	"key" text PRIMARY KEY NOT NULL,
	"data_base64" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"number" text,
	"status" text NOT NULL,
	"amount_due" integer DEFAULT 0 NOT NULL,
	"amount_paid" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"hosted_invoice_url" text,
	"invoice_pdf" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_meter_reports" (
	"user_id" text NOT NULL,
	"month" text NOT NULL,
	"cents" integer NOT NULL,
	"identifier" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_meter_reports_user_id_month_pk" PRIMARY KEY("user_id","month")
);
--> statement-breakpoint
CREATE TABLE "billing_notices" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_notices_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "billing_usage" (
	"project_id" text NOT NULL,
	"month" text NOT NULL,
	"owner_user_id" text,
	"project_name" text,
	"tracked_revenue_usd" double precision DEFAULT 0 NOT NULL,
	"transactions" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_project_id_month_pk" PRIMARY KEY("project_id","month")
);
--> statement-breakpoint
CREATE TABLE "project_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"purpose" text DEFAULT 'download' NOT NULL,
	"include_secrets" boolean DEFAULT false NOT NULL,
	"secret_key" text,
	"secret_salt" text,
	"storage" text NOT NULL,
	"tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" jsonb,
	"manifest" jsonb,
	"rows" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"project_id" text,
	"source_url" text,
	"manifest" jsonb,
	"files_done" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_key" text,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verify" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_url" text NOT NULL,
	"secrets" text NOT NULL,
	"status" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"lease_until" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "move_state" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "moved_to_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "move_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "moved_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "moved_in_from" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_exports" ADD CONSTRAINT "project_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_imports" ADD CONSTRAINT "project_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_moves" ADD CONSTRAINT "project_moves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_customer" ON "billing_accounts" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_user" ON "billing_invoices" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_usage_owner" ON "billing_usage" USING btree ("owner_user_id","month");--> statement-breakpoint
CREATE INDEX "project_exports_project" ON "project_exports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_exports_due" ON "project_exports" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_imports_token" ON "project_imports" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_imports_project" ON "project_imports" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_moves_project" ON "project_moves" USING btree ("project_id","created_at");