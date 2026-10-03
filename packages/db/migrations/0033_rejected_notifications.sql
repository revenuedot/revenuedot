ALTER TABLE "store_notifications" ADD COLUMN "rejected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "store_notifications" SET "rejected" = true WHERE "error" LIKE 'rejected:%' OR ("store" IN ('app_store', 'mac_app_store') AND ("error" LIKE 'The signed payload is not valid:%' OR "error" IN ('The body is not JSON.', 'signedPayload is missing.')));
