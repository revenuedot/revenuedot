import { Codes, RCError } from "../errors.js";
import { depsSecretKey, seal, unseal, type SecretKey, type SecretMap } from "./secrets.js";
import { platformKeyFor, type StripeConnectConfig } from "./stripe-connect-config.js";

/**
 * Amazon and Stripe store secrets live sealed in `apps.secrets` (AES-256-GCM, services/secrets.ts), never in
 * `apps.credentials` and never in an API answer. `apps.secret_hints` holds what the dashboard may show: that a secret
 * is set, and for a Stripe key its mode, kind and last four characters ("rk_test_…abcd").
 * Apple and Google credentials are unchanged (they stay in `apps.credentials`).
 */
export const STORE_SECRET_FIELDS: Record<string, readonly string[]> = {
  amazon: ["shared_secret"],
  // `stripe_connect_account_id`: the account "Connect with Stripe" linked (prd/web-billing/PRD.md §8).
  stripe: ["stripe_secret_key", "stripe_webhook_secret", "stripe_connect_account_id"],
};

export const storeSecretFields = (type: string): readonly string[] => STORE_SECRET_FIELDS[type] ?? [];

/** What may be shown about a secret: a Stripe API key keeps its prefix and last four characters, anything else is "set". */
export function storeSecretHint(field: string, value: string): string {
  if (field === "stripe_secret_key") {
    const prefix = /^(rk|sk)_(live|test)_/.exec(value)?.[0] ?? "";
    return `${prefix}…${value.slice(-4)}`;
  }
  if (field === "stripe_connect_account_id") return `acct_…${value.slice(-4)}`;
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

interface SecretApp { type: string; credentials: Record<string, unknown> | null; secrets?: string | null; secretHints?: Record<string, string> | null }

/** Whether a store secret is saved (sealed, or plain in `credentials` from before sealing). */
export function storeSecretSet(app: SecretApp, field: string): boolean {
  if (app.secretHints && field in app.secretHints) return true;
  const v = (app.credentials ?? {})[field];
  return typeof v === "string" && v.trim() !== "";
}

/** The hint of a store secret, also for one still plain in `credentials`. */
export function storeSecretHintOf(app: SecretApp, field: string): string | null {
  const h = app.secretHints?.[field];
  if (h) return h;
  const v = (app.credentials ?? {})[field];
  return typeof v === "string" && v.trim() ? storeSecretHint(field, v.trim()) : null;
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
    out[f] = typeof v === "string" && v.trim() ? v.trim() : null;
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
    const legacy = credentials[f];
    if (typeof legacy === "string" && legacy.trim()) current[f] = legacy.trim();
    delete credentials[f];
  }
  // Secrets sealed under a key the server no longer has cannot be kept; the ones in this update replace them.
  Object.assign(current, await unseal(app.secrets, key).catch(() => ({} as SecretMap)));
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
