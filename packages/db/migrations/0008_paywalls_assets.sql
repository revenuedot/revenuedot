CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"object_name" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt_text" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywall_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"paywall_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywalls" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text,
	"offering_id" text,
	"automatically_scale_font_size" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"draft" jsonb,
	"published" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paywall_versions" ADD CONSTRAINT "paywall_versions_paywall_id_paywalls_id_fk" FOREIGN KEY ("paywall_id") REFERENCES "public"."paywalls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paywalls" ADD CONSTRAINT "paywalls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paywalls" ADD CONSTRAINT "paywalls_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_project" ON "media_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_object" ON "media_assets" USING btree ("project_id","object_name");--> statement-breakpoint
CREATE INDEX "paywalls_project" ON "paywalls" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paywalls_offering" ON "paywalls" USING btree ("offering_id");