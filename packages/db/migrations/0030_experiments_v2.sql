ALTER TABLE "experiments" DROP CONSTRAINT "experiments_offering_a_offerings_id_fk";
--> statement-breakpoint
ALTER TABLE "experiments" DROP CONSTRAINT "experiments_offering_b_offerings_id_fk";
--> statement-breakpoint
ALTER TABLE "experiments" ALTER COLUMN "offering_a" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ALTER COLUMN "offering_b" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "experiment_enrollments" ADD COLUMN "is_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "type" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "primary_metric" text DEFAULT 'initial_conversion_rate' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "secondary_metrics" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "enrollment" text DEFAULT 'new_and_existing' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "track_paywall_views" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "audience_rules" jsonb;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_offering_a_offerings_id_fk" FOREIGN KEY ("offering_a") REFERENCES "public"."offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_offering_b_offerings_id_fk" FOREIGN KEY ("offering_b") REFERENCES "public"."offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiments_project_priority" ON "experiments" USING btree ("project_id","priority");--> statement-breakpoint
-- "enrollment" defaults to new_and_existing: before 0030 every customer who asked could be enrolled, so existing
-- experiments (and rows an older server writes during a deploy) keep doing that. RevenueDot always sends it explicitly.
-- Every A/B experiment becomes variants a (Control) and b (Treatment B). Enrollment rows keep their variant letters, so
-- nobody changes variant.
UPDATE "experiments" SET "variants" = jsonb_build_array(
  jsonb_build_object('id', 'a', 'name', 'Control', 'offering_id', "offering_a", 'placements', '{}'::jsonb),
  jsonb_build_object('id', 'b', 'name', 'Treatment B', 'offering_id', "offering_b", 'placements', '{}'::jsonb)
) WHERE "variants" = '[]'::jsonb AND "offering_a" IS NOT NULL AND "offering_b" IS NOT NULL;--> statement-breakpoint
-- Before 0030 the earliest started experiment enrolled first: that order becomes the priority.
UPDATE "experiments" AS e SET "priority" = o.n FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "started_at" NULLS LAST, "created_at", "id") AS n FROM "experiments"
) AS o WHERE o."id" = e."id";
