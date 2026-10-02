import { and, eq, inArray, lt } from "drizzle-orm";
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
  /** A subscriber access token (`rdat_`, from the v2 `authenticate` operation): pinned to one app user id of `app`. */
  subscriber?: { appUserId: string; expired: boolean };
}

export const SUBSCRIBER_TOKEN_PREFIX = "rdat_";
/**
 * Subscriber tokens: `rdat_…` from the v2 `authenticate` operation, or the JWT access tokens of Auth sign-in (prd/auth),
 * which the SDK decodes for `rc.app_user_id`. Both are looked up by hash only; a JWT's claims are never trusted.
 */
export const isSubscriberToken = (key: string) => key.startsWith(SUBSCRIBER_TOKEN_PREFIX) || /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);
/** Lifetime of a subscriber access token. RevenueCat calls its tokens short-lived without a number; one hour is ours. */
export const SUBSCRIBER_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Issues a subscriber access token for one app user id of one app. The plaintext is returned once; only its hash is stored. */
export async function issueSubscriberToken(db: DB, app: { id: string; projectId: string }, appUserId: string, now: Date): Promise<{ token: string; expiresAt: Date }> {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const token = `${SUBSCRIBER_TOKEN_PREFIX}${raw}`;
  const expiresAt = new Date(now.getTime() + SUBSCRIBER_TOKEN_TTL_MS);
  await db.insert(schema.subscriberTokens).values({ hash: await sha256Hex(token), projectId: app.projectId, appId: app.id, appUserId, expiresAt, createdAt: now });
  // Expired tokens are only kept long enough to answer "expired" instead of "unknown".
  await db.delete(schema.subscriberTokens).where(lt(schema.subscriberTokens.expiresAt, new Date(now.getTime() - 24 * SUBSCRIBER_TOKEN_TTL_MS)));
  return { token, expiresAt };
}

/** Revokes every subscriber token issued for these app user ids (a deleted customer's ids), so none can recreate it. */
export async function revokeSubscriberTokens(db: DB, projectId: string, appUserIds: string[]) {
  if (appUserIds.length) await db.delete(schema.subscriberTokens).where(and(eq(schema.subscriberTokens.projectId, projectId), inArray(schema.subscriberTokens.appUserId, appUserIds)));
}

/** Resolves an API key: public app keys (appl_, goog_, test_, rcb_ ...), secret keys (sk_...) or subscriber tokens (rdat_...). */
export async function resolveKey(db: DB, key: string, now: Date = new Date()): Promise<KeyAuth | null> {
  if (!key) return null;
  if (isSubscriberToken(key)) {
    const [row] = await db.select({ t: schema.subscriberTokens, app: schema.apps }).from(schema.subscriberTokens)
      .innerJoin(schema.apps, eq(schema.apps.id, schema.subscriberTokens.appId))
      .where(eq(schema.subscriberTokens.hash, await sha256Hex(key))).limit(1);
    if (!row) return null;
    return { kind: "public", projectId: row.t.projectId, app: row.app, subscriber: { appUserId: row.t.appUserId, expired: row.t.expiresAt <= now } };
  }
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
  android: ["play_store"], amazon: ["amazon"], stripe: ["stripe"], web: ["rc_billing", "stripe"], roku: ["roku"], paddle: ["paddle"], galaxy: ["galaxy"],
};

/** For secret keys: the project's app for the X-Platform header. */
export async function appForPlatform(db: DB, projectId: string, platform: string | undefined): Promise<AppRecord | null> {
  const types = platformToType[(platform ?? "").toLowerCase()] ?? [];
  const apps = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
  for (const t of types) { const a = apps.find((x) => x.type === t); if (a) return a; }
  return null;
}

/**
 * Creates a secret key and returns the plaintext once. OAuth keys (routes/oauth.ts) record who granted them and to which
 * client, for Account settings → Security → Active OAuth tokens.
 */
export async function createSecretKey(db: DB, projectId: string, name: string, permissions: string[] = ["*"], grant?: { userId: string; clientId: string }): Promise<{ id: string; key: string }> {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = `sk_${raw}`;
  const id = `key_${raw.slice(0, 10)}`;
  await db.insert(schema.apiKeys).values({ id, projectId, name, hash: await sha256Hex(key), prefix: key.slice(0, 7), permissions, createdByUserId: grant?.userId ?? null, oauthClientId: grant?.clientId ?? null });
  return { id, key };
}

export { and, eq };
