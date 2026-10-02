CREATE TABLE "chart_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"token" text NOT NULL,
	"token_hash" text NOT NULL,
	"chart_name" text NOT NULL,
	"view" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"image" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chart_annotations" ADD CONSTRAINT "chart_annotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_shares" ADD CONSTRAINT "chart_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chart_annotations_project" ON "chart_annotations" USING btree ("project_id","start_date");--> statement-breakpoint
CREATE INDEX "chart_shares_project" ON "chart_shares" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_shares_token_hash" ON "chart_shares" USING btree ("token_hash");