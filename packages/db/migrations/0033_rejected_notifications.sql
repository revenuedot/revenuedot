ALTER TABLE "store_notifications" ADD COLUMN "rejected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "store_notifications" n SET "rejected" = true FROM "apps" a
WHERE n.app_id = a.id AND n.rejected = false AND n.error IS NOT NULL AND (n.error LIKE 'rejected:%'
  OR (n.store IN ('app_store', 'mac_app_store') AND (n.error LIKE 'The signed payload is not valid:%' OR n.error IN ('The body is not JSON.', 'signedPayload is missing.', 'The signed payload is not an App Store notification.')
    OR n.error LIKE 'The notification is for bundle id %' OR n.error LIKE 'The notification is for Apple app id %'))
  OR (n.store = 'play_store' AND (coalesce(a.credentials->>'pubsub_audience', '') = '' OR coalesce(a.credentials->>'pubsub_service_account', '') = '')
    AND (n.error LIKE 'invalid purchase token:%' OR n.error LIKE 'package % does not match the app''s %' OR n.error = 'message.data is not a base64 JSON developer notification'))
  OR (n.store = 'galaxy' AND coalesce(a.credentials->>'galaxy_iap_public_key', '') = '' AND n.error LIKE 'Galaxy Store:%'));
