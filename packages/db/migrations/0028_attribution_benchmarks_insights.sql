CREATE TABLE "ai_insights" (
	"project_id" text NOT NULL,
	"week" text NOT NULL,
	"status" text NOT NULL,
	"insights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb,
	"provider" text,
	"model" text,
	"error" text,
	"generated_by" text,
	"generated_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_insights_project_id_week_pk" PRIMARY KEY("project_id","week")
);
--> statement-breakpoint
CREATE TABLE "benchmark_aggregates" (
	"category" text NOT NULL,
	"platform" text NOT NULL,
	"country" text NOT NULL,
	"metric" text NOT NULL,
	"projects" integer NOT NULL,
	"p10" double precision,
	"p25" double precision NOT NULL,
	"p50" double precision NOT NULL,
	"p75" double precision NOT NULL,
	"p90" double precision,
	"computed_on" text NOT NULL,
	CONSTRAINT "benchmark_aggregates_category_platform_country_metric_pk" PRIMARY KEY("category","platform","country","metric")
);
--> statement-breakpoint
CREATE TABLE "benchmark_project_values" (
	"project_id" text NOT NULL,
	"platform" text NOT NULL,
	"country" text NOT NULL,
	"category" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"computed_on" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_project_values_project_id_platform_country_pk" PRIMARY KEY("project_id","platform","country")
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"day" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aggregated_at" timestamp with time zone,
	"projects" integer DEFAULT 0 NOT NULL,
	"groups" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_attribution" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"media_source" text,
	"campaign" text,
	"campaign_id" text,
	"ad_group" text,
	"ad_group_id" text,
	"ad" text,
	"ad_id" text,
	"keyword" text,
	"keyword_id" text,
	"creative" text,
	"claim_type" text,
	"conversion_type" text,
	"attribution_country" text,
	"partner_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "benchmarks_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "benchmarks_category" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "benchmarks_shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "insights_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_project_values" ADD CONSTRAINT "benchmark_project_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_attribution" ADD CONSTRAINT "customer_attribution_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_attribution" ADD CONSTRAINT "customer_attribution_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_attribution_media" ON "customer_attribution" USING btree ("project_id","media_source");--> statement-breakpoint
CREATE INDEX "customer_attribution_campaign" ON "customer_attribution" USING btree ("project_id","campaign");--> statement-breakpoint
-- Backfill: every customer with reserved attribution attributes gets its row, read the way attributionFromAttributes
-- (packages/core/src/attribution.ts) reads them, Apple Search Ads names included when the project has loaded them.
WITH attrs AS (
	SELECT c.id AS customer_id, c.project_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$mediaSource') AS media_source,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$campaign') AS campaign,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$adGroup') AS ad_group,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$ad') AS ad,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$keyword') AS keyword,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$creative') AS creative,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsCampaignId') AS campaign_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsAdGroupId') AS ad_group_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsKeywordId') AS keyword_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsAdId') AS ad_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsCountryOrRegion') AS country,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$claimType') AS claim_type,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$conversionType') AS conversion_type,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appleAdsOrgId') AS org_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$appsflyerId') AS appsflyer_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$adjustId') AS adjust_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$branchId') AS branch_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$kochavaDeviceId') AS kochava_device_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$singularDeviceId') AS singular_device_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$tenjinId') AS tenjin_id,
		max(nullif(left(btrim(a.value), 200), '')) FILTER (WHERE a.key = '$airbridgeDeviceId') AS airbridge_device_id
	FROM "customers" c JOIN "customer_attributes" a ON a.customer_id = c.id
	WHERE a.key IN ('$mediaSource', '$campaign', '$adGroup', '$ad', '$keyword', '$creative', '$appleAdsCampaignId', '$appleAdsAdGroupId',
		'$appleAdsKeywordId', '$appleAdsAdId', '$appleAdsOrgId', '$appleAdsCountryOrRegion', '$claimType', '$conversionType', '$appsflyerId', '$adjustId',
		'$branchId', '$kochavaDeviceId', '$singularDeviceId', '$tenjinId', '$airbridgeDeviceId')
	GROUP BY c.id, c.project_id
), names AS (
	SELECT DISTINCT ON (project_id) project_id, settings->'names'->'campaigns' AS campaigns, settings->'names'->'ad_groups' AS ad_groups
	FROM "integrations" WHERE kind = 'apple_search_ads' ORDER BY project_id, created_at
), resolved AS (
	SELECT x.*, nullif(left(btrim(n.campaigns->>x.campaign_id), 200), '') AS campaign_name, nullif(left(btrim(n.ad_groups->>x.ad_group_id), 200), '') AS ad_group_name
	FROM attrs x LEFT JOIN names n ON n.project_id = x.project_id
)
INSERT INTO "customer_attribution" ("customer_id", "project_id", "media_source", "campaign", "campaign_id", "ad_group", "ad_group_id", "ad", "ad_id",
	"keyword", "keyword_id", "creative", "claim_type", "conversion_type", "attribution_country", "partner_ids")
SELECT r.customer_id, r.project_id,
	coalesce(r.media_source, CASE WHEN coalesce(r.campaign_id, r.ad_group_id, r.keyword_id, r.ad_id) IS NOT NULL THEN 'Apple Search Ads' END),
	CASE WHEN r.campaign_name IS NOT NULL AND (r.campaign IS NULL OR r.campaign = r.campaign_id) THEN r.campaign_name ELSE coalesce(r.campaign, r.campaign_id) END,
	r.campaign_id,
	CASE WHEN r.ad_group_name IS NOT NULL AND (r.ad_group IS NULL OR r.ad_group = r.ad_group_id) THEN r.ad_group_name ELSE coalesce(r.ad_group, r.ad_group_id) END,
	r.ad_group_id, coalesce(r.ad, r.ad_id), r.ad_id, coalesce(r.keyword, r.keyword_id), r.keyword_id, r.creative, r.claim_type, r.conversion_type, upper(r.country),
	jsonb_strip_nulls(jsonb_build_object('appsflyer_id', r.appsflyer_id, 'adjust_id', r.adjust_id, 'branch_id', r.branch_id, 'kochava_device_id', r.kochava_device_id,
		'singular_device_id', r.singular_device_id, 'tenjin_id', r.tenjin_id, 'airbridge_device_id', r.airbridge_device_id))
FROM resolved r
WHERE coalesce(r.media_source, r.campaign, r.ad_group, r.ad, r.keyword, r.creative, r.campaign_id, r.ad_group_id, r.keyword_id, r.ad_id, r.country, r.claim_type,
	r.conversion_type, r.appsflyer_id, r.adjust_id, r.branch_id, r.kochava_device_id, r.singular_device_id, r.tenjin_id, r.airbridge_device_id) IS NOT NULL
ON CONFLICT ("customer_id") DO NOTHING;
