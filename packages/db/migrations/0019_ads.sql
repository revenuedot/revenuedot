CREATE TABLE "ad_reward_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL,
	"app_id" text,
	"ad_unit_id" text,
	"reward_item" text,
	"kind" text NOT NULL,
	"currency_code" text,
	"amount" integer,
	"multiplier" double precision,
	"entitlement_id" text,
	"duration_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ad_reward_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text,
	"customer_id" text,
	"app_user_id" text NOT NULL,
	"client_transaction_id" text NOT NULL,
	"network" text NOT NULL,
	"network_transaction_id" text NOT NULL,
	"ad_unit_id" text,
	"impression_id" text,
	"reward_item" text,
	"reward_amount" integer,
	"status" text NOT NULL,
	"failure_reason" text,
	"rule_id" text,
	"rewards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_units" (
	"project_id" text NOT NULL,
	"network" text NOT NULL,
	"ad_unit_id" text NOT NULL,
	"account_id" text,
	"network_app_id" text,
	"display_name" text NOT NULL,
	"format" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_units_project_id_network_ad_unit_id_pk" PRIMARY KEY("project_id","network","ad_unit_id")
);
--> statement-breakpoint
ALTER TABLE "ad_reward_rules" ADD CONSTRAINT "ad_reward_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_reward_verifications" ADD CONSTRAINT "ad_reward_verifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_reward_verifications" ADD CONSTRAINT "ad_reward_verifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_units" ADD CONSTRAINT "ad_units_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_reward_rules_project" ON "ad_reward_rules" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_reward_verifications_client_tx" ON "ad_reward_verifications" USING btree ("project_id","client_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_reward_verifications_network_tx" ON "ad_reward_verifications" USING btree ("network","network_transaction_id");--> statement-breakpoint
CREATE INDEX "ad_reward_verifications_project" ON "ad_reward_verifications" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sdk_events_project_type_time" ON "sdk_events" USING btree ("project_id","type","occurred_at");