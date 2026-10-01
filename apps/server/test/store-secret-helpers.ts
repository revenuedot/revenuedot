/** Amazon and Stripe apps in tests: secrets sealed the way the API stores them (services/store-secrets.ts). */
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { secretKeyFrom } from "../src/services/secrets.js";
import { sealStoreSecrets, takeStoreSecrets } from "../src/services/store-secrets.js";

/** The sealing key the test servers run with (base64 of 32 bytes). */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** Splits all fields into plain credentials and sealed secrets, as POST /v2/.../apps would store them. */
export async function sealedColumns(type: string, all: Record<string, unknown>) {
  const rest = { ...all };
  const update = takeStoreSecrets(type, rest);
  return sealStoreSecrets({ type, credentials: rest, secrets: null }, update, await secretKeyFrom(TEST_ENCRYPTION_KEY));
}

/** Replaces an app's credentials and sealed secrets. */
export async function setAppCredentials(db: DB, appId: string, type: string, all: Record<string, unknown>) {
  await db.update(schema.apps).set(await sealedColumns(type, all)).where(eq(schema.apps.id, appId));
}
