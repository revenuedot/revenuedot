import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { Codes, RCError } from "../errors.js";
import { AppStoreServerApi, AppleApiClientError, appleCredentials } from "../stores/apple/api.js";
import { GoogleApiError, hasServiceAccount, serviceAccountOf } from "../stores/google/api.js";
import { googleClientFor } from "../stores/google/index.js";
import { AmazonApiError, sharedSecretOf } from "../stores/amazon/api.js";
import { amazonClientFor } from "../stores/amazon/index.js";
import { isTestKey, StripeApiError, stripeKeyOf } from "../stores/stripe/api.js";
import { stripeClientFor } from "../stores/stripe/index.js";
import type { AppRow, StoreAdapter } from "../stores/types.js";
import { withStoreSecrets } from "./store-secrets.js";

/**
 * Whether Apple and Google accept an app's store credentials (`apps.credentials_status`), for the "store credentials
 * failing" alert (prd/account-email/PRD.md). Failures are recorded wherever a store call answers 401/403 (receipt checks,
 * the voided-purchases scan, the dashboard check); the tick re-checks failing apps every hour and every app once a day.
 */

export type CheckStatus = "valid" | "invalid" | "unreachable";
export interface CredentialCheck { status: CheckStatus; message: string; extra: Record<string, unknown> }

type CheckDeps = Pick<Deps, "fetch" | "now" | "stores"> & Partial<Pick<Deps, "encryptionKey" | "signingKey" | "stripeConnect">>;

const STORE_TYPES = ["app_store", "mac_app_store", "play_store", "amazon", "stripe"];

/** Asks Apple or Google whether the credentials work, with one harmless request. */
export async function checkStoreCredentials(deps: CheckDeps, app: AppRow): Promise<CredentialCheck> {
  const out = (status: CheckStatus, message: string, extra: Record<string, unknown> = {}) => ({ status, message, extra });
  if (app.type === "app_store" || app.type === "mac_app_store") {
    let creds;
    try { creds = appleCredentials(app); } catch (e) {
      return out("invalid", e instanceof RCError ? "The in-app purchase key is incomplete. Add the .p8 file, the key ID, the issuer ID and the bundle ID." : String(e));
    }
    if (!creds) return out("invalid", "No in-app purchase key yet. Add the .p8 file, the key ID and the issuer ID.");
    const api = new AppStoreServerApi(creds, deps.fetch ?? ((u, i) => fetch(u, i)), deps.now);
    // Any transaction id works: Apple answers 404 or 400 when the key is accepted and 401 when it is not. An app that has
    // never shipped has no production presence, so Apple answers 401 from production for a perfectly good key. The
    // sandbox knows the app from the first build on, so a 401 from production is only final if the sandbox says 401 too.
    const probe = async (env: "production" | "sandbox") => {
      try { await api.get(env, "/inApps/v1/transactions/0"); return true; } catch (e) {
        if (e instanceof AppleApiClientError) return true;
        throw e;
      }
    };
    try {
      try { await probe("production"); } catch (e) {
        if (e instanceof RCError && e.status === 500 && !/not a valid \.p8/.test(e.message)) await probe("sandbox");
        else throw e;
      }
      return out("valid", "Apple accepted the in-app purchase key.", { key_id: creds.keyId });
    } catch (e) {
      if (e instanceof AppleApiClientError) return out("valid", "Apple accepted the in-app purchase key.", { key_id: creds.keyId });
      if (e instanceof RCError && e.status >= 500 && e.status !== 503) {
        return out("invalid", /not a valid \.p8/.test(e.message)
          ? "The private key is not a valid .p8 file. Upload the file App Store Connect gave you, unchanged."
          : "Apple rejected the key. Check that the key ID and issuer ID belong to this .p8 file and that the key is an In-App Purchase key.");
      }
      return out("unreachable", "Apple could not be reached. Try again in a minute.");
    }
  }
  if (app.type === "play_store") {
    if (!app.bundleId) return out("invalid", "Add the package name first (for example com.example.app).");
    const { client } = googleClientFor(deps.stores, deps.fetch);
    let email: string | null = null;
    try {
      const sa = serviceAccountOf(app);
      email = sa.client_email;
      await client.accessToken(sa);
      // A made-up token: Google answers "not found" when the account can see the app, 401/403 when it cannot.
      await client.call(app, "GET", `/purchases/subscriptionsv2/tokens/${encodeURIComponent("revenuedot-credentials-check")}`);
      return out("valid", "Google accepted the service account and it can read this app's purchases.", { client_email: email });
    } catch (e) {
      if (e instanceof GoogleApiError) {
        if (e.kind === "invalid_token") return out("valid", "Google accepted the service account and it can read this app's purchases.", { client_email: email });
        if (e.kind === "transient") return out("unreachable", "Google could not be reached. Try again in a minute.", { client_email: email });
        const msg = /applicationNotFound|No Play app/.test(e.message)
          ? `Google Play has no app with the package name ${app.bundleId}. Check the package name.`
          : e.status === 403
            ? "The service account works but cannot see this app yet. In Play Console, invite it under Users and permissions with the financial data and order management permissions. New permissions can take up to 36 hours to apply."
            : e.message.includes("JSON") || e.message.includes("client_email") || e.message.includes("PKCS")
              ? "This is not a service account key file. Download a JSON key for the service account in Google Cloud and upload it here."
              : `Google rejected the service account: ${e.message}`;
        return out("invalid", msg, { client_email: email });
      }
      return out("unreachable", "Google could not be reached. Try again in a minute.", { client_email: email });
    }
  }
  if (app.type === "amazon") {
    const secret = sharedSecretOf(app);
    if (!secret) return out("invalid", "No shared key yet. Copy it from the Amazon Developer Console → Settings → Identity → Shared Key.");
    const { client } = amazonClientFor(deps.stores, deps.fetch);
    // A made-up user and receipt: RVS answers 496 for a wrong shared key, and 400, 410 or 497 when the key is right.
    try {
      await client.verifyIn("production", secret, "revenuedot-credentials-check", "revenuedot-credentials-check");
      return out("valid", "Amazon accepted the shared key.");
    } catch (e) {
      if (e instanceof AmazonApiError) {
        if (e.kind === "invalid_receipt" || e.kind === "cancelled") return out("valid", "Amazon accepted the shared key.");
        if (e.kind === "credentials") return out("invalid", "Amazon rejected the shared key. Copy the Shared Key from Developer Console → Settings → Identity again, without spaces.");
      }
      return out("unreachable", "Amazon could not be reached. Try again in a minute.");
    }
  }
  if (app.type === "stripe") {
    const key = stripeKeyOf(app);
    if (!key && app.credentials?.stripe_connected === true) return out("invalid", "This app is connected with Stripe Connect, but this server has no Stripe Connect platform key for the connection's mode.");
    if (!key) return out("invalid", "No Stripe API key yet. Connect with Stripe, or create a restricted key in the Stripe Dashboard → Developers → API keys.");
    if (/^pk_/.test(key)) return out("invalid", "This is a publishable key (pk_…). Use a restricted key (rk_…) or a secret key (sk_…).");
    const mode = isTestKey(key) ? "test" : "live";
    const { client } = stripeClientFor(deps.stores, deps.fetch);
    const connected = app.credentials?.stripe_connected === true;
    try {
      // Read access to both objects RevenueDot reads first; one item each.
      await client.get(app, "/v1/subscriptions", { limit: "1", status: "all" });
      await client.get(app, "/v1/checkout/sessions", { limit: "1" });
      return out("valid", connected ? `The connected Stripe account answered in ${mode} mode.` : `Stripe accepted the ${mode} mode key.`, { mode });
    } catch (e) {
      if (e instanceof StripeApiError && connected) {
        if (e.kind === "credentials") return out("invalid", `Stripe refused access to the connected account. Connect with Stripe again. Stripe said: ${e.message}`, { mode });
        if (e.kind === "transient") return out("unreachable", "Stripe could not be reached. Try again in a minute.", { mode });
        return out("invalid", `Stripe refused the check: ${e.message}`, { mode });
      }
      if (e instanceof StripeApiError) {
        if (e.kind === "credentials" && e.status === 403) return out("invalid", `The key works but cannot read everything RevenueDot needs. Give the restricted key read access to Subscriptions, Invoices, Checkout Sessions, Charges, Customers, Products and Prices. Stripe said: ${e.message}`, { mode });
        if (e.kind === "credentials") return out("invalid", "Stripe rejected the key. Copy it again from the Stripe Dashboard → Developers → API keys.", { mode });
        if (e.kind === "transient") return out("unreachable", "Stripe could not be reached. Try again in a minute.", { mode });
        return out("invalid", `Stripe refused the check: ${e.message}`, { mode });
      }
      if (e instanceof RCError) return out("invalid", e.message);
      return out("unreachable", "Stripe could not be reached. Try again in a minute.", { mode });
    }
  }
  return out("invalid", `${app.type} apps have no store credentials to check.`);
}

/** Stores a check's outcome; "unreachable" says nothing about the credentials, so only the check time moves. */
export async function recordCredentialCheck(db: DB, appId: string, r: Pick<CredentialCheck, "status" | "message">, now: Date) {
  if (r.status === "unreachable") { await db.update(schema.apps).set({ credentialsCheckedAt: now }).where(eq(schema.apps.id, appId)); return; }
  await db.update(schema.apps).set({ credentialsStatus: r.status === "valid" ? "ok" : "failing", credentialsError: r.status === "valid" ? null : r.message, credentialsCheckedAt: now }).where(eq(schema.apps.id, appId));
}

export async function recordCredentialFailure(db: DB, appId: string, message: string, now: Date) {
  await db.update(schema.apps).set({ credentialsStatus: "failing", credentialsError: message.slice(0, 500), credentialsCheckedAt: now }).where(eq(schema.apps.id, appId));
}

/** Whether a store error means the credentials were rejected (Apple 401 / key unusable, Google 401/403 or a bad key). */
export function credentialFailureOf(e: unknown): string | null {
  if (e instanceof RCError && e.code === Codes.INVALID_APPLE_SUBSCRIPTION_KEY) return e.message;
  if (e instanceof GoogleApiError && e.kind === "credentials") return e.message;
  if (e instanceof RCError && e.status === 503 && e.message.startsWith("Google Play credentials problem")) return e.message;
  if (e instanceof RCError && /^(Amazon|Stripe) credentials problem/.test(e.message)) return e.message;
  if ((e instanceof AmazonApiError || e instanceof StripeApiError) && e.kind === "credentials") return e.message;
  return null;
}

/**
 * Wraps the store adapters so every receipt check that the store answers with a credentials error marks the app
 * failing. Behaviour is otherwise unchanged: the error is rethrown as before.
 */
export function withCredentialHealth(stores: Record<string, StoreAdapter>, db: DB, now: () => Date): Record<string, StoreAdapter> {
  const out: Record<string, StoreAdapter> = {};
  for (const [type, adapter] of Object.entries(stores)) {
    if (!STORE_TYPES.includes(type)) { out[type] = adapter; continue; }
    // Keep the adapter's own fields (fetchFn, client ...) that appleApiFor/googleClientFor read.
    out[type] = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
      async verify(app: AppRow, input: Parameters<StoreAdapter["verify"]>[1], catalog: Parameters<StoreAdapter["verify"]>[2], extra?: Parameters<StoreAdapter["verify"]>[3]) {
        try {
          return await adapter.verify.call(adapter, app, input, catalog, extra);
        } catch (e) {
          const why = credentialFailureOf(e);
          if (why) await recordCredentialFailure(db, app.id, why, now()).catch(() => {});
          throw e;
        }
      },
    });
  }
  return out;
}

const HOUR = 3600_000;

const hasAppleKey = (c: Record<string, unknown>) => ["subscription_private_key", "private_key"].some((k) => typeof c[k] === "string" && !!(c[k] as string).trim());

/** The tick's re-checks: failing apps every hour, apps never checked or not checked for a day. At most `limit` per run. */
export async function recheckDueCredentials(deps: CheckDeps & { db: DB }, now: Date, limit = 10) {
  const A = schema.apps;
  const due = await deps.db.select().from(A).where(and(inArray(A.type, STORE_TYPES), or(
    isNull(A.credentialsCheckedAt),
    and(eq(A.credentialsStatus, "failing"), lte(A.credentialsCheckedAt, new Date(now.getTime() - HOUR))),
    lte(A.credentialsCheckedAt, new Date(now.getTime() - 24 * HOUR)),
  ))).limit(limit * 3);
  let checked = 0;
  for (const row of due) {
    if (checked >= limit) break;
    let app = row;
    try { app = await withStoreSecrets(deps, row); } catch (e) {
      // Sealed Amazon or Stripe secrets this server cannot open: the app must enter them again.
      await recordCredentialCheck(deps.db, row.id, { status: "invalid", message: e instanceof Error ? e.message : String(e) }, now);
      continue;
    }
    const configured = app.type === "play_store" ? hasServiceAccount(app) : app.type === "amazon" ? !!sharedSecretOf(app) : app.type === "stripe" ? !!stripeKeyOf(app) : hasAppleKey(app.credentials ?? {});
    if (!configured) {
      // Nothing to check: no status, and try again in a day (the check time also keeps the query small).
      await deps.db.update(A).set({ credentialsStatus: null, credentialsError: null, credentialsCheckedAt: now }).where(eq(A.id, app.id));
      continue;
    }
    checked++;
    try {
      await recordCredentialCheck(deps.db, app.id, await checkStoreCredentials(deps, app), now);
    } catch (e) {
      console.warn(`credential check failed for ${app.id}: ${e instanceof Error ? e.message : e}`);
      await deps.db.update(A).set({ credentialsCheckedAt: now }).where(eq(A.id, app.id));
    }
  }
  return checked;
}
