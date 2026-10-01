CREATE TABLE "subscriber_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"app_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "offer_type" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "eligible_win_back_offer_ids" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "win_back_offers_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "offer_type" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "subscriber_tokens" ADD CONSTRAINT "subscriber_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_tokens" ADD CONSTRAINT "subscriber_tokens_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriber_tokens_expiry" ON "subscriber_tokens" USING btree ("expires_at");