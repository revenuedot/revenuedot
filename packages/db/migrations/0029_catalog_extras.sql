CREATE TABLE "product_edit_rows" (
	"edit_id" text NOT NULL,
	"idx" integer NOT NULL,
	"kind" text NOT NULL,
	"line" integer,
	"store_identifier" text NOT NULL,
	"territory" text NOT NULL,
	"currency" text NOT NULL,
	"old_micros" bigint,
	"new_micros" bigint NOT NULL,
	"product" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "product_edit_rows_edit_id_idx_pk" PRIMARY KEY("edit_id","idx")
);
--> statement-breakpoint
CREATE TABLE "product_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"store" text NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"csv" text NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"locked_until" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_listing_syncs" (
	"app_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_listings" (
	"app_id" text NOT NULL,
	"project_id" text NOT NULL,
	"store_identifier" text NOT NULL,
	"type" text NOT NULL,
	"display_name" text,
	"duration" text,
	"store_state" text,
	"group_id" text,
	"group_name" text,
	"store_ref" text,
	"base_territory" text,
	"base_currency" text,
	"base_price_micros" bigint,
	"prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"editable" boolean DEFAULT true NOT NULL,
	"note" text,
	"refreshed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "store_listings_app_id_store_identifier_pk" PRIMARY KEY("app_id","store_identifier")
);
--> statement-breakpoint
ALTER TABLE "product_edit_rows" ADD CONSTRAINT "product_edit_rows_edit_id_product_edits_id_fk" FOREIGN KEY ("edit_id") REFERENCES "public"."product_edits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_edits" ADD CONSTRAINT "product_edits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_edits" ADD CONSTRAINT "product_edits_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listing_syncs" ADD CONSTRAINT "store_listing_syncs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listing_syncs" ADD CONSTRAINT "store_listing_syncs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_edits_project" ON "product_edits" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "store_listing_syncs_project" ON "store_listing_syncs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "store_listings_project" ON "store_listings" USING btree ("project_id");