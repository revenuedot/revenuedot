CREATE TABLE "discount_codes" (
	"project_id" text NOT NULL,
	"code_key" text NOT NULL,
	"code" text NOT NULL,
	"discount_id" text NOT NULL,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"stripe" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_project_id_code_key_pk" PRIMARY KEY("project_id","code_key")
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"identifier" text NOT NULL,
	"customer_facing_name" text NOT NULL,
	"type" text NOT NULL,
	"percentage" integer,
	"fixed_amounts" jsonb,
	"duration_mode" text NOT NULL,
	"time_window" text,
	"eligibility" text DEFAULT 'everyone' NOT NULL,
	"product_identifiers" jsonb,
	"max_redemptions" integer,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"stripe" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"funnel_id" text NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"step_id" text,
	"step_index" integer,
	"app_user_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revenue_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_links" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"offering_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"discount_id" text,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"offering_id" text,
	"package_id" text,
	"product_id" text,
	"app_user_id" text NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"email" text,
	"discount_id" text,
	"discount_code" text,
	"funnel_session_id" text,
	"stripe_session_id" text,
	"status" text DEFAULT 'created' NOT NULL,
	"completed_at" timestamp with time zone,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"amount_usd" double precision,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redemption_seed" text,
	"redemption_generation" integer DEFAULT 0 NOT NULL,
	"redemption_token_hash" text,
	"redemption_expires_at" timestamp with time zone,
	"redemption_sent_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_customer_id" text,
	"redeemed_app_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_configs" (
	"app_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_domains" (
	"project_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"verification_token" text NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"interval" text,
	"interval_count" integer,
	"trial_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_links" ADD CONSTRAINT "purchase_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_links" ADD CONSTRAINT "purchase_links_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_links" ADD CONSTRAINT "purchase_links_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_checkouts" ADD CONSTRAINT "web_checkouts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_checkouts" ADD CONSTRAINT "web_checkouts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_configs" ADD CONSTRAINT "web_configs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_configs" ADD CONSTRAINT "web_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_domains" ADD CONSTRAINT "web_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_products" ADD CONSTRAINT "web_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_products" ADD CONSTRAINT "web_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_products" ADD CONSTRAINT "web_products_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_codes_discount" ON "discount_codes" USING btree ("discount_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_identifier" ON "discounts" USING btree ("project_id","identifier");--> statement-breakpoint
CREATE INDEX "funnel_events_funnel" ON "funnel_events" USING btree ("funnel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "funnels_slug" ON "funnels" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_links_slug" ON "purchase_links" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "web_checkouts_session" ON "web_checkouts" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_checkouts_token" ON "web_checkouts" USING btree ("redemption_token_hash");--> statement-breakpoint
CREATE INDEX "web_checkouts_project" ON "web_checkouts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "web_configs_project" ON "web_configs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_domains_slug" ON "web_domains" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "web_domains_custom" ON "web_domains" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "web_products_project" ON "web_products" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_products_price" ON "web_products" USING btree ("app_id","stripe_price_id");