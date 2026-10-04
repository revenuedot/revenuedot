import { Codes, RCError } from "../errors.js";
import { V2Error } from "../routes/v2/common.js";
import { depsSecretKey, seal, unseal, type SecretKey, type SecretMap } from "./secrets.js";
import { platformKeyFor, type StripeConnectConfig } from "./stripe-connect-config.js";

/**
 * Every store's secrets live sealed in `apps.secrets` (AES-256-GCM, services/secrets.ts), never in `apps.credentials` and
 * never in an API answer. `apps.secret_hints` holds what the dashboard may show: that a secret is set, for a Stripe key its
 * mode, kind and last four characters ("rk_test_…abcd"), for a Paddle key its environment and last four
 * ("pdl_sdbx_apikey_…abcd"), for a Play service account its client_email.
 * Identifiers that are not secret (key ids, issuer ids, bundle ids, Pub/Sub audience) stay in `apps.credentials`.
 * Test Store and RevenueCat Billing apps have no store secrets.
 */
/** Identifiers that are only meaningful with their sealed key (dropped in memory when the key cannot be opened). */
const APPLE_KEY_IDS = ["subscription_key_id", "subscription_key_issuer", "key_id", "issuer_id", "app_store_connect_api_key_id", "app_store_connect_api_key_issuer"];
const KEY_IDS: Record<string, readonly string[]> = { app_store: APPLE_KEY_IDS, mac_app_store: APPLE_KEY_IDS, galaxy: ["galaxy_service_account_id"] };
const APPLE_SECRETS = ["subscription_private_key", "private_key", "app_store_connect_api_key", "shared_secret"] as const;
export const STORE_SECRET_FIELDS: Record<string, readonly string[]> = {
  // In-App Purchase key (.p8, under RevenueCat's name or the short one), App Store Connect API key (.p8), app-specific shared secret.
  app_store: APPLE_SECRETS,
  mac_app_store: APPLE_SECRETS,
  // The service account JSON, under RevenueCat's name or `service_account` (text or an object).
  play_store: ["play_service_account_credentials_json", "service_account"],
  amazon: ["shared_secret"],
  // `stripe_connect_account_id`: the account "Connect with Stripe" linked (prd/web-billing/PRD.md §8).
  stripe: ["stripe_secret_key", "stripe_webhook_secret", "stripe_connect_account_id"],
  paddle: ["paddle_api_key", "paddle_webhook_secret"],
  roku: ["roku_api_key"],
  galaxy: ["galaxy_service_account_private_key"],
};

export const storeSecretFields = (type: string): readonly string[] => STORE_SECRET_FIELDS[type] ?? [];

/** What may be shown about a secret: a Stripe API key keeps its prefix and last four characters, anything else is "set". */
export function storeSecretHint(field: string, value: string): string {
  if (field === "stripe_secret_key") {
    const prefix = /^(rk|sk)_(live|test)_/.exec(value)?.[0] ?? "";
    return `${prefix}…${value.slice(-4)}`;
  }
  if (field === "stripe_connect_account_id") return `acct_…${value.slice(-4)}`;
  if (field === "play_service_account_credentials_json" || field === "service_account") {
    try { const j = JSON.parse(value) as { client_email?: unknown }; if (typeof j.client_email === "string" && j.client_email.length <= 320) return j.client_email; } catch { /* not JSON */ }
    return "set";
  }
  if (field === "paddle_api_key") {
    const prefix = /^pdl_(live|sdbx)_apikey_/.exec(value)?.[0] ?? "";
    return `${prefix}…${value.slice(-4)}`;
  }
  return "set";
}

/** The dashboard's view of a Stripe key from its hint: mode, kind and last four, never the key. */
export function stripeKeyHintOf(hint: string | null | undefined) {
  if (!hint) return { configured: false, mode: null, kind: null, last4: null } as const;
  return {
    configured: true,
    mode: /_test_/.test(hint) ? "test" as const : "live" as const,
    kind: hint.startsWith("rk_") ? "restricted" as const : hint.startsWith("sk_") ? "secret" as const : "other" as const,
    last4: hint.slice(-4),
  };
}

/** The dashboard's view of a Paddle key from its hint: environment (null for keys from before 2025-05-06) and last four. */
export function paddleKeyHintOf(hint: string | null | undefined) {
  if (!hint) return { configured: false, environment: null, last4: null } as const;
  return { configured: true, environment: hint.startsWith("pdl_sdbx_") ? "sandbox" as const : hint.startsWith("pdl_live_") ? "live" as const : null, last4: hint.slice(-4) };
}

interface SecretApp { type: string; credentials: Record<string, unknown> | null; secrets?: string | null; secretHints?: Record<string, string> | null }

/** A secret value as text: a trimmed string, an object (a service account saved as JSON) as its JSON; anything else is not a secret. */
export function secretText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
  return null;
}

/** Whether a store secret is saved (sealed, or plain in `credentials` from before sealing). */
export function storeSecretSet(app: Pick<SecretApp, "credentials" | "secretHints">, field: string): boolean {
  if (app.secretHints && field in app.secretHints) return true;
  return secretText((app.credentials ?? {})[field]) !== null;
}

/** The hint of a store secret, also for one still plain in `credentials`. */
export function storeSecretHintOf(app: Pick<SecretApp, "credentials" | "secretHints">, field: string): string | null {
  const h = app.secretHints?.[field];
  if (h) return h;
  const v = secretText((app.credentials ?? {})[field]);
  return v ? storeSecretHint(field, v) : null;
}

/**
 * Splits a create or update body: the store's secret fields come out (a string sets, null or "" clears, absent keeps),
 * everything else stays in `rest`.
 */
export function takeStoreSecrets(type: string, rest: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of storeSecretFields(type)) {
    if (f === "stripe_connect_account_id") { delete rest[f]; continue; }
    if (!(f in rest)) continue;
    const v = rest[f];
    delete rest[f];
    out[f] = secretText(v);
  }
  return out;
}

/**
 * Applies a secrets update: returns the sealed text, the hints, and the credentials without any plain copy of a store
 * secret (apps saved before sealing are moved over on their next save).
 */
export async function sealStoreSecrets(app: SecretApp, update: Record<string, string | null>, key: SecretKey | null) {
  const fields = storeSecretFields(app.type);
  const current: SecretMap = {};
  const credentials: Record<string, unknown> = { ...(app.credentials ?? {}) };
  for (const f of fields) {
    const legacy = secretText(credentials[f]);
    if (legacy) current[f] = legacy;
    delete credentials[f];
  }
  // Secrets sealed under a key the server cannot open are never dropped silently: the save is refused unless it enters
  // (or clears) every one of them again.
  let opened: SecretMap;
  try { opened = await unseal(app.secrets, key); } catch {
    const lost = Object.keys(app.secretHints ?? {}).filter((f) => fields.includes(f) && !(f in update));
    if (lost.length) {
      throw new V2Error(422, "store_error", `The saved ${lost.join(", ")} could not be opened (the server's encryption key changed). Enter ${lost.length > 1 ? "them" : "it"} again in the same save.`, lost[0]);
    }
    opened = {};
  }
  Object.assign(current, opened);
  for (const [k, v] of Object.entries(update)) {
    if (v === null) delete current[k];
    else current[k] = v;
  }
  const hints = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, storeSecretHint(k, v)]));
  return { secrets: await seal(current, key), secretHints: hints, credentials };
}

/** Whether a Stripe app is linked through "Connect with Stripe" (its account id is sealed). */
export const stripeConnected = (app: SecretApp) => storeSecretSet(app, "stripe_connect_account_id");

/** A Stripe app's mode: a connection's mode, else the restricted key's (from its hint); null without either. */
export function stripeModeOf(app: SecretApp): "live" | "test" | null {
  if (stripeConnected(app)) return app.credentials?.stripe_connect_mode === "test" ? "test" : "live";
  return stripeKeyHintOf(storeSecretHintOf(app, "stripe_secret_key")).mode;
}

/** Whether a Stripe app can reach Stripe: a restricted key, or a connection. */
export const stripeReachable = (app: SecretApp) => storeSecretSet(app, "stripe_secret_key") || stripeConnected(app);

/**
 * The app with its sealed store secrets opened into `credentials`, in memory only, for the store clients. Apps of other
 * stores come back unchanged. A key that cannot open them is a server problem: RCError 500 (never a 4xx on receipts).
 * A Stripe app linked with "Connect with Stripe" gets the platform's secret key of the connection's mode as its key and
 * the connected account as `stripe_account_id` (sent as `Stripe-Account`), so every Stripe path acts on the developer's
 * account unchanged. Without the platform keys (removed from the environment) it has no key at all.
 */
export async function withStoreSecrets<T extends SecretApp>(deps: { encryptionKey?: string; signingKey?: string; stripeConnect?: StripeConnectConfig }, app: T): Promise<T> {
  if (!storeSecretFields(app.type).length || !app.secrets) return app;
  let opened: SecretMap;
  try {
    opened = await unseal(app.secrets, await depsSecretKey(deps));
  } catch (e) {
    throw new RCError(500, Codes.STORE_PROBLEM, `The app's store credentials could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { stripe_connect_account_id: account, ...rest } = opened;
  if (app.type === "stripe" && account) {
    const mode = app.credentials?.stripe_connect_mode === "test" ? "test" : "live";
    const key = platformKeyFor(deps.stripeConnect, mode);
    const credentials: Record<string, unknown> = { ...(app.credentials ?? {}), ...rest, stripe_account_id: account, stripe_connected: true };
    delete credentials.stripe_secret_key;
    if (key) credentials.stripe_secret_key = key;
    return { ...app, credentials };
  }
  return { ...app, credentials: { ...(app.credentials ?? {}), ...rest } };
}

/**
 * Guards the readers of a store secret (the Apple keys, the Play service account): when none of `fields` holds a value but
 * one is sealed, the app was loaded without `withStoreSecrets`. That is a bug in RevenueDot, never the developer's setup,
 * so it fails loudly (500) instead of reading as "no key configured".
 */
export function assertStoreSecretsOpened(app: Pick<SecretApp, "credentials" | "secretHints">, fields: readonly string[]): void {
  const cr = app.credentials ?? {};
  if (fields.some((f) => secretText(cr[f]) !== null)) return;
  if (fields.some((f) => !!app.secretHints && f in app.secretHints)) {
    throw new RCError(500, Codes.STORE_PROBLEM, "The app's store credentials are sealed and were not opened for this request.");
  }
}

/** Whether the App Store In-App Purchase key is saved: the .p8 (sealed) plus its key id and issuer id. */
export function appleKeySet(app: Pick<SecretApp, "credentials" | "secretHints">): boolean {
  const cr = app.credentials ?? {};
  const has = (k: string) => typeof cr[k] === "string" && (cr[k] as string).trim() !== "";
  return (storeSecretSet(app, "subscription_private_key") || storeSecretSet(app, "private_key"))
    && (has("subscription_key_id") || has("key_id")) && (has("subscription_key_issuer") || has("issuer_id"));
}

/** Whether the App Store Connect API key is saved: the .p8 (sealed) plus its key id and issuer id. */
export function connectKeySet(app: Pick<SecretApp, "credentials" | "secretHints">): boolean {
  const cr = app.credentials ?? {};
  const has = (k: string) => typeof cr[k] === "string" && (cr[k] as string).trim() !== "";
  return storeSecretSet(app, "app_store_connect_api_key") && has("app_store_connect_api_key_id") && has("app_store_connect_api_key_issuer");
}

/** Whether a Play service account is saved, under either field name. */
export const serviceAccountSet = (app: Pick<SecretApp, "credentials" | "secretHints">) =>
  storeSecretSet(app, "play_service_account_credentials_json") || storeSecretSet(app, "service_account");

/**
 * For store notifications, which must keep flowing: the app opened, or, when its secrets cannot be opened (the key
 * changed), the app as if no secret were saved, so only the steps that need a key are skipped. Logs the app id, never a value.
 */
export async function withStoreSecretsOrNone<T extends SecretApp>(deps: { encryptionKey?: string; signingKey?: string; stripeConnect?: StripeConnectConfig }, app: T): Promise<T> {
  try { return await withStoreSecrets(deps, app); } catch (e) {
    console.warn(`Store secrets of app ${(app as { id?: string }).id ?? "?"} could not be opened: ${e instanceof RCError ? e.message : "unknown error"}`);
    // In memory only: the ids that belong to the unopened keys go too, so the app reads as "no key", not "incomplete key".
    const credentials = { ...(app.credentials ?? {}) };
    for (const f of KEY_IDS[app.type] ?? []) delete credentials[f];
    return { ...app, credentials, secretHints: {} };
  }
}
