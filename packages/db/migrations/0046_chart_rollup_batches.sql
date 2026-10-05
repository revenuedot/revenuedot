ALTER TABLE "chart_rollup_state" ADD COLUMN "build_cursor" text;--> statement-breakpoint
ALTER TABLE "chart_rollup_state" ADD COLUMN "build_partial" jsonb;--> statement-breakpoint
ALTER TABLE "chart_rollup_state" DROP COLUMN "build_from_ms";
