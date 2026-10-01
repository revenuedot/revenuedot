CREATE TABLE "email_suppressions" (
	"project_id" text NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'unsubscribed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_project_id_email_pk" PRIMARY KEY("project_id","email")
);
--> statement-breakpoint
CREATE TABLE "refund_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"template" text DEFAULT 'custom' NOT NULL,
	"rules" jsonb NOT NULL,
	"preference" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refund_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text,
	"customer_id" text,
	"app_user_id" text,
	"store" text NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"transaction_id" text NOT NULL,
	"original_transaction_id" text,
	"product_id" text,
	"amount_usd" double precision,
	"reason" text,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"policy_id" text,
	"policy_name" text,
	"preference" text,
	"consumption_status" text NOT NULL,
	"consumption" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"trigger" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"store" text NOT NULL,
	"product_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text,
	"customer_id" text,
	"app_user_id" text NOT NULL,
	"customer_email" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"emailed_to" text,
	"emailed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "winback_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience" jsonb NOT NULL,
	"email" jsonb NOT NULL,
	"offer" jsonb NOT NULL,
	"send_hour_utc" integer DEFAULT 16 NOT NULL,
	"track_opens" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "winback_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"offer_url" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "retention_messaging" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "refund_settings" jsonb;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_policies" ADD CONSTRAINT "refund_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_offers" ADD CONSTRAINT "retention_offers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_campaigns" ADD CONSTRAINT "winback_campaigns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_sends" ADD CONSTRAINT "winback_sends_campaign_id_winback_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."winback_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_sends" ADD CONSTRAINT "winback_sends_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winback_sends" ADD CONSTRAINT "winback_sends_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_policies_project" ON "refund_policies" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_requests_tx" ON "refund_requests" USING btree ("project_id","store","transaction_id");--> statement-breakpoint
CREATE INDEX "refund_requests_project_time" ON "refund_requests" USING btree ("project_id","requested_at");--> statement-breakpoint
CREATE INDEX "refund_requests_due" ON "refund_requests" USING btree ("consumption_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "retention_offers_project" ON "retention_offers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "support_tickets_project" ON "support_tickets" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "winback_campaigns_project" ON "winback_campaigns" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "winback_sends_token" ON "winback_sends" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "winback_sends_once" ON "winback_sends" USING btree ("campaign_id","customer_id");--> statement-breakpoint
CREATE INDEX "winback_sends_project" ON "winback_sends" USING btree ("project_id","sent_at");