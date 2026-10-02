CREATE TABLE "anomaly_checks" (
	"project_id" text NOT NULL,
	"day" text NOT NULL,
	"result" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anomaly_checks_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"weekly_summary" boolean DEFAULT false NOT NULL,
	"experiment_results" boolean DEFAULT false NOT NULL,
	"anomaly_alerts" boolean DEFAULT false NOT NULL,
	"anomaly_sensitivity" text DEFAULT 'medium' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "notification_sends" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"token_hash" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_sends_user_id_project_id_kind_key_pk" PRIMARY KEY("user_id","project_id","kind","key")
);
--> statement-breakpoint
CREATE TABLE "two_factor_recovery_codes" (
	"user_id" text NOT NULL,
	"hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "two_factor_recovery_codes_user_id_hash_pk" PRIMARY KEY("user_id","hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD COLUMN "new_email" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tint" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "week_start" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "anomaly_checks" ADD CONSTRAINT "anomaly_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_sends" ADD CONSTRAINT "notification_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_sends" ADD CONSTRAINT "notification_sends_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor_recovery_codes" ADD CONSTRAINT "two_factor_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_sends_token" ON "notification_sends" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_created_by" ON "api_keys" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");