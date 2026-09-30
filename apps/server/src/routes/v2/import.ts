// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the migration import endpoints used by `npx revenuedot import` (bulk customers, public keys, status).
// Docs: https://revenuedot.app/docs/migrate
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { accessEndsAt, newId, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer, mergeCustomers, setAttributes, subRowToDomain, type CustomerRow } from "../../repo/customers.js";
import { applyPurchases } from "../../services/purchases.js";
import type { VerifiedOneTime, VerifiedSubscription } from "../../stores/types.js";
import { googleClientFor, purchaseTokensForOrders } from "../../stores/google/index.js";
import { baseOrderId } from "../../stores/google/map.js";
import { AppStoreServerApi, appleCredentials } from "../../stores/apple/api.js";
import { expectedBundleId, verifyTransactionJws, xcodeRootsOf } from "../../stores/apple/index.js";
import { body, conflict, notFound, paramError, scope, type V2Router } from "./common.js";

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
type ImportSub = z.infer<typeof Subscription>;
type ImportPurchase = z.infer<typeof Purchase>;
type AppRec = typeof schema.apps.$inferSelect;

/** Placeholder chain key for a Google subscription whose purchase token is not known yet. */
export const NEEDS_TOKEN = "needs_token_refresh:";

const KEY_PREFIXES: Record<string, string[]> = {
  app_store: ["appl_"], mac_app_store: ["mac_", "appl_"], play_store: ["goog_"], amazon: ["amzn_"], stripe: ["strp_"], rc_billing: ["rcb_"],
  roku: ["roku_"], paddle: ["pdl_"], test_store: ["test_"],
};

const d = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms) : null);
const isApple = (s: string) => s === "app_store" || s === "mac_app_store";

interface Report { id: string; status: "created" | "updated" | "merged"; subscriptions: number; purchases: number; needs_token_refresh: number; notes: string[] }

export function importRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/import";

  r.post(`${P}/customers`, scope("customer_information:customers:read_write"), async (c) => {
    const b = await body(c, ImportBody);
    const projectId = c.get("projectId");
    const now = deps.now();
    const apps = new Map((await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId))).map((a) => [a.id, a]));
    const products = await db.select().from(schema.products).where(eq(schema.products.projectId, projectId));
    for (const cu of b.customers) {
      for (const s of [...(cu.subscriptions ?? []), ...(cu.purchases ?? [])]) {
        if (s.app_id && !apps.has(s.app_id)) throw paramError(`app_id ${s.app_id} is not an app in this project (customer ${cu.id}).`, "app_id");
      }
    }
    const keys = await resolveStoreKeys(deps, apps, b.customers, b.resolve_store_ids);
    const results: Report[] = [];
    for (const cu of b.customers) {
      // One customer per transaction: a failure leaves earlier customers imported and this one untouched.
      results.push(await db.transaction(async (tx) => importCustomer(tx as unknown as DB, { projectId, now, apps, products, keys, emit: b.emit_events }, cu)));
    }
    if (b.emit_events) deps.kick?.();
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

interface Ctx { projectId: string; now: Date; apps: Map<string, AppRec>; products: (typeof schema.products.$inferSelect)[]; keys: Map<ImportSub, KeyInfo>; emit: boolean }
interface KeyInfo { key: string; placeholder: string | null; original: string | null; note?: string }

const chainOriginal = (s: ImportSub) => s.original_transaction_id ?? [...(s.transactions ?? [])].sort((a, b) => a.purchased_at - b.purchased_at)[0]?.id ?? null;

/**
 * The chain key per subscription, as the store adapters would compute it. Store lookups (optional) run here,
 * outside the database transactions: Apple's API confirms original_transaction_id, Google's orders API finds purchase tokens.
 */
async function resolveStoreKeys(deps: Deps, apps: Map<string, AppRec>, customers: ImportCustomer[], resolve: boolean): Promise<Map<ImportSub, KeyInfo>> {
  const out = new Map<ImportSub, KeyInfo>();
  const googleByApp = new Map<string, ImportSub[]>();
  for (const cu of customers) for (const s of cu.subscriptions ?? []) {
    if (isApple(s.store)) {
      let original = chainOriginal(s) ?? s.store_subscription_identifier;
      let note: string | undefined;
      const app = s.app_id ? apps.get(s.app_id) : undefined;
      if (resolve && !s.original_transaction_id_confirmed && app) {
        try {
          const confirmed = await appleOriginal(deps, app, s.store_subscription_identifier, s.environment);
          if (confirmed) original = confirmed;
        } catch (e) {
          note = `Apple lookup failed for ${s.store_subscription_identifier}: ${e instanceof Error ? e.message : e}`;
        }
      }
      out.set(s, { key: original, placeholder: null, original, note });
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

const hasGoogleCredentials = (app: AppRec) => {
  const cr = app.credentials ?? {};
  return !!(cr.play_service_account_credentials_json || cr.service_account);
};

/** Apple's original_transaction_id for any transaction of a chain (Get Transaction Info), or null without credentials. */
async function appleOriginal(deps: Deps, app: AppRec, transactionId: string, env: "production" | "sandbox"): Promise<string | null> {
  const creds = appleCredentials(app);
  if (!creds) return null;
  const api = new AppStoreServerApi(creds, deps.fetch ?? fetch, deps.now);
  const res = await api.get<{ signedTransactionInfo?: string }>(env, `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
  if (!res?.signedTransactionInfo) return null;
  const tx = await verifyTransactionJws(res.signedTransactionInfo, { bundleId: expectedBundleId(app), xcodeRoots: xcodeRootsOf(app), now: deps.now(), source: "apple" });
  return tx.originalTransactionId;
}

async function importCustomer(db: DB, ctx: Ctx, cu: ImportCustomer): Promise<Report> {
  const { projectId, now } = ctx;
  const notes: string[] = [];
  const ids = [...new Set([cu.id, ...(cu.aliases ?? [])])];
  const firstSeen = d(cu.first_seen_at) ?? now;
  const lastSeen = d(cu.last_seen_at) ?? firstSeen;

  // Every existing customer that holds one of these ids becomes one customer (RevenueCat already merged them).
  const found = new Map<string, CustomerRow>();
  for (const id of ids) { const f = await findCustomer(db, projectId, id); if (f) found.set(f.id, f); }
  let status: Report["status"] = "updated";
  let customer: CustomerRow;
  if (!found.size) {
    status = "created";
    [customer] = await db.insert(schema.customers).values({
      id: newId("cus_", 16), projectId, originalAppUserId: cu.id, firstSeen, lastSeen,
      lastSeenAppVersion: cu.last_seen_app_version ?? null, lastSeenCountry: cu.last_seen_country ?? null, lastSeenPlatform: cu.last_seen_platform ?? null,
    }).returning() as [CustomerRow];
  } else {
    const all = [...found.values()];
    const holder = (await findCustomer(db, projectId, cu.id)) ?? all.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime())[0]!;
    for (const other of all) if (other.id !== holder.id) { await mergeCustomers(db, other.id, holder.id); status = "merged"; }
    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, holder.id));
    const newer = row!.lastSeen <= lastSeen;
    [customer] = await db.update(schema.customers).set({
      firstSeen: row!.firstSeen < firstSeen ? row!.firstSeen : firstSeen,
      lastSeen: newer ? lastSeen : row!.lastSeen,
      ...(newer && cu.last_seen_app_version ? { lastSeenAppVersion: cu.last_seen_app_version } : {}),
      ...(newer && cu.last_seen_country ? { lastSeenCountry: cu.last_seen_country } : {}),
      ...(newer && cu.last_seen_platform ? { lastSeenPlatform: cu.last_seen_platform } : {}),
    }).where(eq(schema.customers.id, holder.id)).returning() as [CustomerRow];
  }
  for (const id of ids) await db.insert(schema.customerAliases).values({ projectId, appUserId: id, customerId: customer.id, createdAt: firstSeen }).onConflictDoNothing();

  // Attributes keep their source timestamps; a newer value already here wins.
  if (cu.attributes?.length) {
    await setAttributes(db, customer.id, Object.fromEntries(cu.attributes.map((a) => [a.name, { value: a.value, updated_at_ms: a.updated_at ?? 0 }])), now);
  }

  let pending = 0;
  // Oldest period first: when two source subscriptions share a store chain (an Apple resubscribe), the latest state wins.
  const subs = [...(cu.subscriptions ?? [])].sort((a, b) => a.current_period_starts_at - b.current_period_starts_at);
  for (const s of subs) {
    const k = ctx.keys.get(s)!;
    if (k.note) notes.push(k.note);
    if (k.placeholder && k.key === k.placeholder) pending++;
    await importSubscription(db, ctx, customer, cu, s, k, notes);
  }
  for (const p of cu.purchases ?? []) await importPurchase(db, ctx, customer, cu, p, notes);

  return { id: cu.id, status, subscriptions: subs.length, purchases: cu.purchases?.length ?? 0, needs_token_refresh: pending, notes: [...new Set(notes)] };
}

/** Maps an imported subscription to the stored fields, with deterministic detection times so re-imports change nothing. */
function toVerified(ctx: Ctx, s: ImportSub, k: KeyInfo, notes: string[]): VerifiedSubscription & { entitlement: string | null } {
  const google = s.store === "play_store";
  const [product, plan] = google && s.product_identifier.includes(":") ? s.product_identifier.split(":", 2) as [string, string] : [s.product_identifier, null];
  const periodStart = new Date(s.current_period_starts_at);
  const periodEnd = d(s.current_period_ends_at);
  const promo = s.store === "promotional";
  const renewalOff = s.auto_renewal_status === "will_not_renew" || s.auto_renewal_status === "requires_price_increase_consent";
  const billing = s.status === "in_grace_period" || s.status === "in_billing_retry";
  let expiresDate: Date | null = periodEnd;
  if (!expiresDate && !promo) expiresDate = periodStart; // paused until an indefinite date: no access now
  let grace: Date | null = null;
  if (s.status === "in_grace_period") {
    grace = d(s.grace_period_expires_at) ?? d(Math.max(...(s.transactions ?? []).map((t) => t.expires_at ?? 0), 0) || null);
    if (!grace || (expiresDate && grace <= expiresDate)) {
      grace = new Date((expiresDate ?? periodStart).getTime() + 7 * 86_400_000);
      notes.push(`${s.store_subscription_identifier}: grace period end unknown; assumed 7 days after the period end.`);
    }
  }
  const lastTx = [...(s.transactions ?? [])].sort((a, b) => b.purchased_at - a.purchased_at)[0];
  const price = s.price ?? lastTx?.price ?? null;
  return {
    kind: "subscription", store: s.store as Store, storeKey: k.key, productIdentifier: product, productPlanIdentifier: plan,
    isSandbox: s.environment === "sandbox", purchaseDate: periodStart, originalPurchaseDate: new Date(s.starts_at), expiresDate,
    periodType: s.period_type ?? (promo ? "promotional" : s.status === "trialing" ? "trial" : "normal"),
    ownershipType: s.ownership === "family_shared" ? "FAMILY_SHARED" : "PURCHASED",
    unsubscribeDetectedAt: d(s.unsubscribe_detected_at) ?? (!promo && (renewalOff || billing || s.status === "expired") ? periodStart : null),
    billingIssuesDetectedAt: d(s.billing_issues_detected_at) ?? (billing ? periodEnd ?? periodStart : null),
    gracePeriodExpiresDate: grace, refundedAt: d(s.refunded_at),
    autoResumeDate: s.status === "paused" ? d(s.auto_resume_at) ?? periodEnd ?? periodStart : d(s.auto_resume_at),
    storeTransactionId: s.store_subscription_identifier, originalTransactionId: k.original,
    price, countryCode: s.country ? s.country.toUpperCase() : null,
    autoRenewProductId: s.auto_renew_product_identifier ?? null,
    entitlement: promo ? s.entitlement_lookup_keys?.[0] ?? null : null,
  };
}

async function importSubscription(db: DB, ctx: Ctx, customer: CustomerRow, cu: ImportCustomer, s: ImportSub, k: KeyInfo, notes: string[]) {
  const { projectId, now } = ctx;
  const S = schema.subscriptions;
  const where = (key: string) => and(eq(S.projectId, projectId), eq(S.store, s.store), eq(S.storeKey, key));
  // A token found on a later run upgrades the placeholder row in place.
  if (k.placeholder && k.key !== k.placeholder) {
    const [ph] = await db.select({ id: S.id }).from(S).where(where(k.placeholder)).limit(1);
    const [real] = await db.select({ id: S.id }).from(S).where(where(k.key)).limit(1);
    if (ph && !real) await db.update(S).set({ storeKey: k.key }).where(eq(S.id, ph.id));
    else if (ph && real) await db.delete(S).where(eq(S.id, ph.id));
  }
  const promoKeys = s.store === "promotional" ? (s.entitlement_lookup_keys?.length ? s.entitlement_lookup_keys : [null]) : [null];
  for (const [i, ent] of promoKeys.entries()) {
    const v = toVerified(ctx, s, i === 0 ? k : { ...k, key: `${k.key}:${ent}` }, notes);
    if (ent) v.entitlement = ent;
    const [existing] = await db.select().from(S).where(where(v.storeKey)).limit(1);
    if (existing && existing.customerId !== customer.id) notes.push(`${s.store} ${v.storeKey} moved from another customer to ${cu.id}.`);
    // Live traffic already recorded a newer period: keep it, only fix the owner and the chain's start.
    if (existing && existing.purchaseDate > v.purchaseDate) {
      await db.update(S).set({
        customerId: customer.id,
        originalPurchaseDate: existing.originalPurchaseDate < v.originalPurchaseDate ? existing.originalPurchaseDate : v.originalPurchaseDate,
      }).where(eq(S.id, existing.id));
      continue;
    }
    // A detection time already stored stays put while the state it describes is unchanged.
    const keep = (prev: Date | null | undefined, next: Date | null | undefined) => (next && prev ? prev : next ?? null);
    const values = {
      projectId, customerId: customer.id, appId: s.app_id ?? existing?.appId ?? null, store: v.store, storeKey: v.storeKey,
      productIdentifier: v.productIdentifier, productPlanIdentifier: v.productPlanIdentifier ?? null, isSandbox: v.isSandbox,
      purchaseDate: v.purchaseDate,
      originalPurchaseDate: existing && existing.originalPurchaseDate < v.originalPurchaseDate ? existing.originalPurchaseDate : v.originalPurchaseDate,
      expiresDate: v.expiresDate, periodType: v.periodType, ownershipType: v.ownershipType ?? "PURCHASED",
      unsubscribeDetectedAt: keep(existing?.unsubscribeDetectedAt, v.unsubscribeDetectedAt),
      billingIssuesDetectedAt: keep(existing?.billingIssuesDetectedAt, v.billingIssuesDetectedAt),
      gracePeriodExpiresDate: v.gracePeriodExpiresDate ?? null, refundedAt: v.refundedAt ?? null, autoResumeDate: v.autoResumeDate ?? null,
      storeTransactionId: v.storeTransactionId, originalTransactionId: v.originalTransactionId ?? null,
      priceAmount: v.price?.amount ?? null, priceCurrency: v.price?.currency ?? null,
      priceUsd: v.price ? (v.price.currency === "USD" ? v.price.amount : lastUsd(s)) : null,
      countryCode: v.countryCode ?? null, autoRenewProductId: v.autoRenewProductId ?? null,
      entitlementIdentifier: v.entitlement,
    };
    // Access that already ended counts as expired, so the expiration job does not send EXPIRATION for old history.
    const end = accessEndsAt(subRowToDomain({ ...(existing ?? {}), ...values, id: existing?.id ?? "" } as typeof S.$inferSelect));
    const expiredEventAt = end !== null && end <= now ? existing?.expiredEventAt ?? end : null;
    if (ctx.emit) {
      await applyPurchases(db, customer, [v], { projectId, appId: values.appId, appUserId: cu.id, now, fromDevice: false });
      await db.update(S).set({ appId: values.appId, entitlementIdentifier: v.entitlement, originalPurchaseDate: values.originalPurchaseDate }).where(where(v.storeKey));
      continue;
    }
    const updatedAt = existing && sameState(existing, values) ? existing.updatedAt : now;
    if (existing) await db.update(S).set({ ...values, expiredEventAt, updatedAt }).where(eq(S.id, existing.id));
    else await db.insert(S).values({ id: newId("sub_", 16), ...values, expiredEventAt, updatedAt });
    await importTransactions(db, ctx, customer, s, values);
  }
  const [cur] = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
  const start = new Date(s.starts_at);
  if (cur && (!cur.originalPurchaseDate || cur.originalPurchaseDate > start)) await db.update(schema.customers).set({ originalPurchaseDate: start }).where(eq(schema.customers.id, customer.id));
}

const lastUsd = (s: ImportSub) => [...(s.transactions ?? [])].sort((a, b) => b.purchased_at - a.purchased_at)[0]?.revenue_usd ?? null;

function sameState(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const [k, v] of Object.entries(b)) {
    const x = a[k];
    if (v instanceof Date || x instanceof Date) { if ((x as Date | null)?.getTime?.() !== (v as Date | null)?.getTime?.()) return false; }
    else if (x !== v) return false;
  }
  return true;
}

/** Revenue history for charts: one row per store transaction (idempotent on the store transaction id). */
async function importTransactions(db: DB, ctx: Ctx, customer: CustomerRow, s: ImportSub, v: { appId: string | null; storeKey: string; originalTransactionId: string | null; productIdentifier: string; isSandbox: boolean; countryCode: string | null }) {
  const txs = s.transactions?.length ? s.transactions : [{ id: s.store_subscription_identifier, purchased_at: s.current_period_starts_at, expires_at: s.current_period_ends_at ?? null, revenue_usd: s.total_revenue_usd ?? null, price: s.price ?? null }];
  const first = v.originalTransactionId ?? v.storeKey;
  for (const t of txs) {
    const revenue = t.revenue_usd ?? (t.price?.currency === "USD" ? t.price.amount : 0);
    const kind = t.id === first || txs.length === 1 && !s.transactions?.length ? (revenue === 0 && s.status === "trialing" ? "trial" : "purchase") : "renewal";
    await db.insert(schema.transactions).values({
      id: newId("txn_", 16), projectId: ctx.projectId, customerId: customer.id, appId: v.appId, store: s.store, storeTransactionId: t.id,
      productIdentifier: v.productIdentifier, kind, isSandbox: v.isSandbox, purchasedAt: new Date(t.purchased_at), expiresAt: d(t.expires_at),
      revenueUsd: revenue, priceAmount: t.price?.amount ?? null, priceCurrency: t.price?.currency ?? null, countryCode: v.countryCode,
    }).onConflictDoNothing();
  }
  // A transaction moved to another customer by a merge or transfer follows its chain.
  await db.update(schema.transactions).set({ customerId: customer.id })
    .where(and(eq(schema.transactions.projectId, ctx.projectId), eq(schema.transactions.store, s.store), inArray(schema.transactions.storeTransactionId, txs.map((t) => t.id))));
}

async function importPurchase(db: DB, ctx: Ctx, customer: CustomerRow, cu: ImportCustomer, p: ImportPurchase, notes: string[]) {
  const { projectId, now } = ctx;
  const N = schema.nonSubscriptions;
  const product = ctx.products.find((x) => x.storeIdentifier === p.product_identifier && (!p.app_id || x.appId === p.app_id));
  const refundedAt = p.status === "refunded" ? d(p.refunded_at) ?? new Date(p.purchased_at) : null;
  const v: VerifiedOneTime = {
    kind: "non_subscription", store: p.store as Store, productIdentifier: p.product_identifier, storeTransactionId: p.store_purchase_identifier,
    isSandbox: p.environment === "sandbox", isConsumable: p.consumable ?? product?.type === "consumable", purchaseDate: new Date(p.purchased_at),
    refundedAt, price: p.price ?? null, countryCode: p.country ? p.country.toUpperCase() : null,
  };
  const where = and(eq(N.projectId, projectId), eq(N.store, p.store), eq(N.storeTransactionId, p.store_purchase_identifier));
  const [existing] = await db.select().from(N).where(where).limit(1);
  if (existing && existing.customerId !== customer.id) notes.push(`${p.store} purchase ${p.store_purchase_identifier} moved from another customer to ${cu.id}.`);
  if (ctx.emit) {
    await applyPurchases(db, customer, [v], { projectId, appId: p.app_id ?? null, appUserId: cu.id, now, fromDevice: false });
    return;
  }
  const revenueUsd = p.revenue_usd ?? (p.price?.currency === "USD" ? p.price.amount : null);
  const values = {
    projectId, customerId: customer.id, appId: p.app_id ?? existing?.appId ?? null, store: p.store, productIdentifier: p.product_identifier,
    storeTransactionId: p.store_purchase_identifier, isSandbox: v.isSandbox, isConsumable: v.isConsumable, purchaseDate: v.purchaseDate,
    refundedAt: existing?.refundedAt && refundedAt ? existing.refundedAt : refundedAt, priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null,
    priceUsd: revenueUsd, countryCode: v.countryCode ?? null,
  };
  if (existing) await db.update(N).set(values).where(eq(N.id, existing.id));
  else await db.insert(N).values({ id: newId("", 10), ...values });
  const T = schema.transactions;
  const row = (kind: string, sign: number, at: Date) => ({
    id: newId("txn_", 16), projectId, customerId: customer.id, appId: values.appId, store: p.store, storeTransactionId: p.store_purchase_identifier,
    productIdentifier: p.product_identifier, kind, isSandbox: v.isSandbox, purchasedAt: at, revenueUsd: sign * (revenueUsd ?? 0),
    priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null, countryCode: v.countryCode ?? null,
  });
  await db.insert(T).values(row("one_time", 1, v.purchaseDate)).onConflictDoNothing();
  if (values.refundedAt) await db.insert(T).values(row("refund", -1, values.refundedAt)).onConflictDoNothing();
  await db.update(T).set({ customerId: customer.id }).where(and(eq(T.projectId, projectId), eq(T.store, p.store), eq(T.storeTransactionId, p.store_purchase_identifier)));
}

