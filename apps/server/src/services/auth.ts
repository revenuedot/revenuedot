import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord } from "../context.js";

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface KeyAuth {
  kind: "public" | "secret";
  projectId: string;
  /** The app for public keys. Secret keys pick one with X-Platform when an endpoint needs it. */
  app: AppRecord | null;
  keyId?: string;
  permissions?: string[];
}

/** Resolves an API key: public app keys (appl_, goog_, test_, rcb_ ...) or secret keys (sk_...). */
export async function resolveKey(db: DB, key: string): Promise<KeyAuth | null> {
  if (!key) return null;
  if (key.startsWith("sk_")) {
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.hash, await sha256Hex(key))).limit(1);
    if (!row) return null;
    return { kind: "secret", projectId: row.projectId, app: null, keyId: row.id, permissions: row.permissions };
  }
  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.publicKey, key)).limit(1);
  return app ? { kind: "public", projectId: app.projectId, app } : null;
}

const platformToType: Record<string, string[]> = {
  ios: ["app_store", "mac_app_store"], macos: ["mac_app_store", "app_store"], uikitformac: ["app_store"], watchos: ["app_store"], tvos: ["app_store"], visionos: ["app_store"],
  android: ["play_store"], amazon: ["amazon"], stripe: ["stripe"], web: ["rc_billing", "stripe"], roku: ["roku"], paddle: ["paddle"],
};

/** For secret keys: the project's app for the X-Platform header. */
export async function appForPlatform(db: DB, projectId: string, platform: string | undefined): Promise<AppRecord | null> {
  const types = platformToType[(platform ?? "").toLowerCase()] ?? [];
  const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
  for (const t of types) { const a = apps.find((x) => x.type === t); if (a) return a; }
  return null;
}

/** Creates a secret key and returns the plaintext once. */
export async function createSecretKey(db: DB, projectId: string, name: string, permissions: string[] = ["*"]): Promise<{ id: string; key: string }> {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = `sk_${raw}`;
  const id = `key_${raw.slice(0, 10)}`;
  await db.insert(schema.apiKeys).values({ id, projectId, name, hash: await sha256Hex(key), prefix: key.slice(0, 7), permissions });
  return { id, key };
}

export { and, eq };
