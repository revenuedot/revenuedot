// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the migration import endpoints used by `npx revenuedot import` (bulk customers, public keys, status).
// Docs: https://revenuedot.app/docs/migrate
import { and, eq, like, sql, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { NEEDS_TOKEN } from "../../services/imported-chains.js";
import { googleClientFor, purchaseTokensForOrders } from "../../stores/google/index.js";
import { baseOrderId } from "../../stores/google/map.js";
import { AppStoreServerApi, AppleApiClientError, AppleRateLimitError, appleCredentials, type AppleEnv } from "../../stores/apple/api.js";
import { expectedBundleId, verifyTransactionJws, xcodeRootsOf } from "../../stores/apple/index.js";
import { body, conflict, notFound, paramError, scope, type V2Router } from "./common.js";
import { importPage, type KeyInfo } from "./import-page.js";
import { withStoreSecretsOrNone } from "../../services/store-secrets.js";
import { hasServiceAccount } from "../../stores/google/api.js";

/**
 * RevenueDot extensions for migrating from RevenueCat (not part of RevenueCat's API):
 *
 *   POST /v2/projects/{id}/import/customers           up to 100 customers per call, each with subscriptions and purchases
 *   POST /v2/projects/{id}/import/apps/{app}/public_key   keep an app's existing SDK key (appl_..., goog_...)
 *   GET  /v2/projects/{id}/import/status              what still needs attention after an import
 *
 * Imports write state directly: no lifecycle events, no webhooks (unless `emit_events: true`). They keep first-seen dates,
 * original purchase dates and store transaction ids, and key each subscription the way the store adapters do (Apple:
 * original_transaction_id, Google: purchase token), so a later receipt post or store notification updates the imported
 * row instead of creating a second one. Running the same import twice leaves the database unchanged.
 */

const STORES = ["app_store", "mac_app_store", "play_store", "amazon", "stripe", "rc_billing", "promotional", "external", "paddle", "test_store", "roku", "galaxy"] as const;
const Ms = z.number().int().nonnegative();
const OptMs = Ms.nullable().optional();
const Price = z.object({ amount: z.number().finite(), currency: z.string().trim().min(3).max(3) });
const Env = z.enum(["production", "sandbox"]);

const Transaction = z.object({
  id: z.string().min(1).max(255),
  purchased_at: Ms,
  expires_at: OptMs,
  revenue_usd: z.number().finite().nullable().optional(),
  price: Price.nullable().optional(),
  /** The offer the period was bought with. Default: a free trial for a trial, an introductory price for the first period of an `intro` subscription, else none. */
  offer_type: z.enum(["free_trial", "introductory", "promotional", "offer_code", "win_back"]).nullable().optional(),
});

const Subscription = z.object({
  /** The source system's id (RevenueCat `sub...`), for reports. */
  source_id: z.string().max(255).optional(),
  app_id: z.string().max(255).nullable().optional(),
  store: z.enum(STORES),
  /** Store product id; Google `subscriptionId:basePlanId` is split into product and base plan. */
  product_identifier: z.string().min(1).max(511),
  environment: Env.default("production"),
  ownership: z.enum(["purchased", "family_shared"]).default("purchased"),
  starts_at: Ms,
  current_period_starts_at: Ms,
  current_period_ends_at: OptMs,
  status: z.enum(["trialing", "active", "expired", "in_grace_period", "in_billing_retry", "paused", "unknown", "incomplete"]),
  auto_renewal_status: z.enum(["will_renew", "will_not_renew", "will_change_product", "will_pause", "requires_price_increase_consent", "has_already_renewed"]).optional(),
  /** Apple: latest transaction id. Google: latest order id. Stripe and others: the store's subscription id. */
  store_subscription_identifier: z.string().min(1).max(255),
  /** Apple: the chain's original_transaction_id. Google: the first order id. */
  original_transaction_id: z.string().min(1).max(255).nullable().optional(),
  /** True when the original transaction id came from the store (not a guess from the first known transaction). */
  original_transaction_id_confirmed: z.boolean().optional(),
  /** Google only. Without it the chain is marked `needs_token_refresh` until a token is found. */
  purchase_token: z.string().min(1).max(4096).nullable().optional(),
  period_type: z.enum(["normal", "trial", "intro", "promotional", "prepaid"]).optional(),
  country: z.string().max(3).nullable().optional(),
  price: Price.nullable().optional(),
  total_revenue_usd: z.number().finite().nullable().optional(),
  unsubscribe_detected_at: OptMs,
  billing_issues_detected_at: OptMs,
  grace_period_expires_at: OptMs,
  refunded_at: OptMs,
  auto_resume_at: OptMs,
  /** Promotional grants: the entitlements they unlock. */
  entitlement_lookup_keys: z.array(z.string().min(1).max(200)).max(50).optional(),
  auto_renew_product_identifier: z.string().max(511).nullable().optional(),
  transactions: z.array(Transaction).max(2000).optional(),
});

const Purchase = z.object({
  source_id: z.string().max(255).optional(),
  app_id: z.string().max(255).nullable().optional(),
  store: z.enum(STORES),
  product_identifier: z.string().min(1).max(511),
  environment: Env.default("production"),
  purchased_at: Ms,
  store_purchase_identifier: z.string().min(1).max(255),
  status: z.enum(["owned", "refunded"]).default("owned"),
  refunded_at: OptMs,
  consumable: z.boolean().optional(),
  price: Price.nullable().optional(),
  revenue_usd: z.number().finite().nullable().optional(),
  country: z.string().max(3).nullable().optional(),
});

const Attribute = z.object({ name: z.string().min(1).max(500), value: z.string().nullable(), updated_at: Ms.optional() });

const Customer = z.object({
  id: z.string().min(1).max(1500),
  aliases: z.array(z.string().min(1).max(1500)).max(200).optional(),
  first_seen_at: OptMs,
  last_seen_at: OptMs,
  last_seen_app_version: z.string().max(255).nullable().optional(),
  last_seen_country: z.string().max(8).nullable().optional(),
  last_seen_platform: z.string().max(255).nullable().optional(),
  attributes: z.array(Attribute).max(500).optional(),
  subscriptions: z.array(Subscription).max(1000).optional(),
  purchases: z.array(Purchase).max(5000).optional(),
});

const ImportBody = z.object({
  customers: z.array(Customer).min(1).max(100),
  /** Default false: write state only. True records lifecycle events (and queues webhooks) as if the purchases just arrived. */
  emit_events: z.boolean().default(false),
  /** Default true: use the app's store credentials (when set) to confirm Apple original transaction ids and look up Google purchase tokens. */
  resolve_store_ids: z.boolean().default(true),
});

const KeyBody = z.object({ public_key: z.string().trim().min(4).max(255) });

export type ImportCustomer = z.infer<typeof Customer>;
export type ImportSub = z.infer<typeof Subscription>;
export type ImportPurchase = z.infer<typeof Purchase>;
type AppRec = typeof schema.apps.$inferSelect;

export { NEEDS_TOKEN };

const KEY_PREFIXES: Record<string, string[]> = {
  app_store: ["appl_"], mac_app_store: ["mac_", "appl_"], play_store: ["goog_"], amazon: ["amzn_"], stripe: ["strp_"], rc_billing: ["rcb_"],
  roku: ["roku_"], paddle: ["pdl_"], test_store: ["test_"], galaxy: ["galx_"],
};

const isApple = (s: string) => s === "app_store" || s === "mac_app_store";

export function importRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/import";

  r.post(`${P}/customers`, scope("customer_information:customers:read_write"), async (c) => {
    const b = await body(c, ImportBody);
    const projectId = c.get("projectId");
    const now = deps.now();
    const rows = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
    // Store ids are resolved with the apps' sealed keys, opened in memory for this page only.
    const apps = new Map((b.resolve_store_ids ? await Promise.all(rows.map((a) => withStoreSecretsOrNone(deps, a))) : rows).map((a) => [a.id, a]));
    const products = await db.select().from(schema.products).where(eq(schema.products.projectId, projectId));
    for (const cu of b.customers) {
      for (const s of [...(cu.subscriptions ?? []), ...(cu.purchases ?? [])]) {
        if (s.app_id && !apps.has(s.app_id)) throw paramError(`app_id ${s.app_id} is not an app in this project (customer ${cu.id}).`, "app_id");
      }
    }
    const keys = await resolveStoreKeys(deps, apps, b.customers, b.resolve_store_ids);
    // One transaction per page, written in a fixed number of round trips (import-page.ts). A failure leaves the whole
    // page untouched; the importer then repeats it, which is safe because pages are idempotent.
    const results = await db.transaction(async (tx) => importPage(tx as unknown as DB, { projectId, now, products, keys, emit: b.emit_events }, b.customers));
    if (b.emit_events) deps.kick?.();
    // Marks the project as migrating from RevenueCat, so Cloud's onboarding emails switch to the migration path.
    if (b.customers.length) await db.update(schema.projects).set({ rcImportAt: now }).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.rcImportAt)));
    return c.json({ object: "import_result", emit_events: b.emit_events, customers: results });
  });

  // Keeps the SDK key shipped in existing app binaries. Public keys are public by design; one key maps to one app across all projects.
  r.post(`${P}/apps/:app_id/public_key`, scope("project_configuration:apps:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const [app] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, c.req.param("app_id")))).limit(1);
    if (!app) throw notFound("App");
    const { public_key: key } = await body(c, KeyBody);
    const prefixes = KEY_PREFIXES[app.type] ?? [];
    if (key.startsWith("sk_") || (key.includes("_") && prefixes.length && !prefixes.some((p) => key.startsWith(p)))) {
      throw paramError(`A ${app.type} app's public key starts with ${prefixes.join(" or ")}.`, "public_key");
    }
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw paramError("public_key may only contain letters, digits and underscores.", "public_key");
    if (app.publicKey !== key) {
      const [taken] = await db.select({ id: schema.apps.id }).from(schema.apps).where(eq(schema.apps.publicKey, key)).limit(1);
      if (taken) throw conflict("This public key is already used by another app.", "public_key");
      await db.update(schema.apps).set({ publicKey: key }).where(eq(schema.apps.id, app.id));
    }
    return c.json({ object: "public_api_key", id: `pk_${app.id}`, key, environment: app.type === "test_store" ? "sandbox" : "production", app_id: app.id, created_at: app.createdAt.getTime() });
  });

  r.get(`${P}/status`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const customers = await count(db.select({ n: sql<number>`count(*)` }).from(schema.customers).where(eq(schema.customers.projectId, projectId)));
    const subscriptions = await count(db.select({ n: sql<number>`count(*)` }).from(schema.subscriptions).where(eq(schema.subscriptions.projectId, projectId)));
    const pending = await db.select({ app: schema.subscriptions.appId, n: sql<number>`count(*)` }).from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.projectId, projectId), like(schema.subscriptions.storeKey, `${NEEDS_TOKEN}%`))).groupBy(schema.subscriptions.appId);
    return c.json({
      object: "import_status", customers, subscriptions,
      needs_token_refresh: pending.reduce((a, x) => a + Number(x.n), 0),
      needs_token_refresh_by_app: Object.fromEntries(pending.map((x) => [x.app ?? "unknown", Number(x.n)])),
    });
  });
}

/**
 * Apple lookups per page: 4 at a time, starting at most every 25 ms (40 a second at most). A Worker request keeps at
 * most 6 connections open and Postgres holds one or more, so more in flight only queue; the spacing keeps a large page
 * from bursting into Apple's rate limit.
 */
const APPLE_LOOKUPS_IN_FLIGHT = 4;
const APPLE_LOOKUP_SPACING_MS = 25;
/** On HTTP 429, wait as Retry-After asks (up to 5 s, twice) before giving up on the lookup. */
const APPLE_RATE_LIMIT = { retries: 2, maxWaitMs: 5_000 };
const chainOriginal = (s: ImportSub) => s.original_transaction_id ?? [...(s.transactions ?? [])].sort((a, b) => a.purchased_at - b.purchased_at)[0]?.id ?? null;

/**
 * The chain key per subscription, as the store adapters would compute it. Store lookups (optional) run here,
 * outside the database transactions: Apple's API confirms original_transaction_id, Google's orders API finds purchase tokens.
 */
async function resolveStoreKeys(deps: Deps, apps: Map<string, AppRec>, customers: ImportCustomer[], resolve: boolean): Promise<Map<ImportSub, KeyInfo>> {
  const out = new Map<ImportSub, KeyInfo>();
  const googleByApp = new Map<string, ImportSub[]>();
  const appleLookups: { s: ImportSub; app: AppRec }[] = [];
  for (const cu of customers) for (const s of cu.subscriptions ?? []) {
    if (isApple(s.store)) {
      const original = chainOriginal(s) ?? s.store_subscription_identifier;
      const confirmed = !!s.original_transaction_id_confirmed;
      out.set(s, { key: original, placeholder: null, original: confirmed ? original : null });
      const app = s.app_id ? apps.get(s.app_id) : undefined;
      if (resolve && !confirmed && app) appleLookups.push({ s, app });
    } else if (s.store === "play_store") {
      const original = s.original_transaction_id ?? baseOrderId(s.store_subscription_identifier);
      const placeholder = `${NEEDS_TOKEN}${original}`;
      out.set(s, { key: s.purchase_token ?? placeholder, placeholder, original });
      if (!s.purchase_token && s.app_id) googleByApp.set(s.app_id, [...(googleByApp.get(s.app_id) ?? []), s]);
    } else if (s.store === "promotional") {
      const k = `rc_import:${s.source_id ?? s.store_subscription_identifier}`;
      out.set(s, { key: k, placeholder: null, original: k });
    } else {
      out.set(s, { key: s.store_subscription_identifier, placeholder: null, original: s.original_transaction_id ?? s.store_subscription_identifier });
    }
  }
  await resolveAppleOriginals(deps, appleLookups, out);
  if (resolve) {
    for (const [appId, subs] of googleByApp) {
      const app = apps.get(appId)!;
      if (!hasGoogleCredentials(app)) continue;
      try {
        const orders = subs.flatMap((s) => [s.store_subscription_identifier, out.get(s)!.original!]);
        const tokens = await purchaseTokensForOrders(app, orders, googleClientFor(deps.stores, deps.fetch).client);
        for (const s of subs) {
          const token = tokens[s.store_subscription_identifier] ?? tokens[out.get(s)!.original!];
          if (token) out.get(s)!.key = token;
        }
      } catch (e) {
        for (const s of subs) out.get(s)!.note = `Google orders lookup failed: ${e instanceof Error ? e.message : e}`;
      }
    }
  }
  return out;
}

const hasGoogleCredentials = (app: AppRec) => hasServiceAccount(app);

/**
 * Confirms each Apple chain's original_transaction_id with Get Transaction Info. A chain that cannot be confirmed keeps
 * its guessed key and gets a note; running the import again retries it (pages are idempotent).
 */
async function resolveAppleOriginals(deps: Deps, lookups: { s: ImportSub; app: AppRec }[], out: Map<ImportSub, KeyInfo>) {
  // One client (one signed token) per app for the page.
  const clients = new Map<string, AppStoreServerApi | null>();
  const clientFor = (app: AppRec) => {
    if (!clients.has(app.id)) {
      const creds = appleCredentials(app);
      // Wrapped: Workers' global fetch must not be called as a method of another object.
      const f = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
      clients.set(app.id, creds ? new AppStoreServerApi(creds, f, deps.now, APPLE_RATE_LIMIT) : null);
    }
    return clients.get(app.id)!;
  };
  let rateLimited: AppleRateLimitError | null = null;
  let next = 0;
  let lastStart = 0;
  const one = async ({ s, app }: { s: ImportSub; app: AppRec }) => {
    const k = out.get(s)!;
    const id = s.store_subscription_identifier;
    // After Apple's rate limit stops one lookup, the rest of the page skips Apple instead of adding to it.
    if (rateLimited) { k.note = `Apple lookup skipped for ${id}: ${rateLimited.message} Run the import again to confirm this chain.`; return; }
    try {
      const api = clientFor(app);
      if (!api) return;
      const original = await appleOriginal(deps, api, app, id, s.environment);
      if (original) out.set(s, { key: original, placeholder: null, original, guess: k.key });
    } catch (e) {
      if (e instanceof AppleRateLimitError) rateLimited = e;
      k.note = e instanceof AppleApiClientError
        ? `Apple rejected the lookup for ${id}: ${e.message} (HTTP ${e.status}${e.errorCode ? `, error ${e.errorCode}` : ""}).`
        : `Apple lookup failed for ${id}: ${e instanceof Error ? e.message : e}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(APPLE_LOOKUPS_IN_FLIGHT, lookups.length) }, async () => {
    while (next < lookups.length) {
      const item = lookups[next++]!;
      const wait = lastStart + APPLE_LOOKUP_SPACING_MS - Date.now();
      lastStart = Math.max(Date.now(), lastStart + APPLE_LOOKUP_SPACING_MS);
      if (wait > 0 && !rateLimited) await new Promise((r) => setTimeout(r, wait));
      await one(item);
    }
  }));
}

const otherEnv = (env: AppleEnv): AppleEnv => (env === "production" ? "sandbox" : "production");

/**
 * Apple's original_transaction_id for any transaction of a chain (Get Transaction Info), or null when neither environment
 * knows it. Apple answers 404 (4040010, transaction not found) from the wrong environment, so a miss tries the other one.
 */
async function appleOriginal(deps: Deps, api: AppStoreServerApi, app: AppRec, transactionId: string, env: AppleEnv): Promise<string | null> {
  const path = `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const res = await api.get<{ signedTransactionInfo?: string }>(env, path) ?? await api.get<{ signedTransactionInfo?: string }>(otherEnv(env), path);
  if (!res?.signedTransactionInfo) return null;
  const tx = await verifyTransactionJws(res.signedTransactionInfo, { bundleId: expectedBundleId(app), xcodeRoots: xcodeRootsOf(app), now: deps.now(), source: "apple" });
  return tx.originalTransactionId;
}
