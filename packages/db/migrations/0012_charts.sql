CREATE TABLE "customer_activity" (
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"day" text NOT NULL,
	CONSTRAINT "customer_activity_customer_id_day_pk" PRIMARY KEY("customer_id","day")
);
--> statement-breakpoint
CREATE TABLE "sdk_events" (
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"app_id" text,
	"customer_id" text,
	"app_user_id" text,
	"type" text NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sdk_events_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_survey_reason" text;--> statement-breakpoint
ALTER TABLE "customer_activity" ADD CONSTRAINT "customer_activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_activity" ADD CONSTRAINT "customer_activity_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_events" ADD CONSTRAINT "sdk_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sdk_events" ADD CONSTRAINT "sdk_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_activity_project_day" ON "customer_activity" USING btree ("project_id","day");--> statement-breakpoint
CREATE INDEX "sdk_events_project_time" ON "sdk_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "sdk_events_customer" ON "sdk_events" USING btree ("customer_id");--> statement-breakpoint
INSERT INTO "customer_activity" ("project_id", "customer_id", "day")
SELECT "project_id", "id", to_char("first_seen" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM "customers"
UNION
SELECT "project_id", "id", to_char("last_seen" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM "customers"
ON CONFLICT DO NOTHING;
