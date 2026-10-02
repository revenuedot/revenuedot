import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { V2Error, body, listOf, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { appShape } from "./shapes.js";
import { depsSecretKey } from "../../services/secrets.js";
import { sealStoreSecrets, storeSecretFields, stripeConnected, takeStoreSecrets } from "../../services/store-secrets.js";
import { PADDLE_KEY_RE } from "../../stores/paddle/api.js";

/** RevenueCat's app types, plus `galaxy` (Samsung Galaxy Store; RevenueCat's v2 API has no Galaxy app object, a RevenueDot extension). */
const APP_TYPES = ["amazon", "app_store", "mac_app_store", "play_store", "stripe", "rc_billing", "roku", "paddle", "test_store", "galaxy"] as const;

/** Public SDK key prefix per store, matching the prefixes the RevenueCat SDKs expect. */
const KEY_PREFIX: Record<string, string> = {
  app_store: "appl_", mac_app_store: "mac_", play_store: "goog_", amazon: "amzn_", stripe: "strp_", rc_billing: "rcb_", roku: "roku_", paddle: "pdl_", test_store: "test_", galaxy: "galx_",
};

const details = z.record(z.unknown());
const AppCreate = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(APP_TYPES),
  app_store: details.optional(), mac_app_store: details.optional(), play_store: details.optional(), amazon: details.optional(),
  stripe: details.optional(), rc_billing: details.nullable().optional(), roku: details.nullable().optional(), paddle: details.nullable().optional(), galaxy: details.optional(),
});
const AppUpdate = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  app_store: details.optional(), mac_app_store: details.optional(), play_store: details.optional(), amazon: details.optional(),
  stripe: details.optional(), rc_billing: details.optional(), roku: details.optional(), paddle: details.optional(), galaxy: details.optional(),
});

/** The identifier field each store's details must carry (stored in `apps.bundle_id`). */
const ID_FIELD: Record<string, string> = { app_store: "bundle_id", mac_app_store: "bundle_id", play_store: "package_name", amazon: "package_name", galaxy: "package_name" };

/** Splits a store details object into the bundle/package id and the rest (credentials and settings, stored as given). */
function splitDetails(type: string, d: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  let id: string | undefined;
  for (const [k, v] of Object.entries(d ?? {})) {
    if (k === ID_FIELD[type]) { if (typeof v !== "string" || !v) throw paramError(`${type}.${k} must be a non-empty string.`, `${type}.${k}`); id = v; continue; }
    if (v !== undefined) out[k] = v;
  }
  return { id, rest: out };
}

/**
 * Checks the Amazon, Stripe, Paddle, Roku and Galaxy credential fields before they are stored (a pasted publishable key or a webhook secret in
 * the key field fails here, not on the first purchase). null clears a field and is always allowed.
 */
function checkStoreFields(type: string, rest: Record<string, unknown>) {
  const bad = (field: string, msg: string) => { throw paramError(`${type}.${field} ${msg}`, `${type}.${field}`); };
  const val = (k: string) => (rest[k] === undefined || rest[k] === null ? null : rest[k]);
  const text = (k: string, max = 500) => {
    const v = val(k);
    if (v === null) return null;
    if (typeof v !== "string" || !v.trim() || v.length > max) bad(k, "must be a non-empty string.");
    return (v as string).trim();
  };
  const bool = (k: string) => { const v = val(k); if (v !== null && typeof v !== "boolean") bad(k, "must be true or false."); };
  if (type === "amazon") {
    text("shared_secret");
    const arn = text("sns_topic_arn", 256);
    if (arn && !/^arn:aws(-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(arn)) bad("sns_topic_arn", "must be an SNS topic ARN such as arn:aws:sns:us-east-1:123456789012:topic.");
    bool("track_new_purchases");
  }
  if (type === "stripe") {
    // Set only by "Connect with Stripe" (services/stripe-connect.ts): an API body can never point an app at a connected account.
    for (const k of ["stripe_connect_account_id", "stripe_connect_mode", "stripe_connected"]) if (k in rest) bad(k, "is set by Connect with Stripe, not through the API.");
    const key = text("stripe_secret_key");
    if (key && /^pk_/.test(key)) bad("stripe_secret_key", "is a publishable key (pk_…). Use a restricted key (rk_…) or a secret key (sk_…).");
    if (key && !/^(rk|sk)_(live|test)_[A-Za-z0-9]+$/.test(key)) bad("stripe_secret_key", "must be a Stripe restricted key (rk_live_… or rk_test_…) or secret key (sk_…).");
    const whsec = text("stripe_webhook_secret");
    if (whsec && !/^whsec_[A-Za-z0-9+/=]+$/.test(whsec)) bad("stripe_webhook_secret", "must be the endpoint's signing secret (whsec_…).");
    const acct = text("stripe_account_id", 100);
    if (acct && !/^acct_[A-Za-z0-9]+$/.test(acct)) bad("stripe_account_id", "must be a Stripe account id (acct_…).");
    const src = val("app_user_id_source");
    if (src !== null && !["metadata", "customer_id", "anonymous"].includes(String(src))) bad("app_user_id_source", "must be metadata, customer_id or anonymous.");
    const mk = text("app_user_id_metadata_key", 40);
    if (mk && !/^[\w.-]+$/.test(mk)) bad("app_user_id_metadata_key", "must be a Stripe metadata key (letters, digits, _ . -; at most 40).");
    const reg = val("register_on");
    if (reg !== null && reg !== "invoice_paid" && reg !== "invoice_created") bad("register_on", "must be invoice_paid or invoice_created.");
    bool("track_new_purchases");
  }
  if (type === "paddle") {
    const key = text("paddle_api_key", 200);
    if (key && /^(live|test)_[a-z0-9]+$/.test(key)) bad("paddle_api_key", "is a client-side token (live_… or test_…). Use a server-side API key (pdl_live_apikey_… or pdl_sdbx_apikey_…) from Paddle → Developer tools → Authentication.");
    if (key && !PADDLE_KEY_RE.test(key)) bad("paddle_api_key", "must be a Paddle API key (pdl_live_apikey_… or pdl_sdbx_apikey_…, 69 characters).");
    const secret = text("paddle_webhook_secret", 200);
    if (secret && !/^pdl_ntfset_[A-Za-z0-9_]+$/.test(secret)) bad("paddle_webhook_secret", "must be the notification destination's secret key (pdl_ntfset_…).");
    const setting = text("paddle_notification_setting_id", 100);
    if (setting && !/^ntfset_[a-z0-9]+$/.test(setting)) bad("paddle_notification_setting_id", "must be a Paddle notification setting id (ntfset_…).");
    bool("paddle_is_sandbox");
    const src = val("app_user_id_source");
    if (src !== null && !["custom_data", "anonymous"].includes(String(src))) bad("app_user_id_source", "must be custom_data or anonymous.");
    const ck = text("app_user_id_custom_data_key", 40);
    if (ck && !/^[\w.-]+$/.test(ck)) bad("app_user_id_custom_data_key", "must be a custom_data key (letters, digits, _ . -; at most 40).");
    bool("track_new_purchases");
  }
  if (type === "roku") {
    if (typeof rest.roku_channel_id === "number") rest.roku_channel_id = String(rest.roku_channel_id);
    const key = text("roku_api_key", 100);
    if (key && !/^[A-Za-z0-9]{20,64}$/.test(key)) bad("roku_api_key", "must be the Roku Pay web services API key (letters and digits, from the Roku developer dashboard).");
    const ch = text("roku_channel_id", 20);
    if (ch && !/^[A-Za-z0-9_-]{1,20}$/.test(ch)) bad("roku_channel_id", "must be the channel id shown on the Roku channel page.");
    text("roku_channel_name", 30);
    bool("track_new_purchases");
  }
  if (type === "galaxy") {
    const id = text("galaxy_service_account_id", 100);
    if (id && !/^[\w.@:-]{4,100}$/.test(id)) bad("galaxy_service_account_id", "must be the service account id shown in Seller Portal → Assistance → API Service.");
    const pk = text("galaxy_service_account_private_key", 10_000);
    if (pk && !/PRIVATE KEY-----/.test(pk) && !/^[A-Za-z0-9+/=\s]{100,}$/.test(pk)) bad("galaxy_service_account_private_key", "must be the service account's private key file (-----BEGIN PRIVATE KEY-----).");
    const pub = text("galaxy_iap_public_key", 5_000);
    if (pub && !/PUBLIC KEY-----/.test(pub) && !/^[A-Za-z0-9+/=\s]{100,}$/.test(pub)) bad("galaxy_iap_public_key", "must be the IAP public key from Seller Portal (an RSA public key).");
    bool("track_new_purchases");
  }
}

/** Takes `notification_forward_url` out of the details: undefined = unchanged, null or "" = off, else an http(s) URL. */
function forwardUrl(rest: Record<string, unknown>): string | null | undefined {
  if (!("notification_forward_url" in rest)) return undefined;
  const v = rest.notification_forward_url;
  delete rest.notification_forward_url;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !/^https?:\/\/[^\s/]+/i.test(v.trim()) || v.length > 2048) throw paramError("notification_forward_url must be an http(s) URL.", "notification_forward_url");
  return v.trim();
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function appRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/apps";
  const find = async (projectId: string, id: string) => {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, id))).limit(1);
    if (!a) throw notFound("App");
    return a;
  };

  r.get(P, scope("project_configuration:apps:read"), async (c) => {
    const rows = await db.select().from(schema.apps).where(eq(schema.apps.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (a) => a.id, (a) => a.createdAt.getTime(), appShape));
  });

  r.post(P, scope("project_configuration:apps:read_write"), async (c) => {
    const b = await body(c, AppCreate);
    const d = b[b.type as keyof typeof b] as Record<string, unknown> | null | undefined;
    const { id: bundleId, rest } = splitDetails(b.type, d);
    const fwd = forwardUrl(rest);
    checkStoreFields(b.type, rest);
    // Amazon and Stripe secrets are sealed in apps.secrets, never stored in credentials (services/store-secrets.ts).
    const secretUpdate = takeStoreSecrets(b.type, rest);
    for (const [k, v] of Object.entries(rest)) if (v === null) delete rest[k];
    if (ID_FIELD[b.type] && !bundleId) throw paramError(`${b.type}.${ID_FIELD[b.type]} is required for ${b.type} apps.`, `${b.type}.${ID_FIELD[b.type]}`);
    const sealed = storeSecretFields(b.type).length
      ? await sealStoreSecrets({ type: b.type, credentials: rest, secrets: null }, secretUpdate, await depsSecretKey(deps))
      : { secrets: null, secretHints: {}, credentials: rest };
    const [row] = await db.insert(schema.apps).values({
      id: newId("app", 8), projectId: c.get("projectId"), name: b.name, type: b.type, bundleId: bundleId ?? null,
      publicKey: `${KEY_PREFIX[b.type]}${randomKey()}`, credentials: sealed.credentials, secrets: sealed.secrets, secretHints: sealed.secretHints,
      notificationForwardUrl: fwd ?? null, createdAt: deps.now(),
    }).returning();
    return c.json(appShape(row!), 201);
  });

  r.get(`${P}/:app_id`, scope("project_configuration:apps:read"), async (c) => c.json(appShape(await find(c.get("projectId"), c.req.param("app_id")))));

  r.post(`${P}/:app_id`, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    const b = await body(c, AppUpdate);
    for (const t of APP_TYPES) if (t !== a.type && b[t as keyof typeof b] !== undefined) throw paramError(`${t} details can only be sent for ${t} apps.`, t);
    const { id: bundleId, rest } = splitDetails(a.type, b[a.type as keyof typeof b] as Record<string, unknown> | undefined);
    // RevenueDot extension: `notification_forward_url` (store notifications are copied there, e.g. to RevenueCat during a dual run).
    const fwd = forwardUrl(rest);
    checkStoreFields(a.type, rest);
    const secretUpdate = takeStoreSecrets(a.type, rest);
    if (a.type === "stripe" && stripeConnected(a) && (secretUpdate.stripe_secret_key || secretUpdate.stripe_webhook_secret)) {
      throw new V2Error(409, "resource_already_exists", "This app is connected with Stripe Connect. Disconnect it before adding a restricted key or a webhook signing secret.", "stripe.stripe_secret_key");
    }
    // null clears a credential; other values replace it.
    let credentials: Record<string, unknown> = { ...a.credentials };
    for (const [k, v] of Object.entries(rest)) { if (v === null) delete credentials[k]; else credentials[k] = v; }
    // Amazon and Stripe secrets are (re)sealed when one changes or one is still plain in credentials from before sealing.
    let sealed: { secrets: string | null; secretHints: Record<string, string> } | null = null;
    if (Object.keys(secretUpdate).length || storeSecretFields(a.type).some((f) => f in credentials)) {
      const s = await sealStoreSecrets({ type: a.type, credentials, secrets: a.secrets }, secretUpdate, await depsSecretKey(deps));
      credentials = s.credentials;
      sealed = { secrets: s.secrets, secretHints: s.secretHints };
    }
    // New credentials (or package name) are checked with the store on the next tick; a failing alert resolves only once the store accepts them.
    const recheck = bundleId || Object.keys(rest).length || Object.keys(secretUpdate).length ? { credentialsCheckedAt: null } : {};
    const [row] = await db.update(schema.apps).set({ ...(b.name ? { name: b.name } : {}), ...(bundleId ? { bundleId } : {}), ...(fwd !== undefined ? { notificationForwardUrl: fwd } : {}), credentials, ...(sealed ?? {}), ...recheck })
      .where(and(eq(schema.apps.projectId, a.projectId), eq(schema.apps.id, a.id))).returning();
    return c.json(appShape(row!));
  });

  // Deleting an app deletes its products (and their entitlement/package links); purchases keep their history.
  r.delete(`${P}/:app_id`, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    await db.delete(schema.apps).where(and(eq(schema.apps.projectId, a.projectId), eq(schema.apps.id, a.id)));
    return c.json({ object: "app", id: a.id, deleted_at: deps.now().getTime() });
  });

  r.get(`${P}/:app_id/public_api_keys`, scope("project_configuration:apps:read"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    return c.json(listOf(c, [{
      object: "public_api_key", id: `pk_${a.id}`, key: a.publicKey, environment: a.type === "test_store" ? "sandbox" : "production", app_id: a.id, created_at: a.createdAt.getTime(),
    }], null));
  });
}

