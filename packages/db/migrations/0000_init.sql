CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 2 NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"bundle_id" text,
	"public_key" text NOT NULL,
	"credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notification_forward_url" text,
	"last_notification_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_aliases" (
	"project_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_aliases_project_id_app_user_id_pk" PRIMARY KEY("project_id","app_user_id")
);
--> statement-breakpoint
CREATE TABLE "customer_attributes" (
	"customer_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"updated_at_ms" bigint NOT NULL,
	CONSTRAINT "customer_attributes_customer_id_key_pk" PRIMARY KEY("customer_id","key")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"original_app_user_id" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_app_version" text,
	"last_seen_platform" text,
	"last_seen_country" text,
	"original_application_version" text,
	"original_purchase_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "entitlement_products" (
	"entitlement_id" text NOT NULL,
	"product_id" text NOT NULL,
	CONSTRAINT "entitlement_products_entitlement_id_product_id_pk" PRIMARY KEY("entitlement_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text,
	"type" text NOT NULL,
	"environment" text NOT NULL,
	"app_id" text,
	"payload" jsonb NOT NULL,
	"event_timestamp_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	CONSTRAINT "memberships_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "non_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"app_id" text,
	"store" text NOT NULL,
	"product_identifier" text NOT NULL,
	"store_transaction_id" text NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"is_consumable" boolean DEFAULT false NOT NULL,
	"purchase_date" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	"price_amount" double precision,
	"price_currency" text,
	"price_usd" double precision,
	"country_code" text
);
--> statement-breakpoint
CREATE TABLE "offerings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"display_name" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_products" (
	"package_id" text NOT NULL,
	"product_id" text NOT NULL,
	"eligibility_criteria" text DEFAULT 'all' NOT NULL,
	CONSTRAINT "package_products_package_id_product_id_pk" PRIMARY KEY("package_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" text PRIMARY KEY NOT NULL,
	"offering_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"display_name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"store_identifier" text NOT NULL,
	"type" text DEFAULT 'subscription' NOT NULL,
	"display_name" text,
	"duration" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"transfer_behavior" text DEFAULT 'transfer' NOT NULL,
	"sandbox_transfer_behavior" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"store" text NOT NULL,
	"type" text,
	"subtype" text,
	"environment" text,
	"body" text NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"forward_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"app_id" text,
	"store" text NOT NULL,
	"store_key" text NOT NULL,
	"product_identifier" text NOT NULL,
	"product_plan_identifier" text,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"purchase_date" timestamp with time zone NOT NULL,
	"original_purchase_date" timestamp with time zone NOT NULL,
	"expires_date" timestamp with time zone,
	"period_type" text DEFAULT 'normal' NOT NULL,
	"ownership_type" text DEFAULT 'PURCHASED' NOT NULL,
	"unsubscribe_detected_at" timestamp with time zone,
	"billing_issues_detected_at" timestamp with time zone,
	"grace_period_expires_date" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"auto_resume_date" timestamp with time zone,
	"store_transaction_id" text,
	"original_transaction_id" text,
	"price_amount" double precision,
	"price_currency" text,
	"price_usd" double precision,
	"country_code" text,
	"auto_renew_product_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"app_id" text,
	"store" text NOT NULL,
	"store_transaction_id" text NOT NULL,
	"product_identifier" text NOT NULL,
	"kind" text NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revenue_usd" double precision DEFAULT 0 NOT NULL,
	"price_amount" double precision,
	"price_currency" text,
	"country_code" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"response_ms" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"authorization_header" text,
	"signing_secret" text NOT NULL,
	"environment" text DEFAULT 'both' NOT NULL,
	"app_id" text,
	"event_types" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_aliases" ADD CONSTRAINT "customer_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_aliases" ADD CONSTRAINT "customer_aliases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_attributes" ADD CONSTRAINT "customer_attributes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_products" ADD CONSTRAINT "entitlement_products_entitlement_id_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."entitlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_products" ADD CONSTRAINT "entitlement_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_subscriptions" ADD CONSTRAINT "non_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_subscriptions" ADD CONSTRAINT "non_subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_subscriptions" ADD CONSTRAINT "non_subscriptions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_products" ADD CONSTRAINT "package_products_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_products" ADD CONSTRAINT "package_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_notifications" ADD CONSTRAINT "store_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_public_key" ON "apps" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "apps_project" ON "apps" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "aliases_customer" ON "customer_aliases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_project" ON "customers" USING btree ("project_id","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_lookup" ON "entitlements" USING btree ("project_id","lookup_key");--> statement-breakpoint
CREATE INDEX "events_project_time" ON "events" USING btree ("project_id","event_timestamp_ms");--> statement-breakpoint
CREATE INDEX "events_customer" ON "events" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "non_subs_store_tx" ON "non_subscriptions" USING btree ("project_id","store","store_transaction_id");--> statement-breakpoint
CREATE INDEX "non_subs_customer" ON "non_subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offerings_lookup" ON "offerings" USING btree ("project_id","lookup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_lookup" ON "packages" USING btree ("offering_id","lookup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "products_app_store_id" ON "products" USING btree ("app_id","store_identifier");--> statement-breakpoint
CREATE INDEX "notifications_app_time" ON "store_notifications" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_store_key" ON "subscriptions" USING btree ("project_id","store","store_key");--> statement-breakpoint
CREATE INDEX "subscriptions_customer" ON "subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_store_tx" ON "transactions" USING btree ("project_id","store","store_transaction_id","kind");--> statement-breakpoint
CREATE INDEX "transactions_time" ON "transactions" USING btree ("project_id","purchased_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_unique" ON "webhook_deliveries" USING btree ("webhook_id","event_id");