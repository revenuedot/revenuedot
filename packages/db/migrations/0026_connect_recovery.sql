CREATE TABLE "recovery_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"app_id" text,
	"store" text NOT NULL,
	"store_key" text NOT NULL,
	"product_id" text NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"grace_expires_at" timestamp with time zone,
	"at_risk_usd" double precision,
	"email" text,
	"steps_sent" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"first_sent_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"skip_reason" text,
	"token" text NOT NULL,
	"center_token" text DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') NOT NULL,
	"clicked_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"recovered_transaction_id" text,
	"recovered_usd" double precision,
	"attributed" boolean DEFAULT false NOT NULL,
	"lost_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"project_id" text NOT NULL,
	"step" integer NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"email" text,
	"sent_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "recovery_portal_links" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"project_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_connections" (
	"app_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"method" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"account_hash" text,
	"pending_state_hash" text,
	"pending_nonce_hash" text,
	"pending_until" timestamp with time zone,
	"pending_mode" text,
	"redirect_uri" text,
	"charges_enabled" boolean,
	"details_submitted" boolean,
	"connected_at" timestamp with time zone,
	"connected_by" text,
	"disconnected_at" timestamp with time zone,
	"disconnect_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "recovery_settings" jsonb;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_messages" ADD CONSTRAINT "recovery_messages_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_messages" ADD CONSTRAINT "recovery_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_portal_links" ADD CONSTRAINT "recovery_portal_links_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_portal_links" ADD CONSTRAINT "recovery_portal_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD CONSTRAINT "stripe_connections_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connections" ADD CONSTRAINT "stripe_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_token" ON "recovery_cases" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_center_token" ON "recovery_cases" USING btree ("center_token");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_one_open" ON "recovery_cases" USING btree ("project_id","store","store_key") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "recovery_cases_project" ON "recovery_cases" USING btree ("project_id","detected_at");--> statement-breakpoint
CREATE INDEX "recovery_cases_due" ON "recovery_cases" USING btree ("status","next_step_at");--> statement-breakpoint
CREATE INDEX "recovery_cases_customer" ON "recovery_cases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "recovery_messages_case" ON "recovery_messages" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "recovery_messages_project" ON "recovery_messages" USING btree ("project_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_portal_links_token" ON "recovery_portal_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "recovery_portal_links_case" ON "recovery_portal_links" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "stripe_connections_account" ON "stripe_connections" USING btree ("account_hash");