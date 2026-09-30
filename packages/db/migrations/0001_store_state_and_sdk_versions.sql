CREATE TABLE "sdk_versions" (
	"project_id" text NOT NULL,
	"app_id" text DEFAULT '' NOT NULL,
	"platform" text NOT NULL,
	"platform_flavor" text DEFAULT 'native' NOT NULL,
	"platform_flavor_version" text DEFAULT '' NOT NULL,
	"sdk_version" text NOT NULL,
	"last_platform_version" text,
	"last_app_version" text,
	"last_app_build" text,
	"last_bundle_id" text,
	"last_app_user_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdk_versions_pk" PRIMARY KEY("project_id","app_id","platform","platform_flavor","platform_flavor_version","sdk_version")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "voided_purchases_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_seen_sdk_version" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_seen_sdk_flavor" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_seen_platform_version" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_seen_app_build" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_increase_status" text;--> statement-breakpoint
ALTER TABLE "sdk_versions" ADD CONSTRAINT "sdk_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;