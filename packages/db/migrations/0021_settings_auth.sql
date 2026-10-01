CREATE TABLE "auth_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"audiences" text[] NOT NULL,
	"jwks_url" text,
	"firebase_project_id" text,
	"app_user_id_claim" text DEFAULT 'sub' NOT NULL,
	"app_user_id_prefix" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_customers" (
	"project_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"note" text,
	"blocked_by" text,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_customers_project_id_app_user_id_pk" PRIMARY KEY("project_id","app_user_id")
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"project_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"app_user_id" text NOT NULL,
	"logins" integer DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_provider_id_subject_pk" PRIMARY KEY("provider_id","subject")
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"provider_id" text,
	"subject" text,
	"method" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"previous_refresh_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_pages" (
	"project_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"chart_type" text DEFAULT 'number_sparkline' NOT NULL,
	"metrics" jsonb NOT NULL,
	"show_icon" boolean DEFAULT false NOT NULL,
	"icon_asset_id" text,
	"show_store_links" boolean DEFAULT false NOT NULL,
	"app_store_url" text,
	"play_store_url" text,
	"status" text DEFAULT 'never_published' NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sandbox_testing_access" text DEFAULT 'anybody' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sandbox_testers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "brand" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auth_settings" jsonb;--> statement-breakpoint
ALTER TABLE "subscriber_tokens" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_customers" ADD CONSTRAINT "blocked_customers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_provider_id_auth_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_provider_id_auth_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_pages" ADD CONSTRAINT "verified_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_providers_project" ON "auth_providers" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "blocked_customers_time" ON "blocked_customers" USING btree ("project_id","blocked_at");--> statement-breakpoint
CREATE INDEX "identity_links_user" ON "identity_links" USING btree ("project_id","app_user_id");--> statement-breakpoint
CREATE INDEX "identity_links_recent" ON "identity_links" USING btree ("project_id","last_login_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sessions_refresh" ON "identity_sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_previous_refresh" ON "identity_sessions" USING btree ("previous_refresh_hash");--> statement-breakpoint
CREATE INDEX "identity_sessions_user" ON "identity_sessions" USING btree ("project_id","app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_pages_slug" ON "verified_pages" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_tokens" ADD CONSTRAINT "subscriber_tokens_session_id_identity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."identity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "projects" SET "owner_user_id" = (SELECT m."user_id" FROM "memberships" m JOIN "users" u ON u."id" = m."user_id" WHERE m."project_id" = "projects"."id" AND m."role" = 'admin' ORDER BY u."created_at", u."id" LIMIT 1);
