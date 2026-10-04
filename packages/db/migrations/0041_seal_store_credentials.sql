-- Every store secret (App Store .p8 keys, the Play service account, shared secrets) is sealed in apps.secrets.
-- Existing plain values are moved and sealed in place by the server's backfill (apps/server/src/services/seal-backfill.ts),
-- which needs the encryption key and so runs in the server's tick, not in SQL.
COMMENT ON COLUMN "apps"."credentials" IS 'Store settings that are not secret (ids, bundle ids, options). Secrets live sealed in apps.secrets.';--> statement-breakpoint
COMMENT ON COLUMN "apps"."secrets" IS 'Every store secret, sealed with AES-256-GCM (v1:<key id>:<iv>:<ciphertext>), or plain:<base64> on a server without a key.';
