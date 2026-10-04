CREATE TABLE "product_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"project_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_currency" ON "product_prices" USING btree ("product_id","currency");--> statement-breakpoint
INSERT INTO "product_prices" ("id", "product_id", "project_id", "currency", "amount_micros")
SELECT 'prc' || substr(md5("id" || "test_store_price_currency"), 1, 12), "id", "project_id", upper("test_store_price_currency"), "test_store_price_micros"
FROM "products" WHERE "test_store_price_micros" IS NOT NULL AND "test_store_price_currency" IS NOT NULL
ON CONFLICT DO NOTHING;
