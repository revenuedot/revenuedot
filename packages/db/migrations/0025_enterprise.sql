CREATE TABLE "ee_custom_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_membership_sources" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"role" text,
	CONSTRAINT "ee_membership_sources_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ee_org_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"target_type" text NOT NULL,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"sso_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_sso_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ee_org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ee_org_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"region" text DEFAULT 'us' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT 'us' NOT NULL,
	"audit_retention_days" integer,
	"sso_enforced" boolean DEFAULT false NOT NULL,
	"seats" integer,
	"billing_email" text,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_role_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"group_name" text NOT NULL,
	"group_key" text NOT NULL,
	"project_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_saml_assertions" (
	"connection_id" text NOT NULL,
	"assertion_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ee_saml_assertions_connection_id_assertion_id_pk" PRIMARY KEY("connection_id","assertion_id")
);
--> statement-breakpoint
CREATE TABLE "ee_scim_group_members" (
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	CONSTRAINT "ee_scim_group_members_group_id_scim_user_id_pk" PRIMARY KEY("group_id","scim_user_id")
);
--> statement-breakpoint
CREATE TABLE "ee_scim_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"display_name" text NOT NULL,
	"display_key" text NOT NULL,
	"external_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_scim_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_scim_users" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_sso_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"secret" text,
	"jit" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_sso_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_sso_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"value" text NOT NULL,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ee_sso_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ee_custom_roles" ADD CONSTRAINT "ee_custom_roles_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_custom_roles" ADD CONSTRAINT "ee_custom_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_membership_sources" ADD CONSTRAINT "ee_membership_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_membership_sources" ADD CONSTRAINT "ee_membership_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_org_audit_logs" ADD CONSTRAINT "ee_org_audit_logs_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_org_members" ADD CONSTRAINT "ee_org_members_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_org_members" ADD CONSTRAINT "ee_org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_org_projects" ADD CONSTRAINT "ee_org_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_org_projects" ADD CONSTRAINT "ee_org_projects_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_organizations" ADD CONSTRAINT "ee_organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_role_mappings" ADD CONSTRAINT "ee_role_mappings_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_role_mappings" ADD CONSTRAINT "ee_role_mappings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_saml_assertions" ADD CONSTRAINT "ee_saml_assertions_connection_id_ee_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ee_sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_group_members" ADD CONSTRAINT "ee_scim_group_members_group_id_ee_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."ee_scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_group_members" ADD CONSTRAINT "ee_scim_group_members_scim_user_id_ee_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."ee_scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_groups" ADD CONSTRAINT "ee_scim_groups_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_tokens" ADD CONSTRAINT "ee_scim_tokens_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_tokens" ADD CONSTRAINT "ee_scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_users" ADD CONSTRAINT "ee_scim_users_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_scim_users" ADD CONSTRAINT "ee_scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_connections" ADD CONSTRAINT "ee_sso_connections_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_domains" ADD CONSTRAINT "ee_sso_domains_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_requests" ADD CONSTRAINT "ee_sso_requests_connection_id_ee_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ee_sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_sessions" ADD CONSTRAINT "ee_sso_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_sessions" ADD CONSTRAINT "ee_sso_sessions_org_id_ee_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."ee_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_sessions" ADD CONSTRAINT "ee_sso_sessions_connection_id_ee_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ee_sso_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ee_sso_sessions" ADD CONSTRAINT "ee_sso_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ee_custom_roles_name" ON "ee_custom_roles" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "ee_org_audit_logs_org_time" ON "ee_org_audit_logs" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ee_org_members_user" ON "ee_org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ee_org_projects_org" ON "ee_org_projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ee_role_mappings_unique" ON "ee_role_mappings" USING btree ("org_id","group_key","project_id");--> statement-breakpoint
CREATE INDEX "ee_saml_assertions_expiry" ON "ee_saml_assertions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ee_scim_group_members_user" ON "ee_scim_group_members" USING btree ("scim_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ee_scim_groups_name" ON "ee_scim_groups" USING btree ("org_id","display_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ee_scim_tokens_hash" ON "ee_scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ee_scim_tokens_org" ON "ee_scim_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ee_scim_users_name" ON "ee_scim_users" USING btree ("org_id","user_name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ee_scim_users_user" ON "ee_scim_users" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "ee_sso_connections_org" ON "ee_sso_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ee_sso_domains_org" ON "ee_sso_domains" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ee_sso_requests_expiry" ON "ee_sso_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ee_sso_sessions_user" ON "ee_sso_sessions" USING btree ("user_id");