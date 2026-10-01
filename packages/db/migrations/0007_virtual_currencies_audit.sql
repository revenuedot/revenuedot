CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"action_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_identifier" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_identifier" text NOT NULL,
	"additional_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_currencies" (
	"project_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"product_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_currencies_project_id_code_pk" PRIMARY KEY("project_id","code")
);
--> statement-breakpoint
CREATE TABLE "virtual_currency_balances" (
	"customer_id" text NOT NULL,
	"code" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "virtual_currency_balances_customer_id_code_pk" PRIMARY KEY("customer_id","code")
);
--> statement-breakpoint
CREATE TABLE "virtual_currency_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"code" text NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"source_key" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "customer_center" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_currencies" ADD CONSTRAINT "virtual_currencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_currency_balances" ADD CONSTRAINT "virtual_currency_balances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_currency_transactions" ADD CONSTRAINT "virtual_currency_transactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_currency_transactions" ADD CONSTRAINT "virtual_currency_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_project_time" ON "audit_logs" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "vc_tx_customer" ON "virtual_currency_transactions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vc_tx_source_key" ON "virtual_currency_transactions" USING btree ("project_id","customer_id","code","source_key");