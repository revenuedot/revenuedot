-- An early build of this branch created these two tables, empty and never read, on RevenueDot Cloud's database: replace them.
DROP TABLE IF EXISTS "chart_rollups";--> statement-breakpoint
DROP TABLE IF EXISTS "chart_rollup_state";--> statement-breakpoint
CREATE TABLE "chart_rollup_state" (
	"project_id" text NOT NULL,
	"is_sandbox" boolean NOT NULL,
	"generation" integer,
	"version" text,
	"computed_at" timestamp with time zone,
	"switched_at" timestamp with time zone,
	"rows_at" timestamp with time zone,
	"build_generation" integer,
	"build_version" text,
	"build_now" timestamp with time zone,
	"build_rows_at" timestamp with time zone,
	"build_from_ms" bigint,
	"build_runs" integer DEFAULT 0 NOT NULL,
	"build_ms" integer DEFAULT 0 NOT NULL,
	"viewed_at" timestamp with time zone,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_rollup_state_project_id_is_sandbox_pk" PRIMARY KEY("project_id","is_sandbox")
);
--> statement-breakpoint
CREATE TABLE "chart_rollups" (
	"project_id" text NOT NULL,
	"is_sandbox" boolean NOT NULL,
	"generation" integer NOT NULL,
	"day_ms" bigint NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "chart_rollups_project_id_is_sandbox_generation_day_ms_pk" PRIMARY KEY("project_id","is_sandbox","generation","day_ms")
);
--> statement-breakpoint
ALTER TABLE "chart_rollup_state" ADD CONSTRAINT "chart_rollup_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_rollups" ADD CONSTRAINT "chart_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;