CREATE TABLE "customer_counts" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"result" jsonb,
	"counted_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"as_of" timestamp with time zone,
	"cursor" text,
	"partial" jsonb,
	"lease_until" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "customers_project";--> statement-breakpoint
ALTER TABLE "customer_counts" ADD CONSTRAINT "customer_counts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_counts_due" ON "customer_counts" USING btree ("state","requested_at");--> statement-breakpoint
CREATE INDEX "customer_counts_project" ON "customer_counts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "customers_project_id" ON "customers" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "customers_project" ON "customers" USING btree ("project_id","last_seen","id");