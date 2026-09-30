// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: turns one RevenueCat customer (API v2 objects) into the RevenueDot import payload. Pure, no I/O.
// Docs: https://revenuedot.app/docs/migrate
import type { RcAttribute, RcCustomer, RcPurchase, RcSubscription, RcTransaction } from "./revenuecat.js";
import type { CatalogMap, Problem } from "./state.js";

/** The body of `POST /v2/projects/{id}/import/customers` (one customer). Mirrors apps/server/src/routes/v2/import.ts. */
export interface ImportCustomer {
  id: string;
  aliases?: string[];
  first_seen_at?: number | null;
  last_seen_at?: number | null;
  last_seen_app_version?: string | null;
  last_seen_country?: string | null;
  last_seen_platform?: string | null;
  attributes?: { name: string; value: string | null; updated_at?: number }[];
  subscriptions?: ImportSubscription[];
  purchases?: ImportPurchase[];
}

export interface ImportSubscription {
  source_id?: string;
  app_id?: string | null;
  store: string;
  product_identifier: string;
  environment: "production" | "sandbox";
  ownership: "purchased" | "family_shared";
  starts_at: number;
  current_period_starts_at: number;
  current_period_ends_at: number | null;
  status: string;
  auto_renewal_status?: string;
  store_subscription_identifier: string;
  original_transaction_id?: string | null;
  purchase_token?: string | null;
  country?: string | null;
  price?: { amount: number; currency: string } | null;
  total_revenue_usd?: number | null;
  grace_period_expires_at?: number | null;
  entitlement_lookup_keys?: string[];
  transactions?: { id: string; purchased_at: number; expires_at?: number | null; revenue_usd?: number | null; price?: { amount: number; currency: string } | null }[];
}

export interface ImportPurchase {
  source_id?: string;
  app_id?: string | null;
  store: string;
  product_identifier: string;
  environment: "production" | "sandbox";
  purchased_at: number;
  store_purchase_identifier: string;
  status: "owned" | "refunded";
  consumable?: boolean;
  price?: { amount: number; currency: string } | null;
  revenue_usd?: number | null;
  country?: string | null;
}

/** Everything the importer fetched about one RevenueCat customer. */
export interface RcCustomerBundle {
  customer: RcCustomer;
  aliases: string[];
  attributes: RcAttribute[];
  subscriptions: (RcSubscription & { transactions?: RcTransaction[] })[];
  purchases: RcPurchase[];
}

/** Google purchase tokens from a RevenueCat support export: by order id, or by app user id + product id. */
export interface TokenBook { byOrder: Map<string, string>; byUserProduct: Map<string, string> }

const STORES = new Set(["app_store", "mac_app_store", "play_store", "amazon", "stripe", "rc_billing", "promotional", "external", "paddle", "test_store", "roku", "galaxy"]);
const baseOrderId = (orderId: string) => orderId.replace(/\.\.\d+$/, "");

export function toImportCustomer(b: RcCustomerBundle, map: CatalogMap, tokens?: TokenBook): { customer: ImportCustomer; problems: Problem[]; googleWithoutToken: number } {
  const problems: Problem[] = [];
  let googleWithoutToken = 0;
  const c = b.customer;
  const activeUntil = new Map((c.active_entitlements?.items ?? []).map((e) => [e.entitlement_id, e.expires_at]));
  const ids = [c.id, ...b.aliases];

  const subscriptions: ImportSubscription[] = [];
  for (const s of b.subscriptions) {
    let store = s.store;
    if (!STORES.has(store)) {
      problems.push({ kind: "note", message: `Subscription ${s.id} (${c.id}) is from store "${store}", imported as "external".` });
      store = "external";
    }
    const entKeys = (s.entitlements?.items ?? []).map((e) => e.lookup_key ?? map.entitlements[e.id]?.lookupKey).filter((x): x is string => !!x);
    let product: string;
    let appId: string | null = null;
    if (store === "promotional" || !s.product_id) {
      if (!entKeys.length) { problems.push({ kind: "skipped", message: `Subscription ${s.id} (${c.id}) has no product and no entitlement.` }); continue; }
      product = `rc_promo_${entKeys[0]}_custom`;
      store = store === "promotional" ? store : "promotional";
    } else {
      const p = map.products[s.product_id];
      if (!p) { problems.push({ kind: "skipped", message: `Subscription ${s.id} (${c.id}) is for product ${s.product_id}, which is not in the imported catalog.` }); continue; }
      product = p.storeIdentifier;
      appId = p.appId;
    }
    if (store === "rc_billing") {
      problems.push({ kind: "note", message: `Subscription ${s.id} (${c.id}) is billed by RevenueCat Billing: access is imported, but renewals stay with RevenueCat.` });
    }
    const txs = [...(s.transactions ?? [])].sort((a, z) => a.purchased_at - z.purchased_at);
    const last = txs[txs.length - 1];
    const local = last?.revenue_in_local_currency;
    let original: string | null = null;
    if (store === "app_store" || store === "mac_app_store") original = txs[0]?.id ?? null;
    if (store === "play_store") original = baseOrderId(txs[0]?.id ?? s.store_subscription_identifier);
    let token: string | null = null;
    if (store === "play_store" && tokens) {
      token = tokens.byOrder.get(s.store_subscription_identifier) ?? tokens.byOrder.get(original!) ?? null;
      if (!token) for (const id of ids) { token = tokens.byUserProduct.get(`${id}|${product}`) ?? tokens.byUserProduct.get(`${id}|${product.split(":")[0]}`) ?? null; if (token) break; }
    }
    // In a grace period the entitlement runs past the period end; RevenueCat reports that end on the entitlement and the transaction.
    let grace: number | null = null;
    if (s.status === "in_grace_period") {
      const fromEnts = (s.entitlements?.items ?? []).map((e) => activeUntil.get(e.id) ?? null).filter((x): x is number => typeof x === "number");
      const fromTxs = txs.map((t) => t.effective_expiration_date ?? 0);
      const best = Math.max(0, ...fromEnts, ...fromTxs);
      grace = best > (s.current_period_ends_at ?? 0) ? best : null;
    }
    subscriptions.push({
      source_id: s.id, app_id: appId, store, product_identifier: product, environment: s.environment, ownership: s.ownership ?? "purchased",
      starts_at: s.starts_at, current_period_starts_at: s.current_period_starts_at, current_period_ends_at: s.current_period_ends_at,
      status: s.status, auto_renewal_status: s.auto_renewal_status, store_subscription_identifier: s.store_subscription_identifier,
      original_transaction_id: original, ...(token ? { purchase_token: token } : {}),
      country: s.country ?? null,
      price: local ? { amount: local.gross, currency: local.currency } : null,
      total_revenue_usd: s.total_revenue_in_usd?.gross ?? null,
      ...(grace ? { grace_period_expires_at: grace } : {}),
      ...(store === "promotional" ? { entitlement_lookup_keys: entKeys } : {}),
      transactions: txs.map((t) => ({
        id: t.id, purchased_at: t.purchased_at, expires_at: t.expiration_date ?? null, revenue_usd: t.revenue_in_usd?.gross ?? null,
        price: t.revenue_in_local_currency ? { amount: t.revenue_in_local_currency.gross, currency: t.revenue_in_local_currency.currency } : null,
      })),
    });
    if (store === "play_store" && !token) googleWithoutToken++;
  }

  const purchases: ImportPurchase[] = [];
  for (const p of b.purchases) {
    const prod = map.products[p.product_id];
    if (!prod) { problems.push({ kind: "skipped", message: `Purchase ${p.id} (${c.id}) is for product ${p.product_id}, which is not in the imported catalog.` }); continue; }
    if ((p.quantity ?? 1) > 1) problems.push({ kind: "note", message: `Purchase ${p.id} (${c.id}) has quantity ${p.quantity}; RevenueDot records one purchase.` });
    purchases.push({
      source_id: p.id, app_id: prod.appId, store: STORES.has(p.store) ? p.store : "external", product_identifier: prod.storeIdentifier,
      environment: p.environment, purchased_at: p.purchased_at, store_purchase_identifier: p.store_purchase_identifier,
      status: p.status === "refunded" ? "refunded" : "owned", consumable: prod.type === "consumable",
      revenue_usd: p.revenue_in_usd?.gross ?? null, country: p.country ?? null,
    });
  }

  const attributes = b.attributes.filter((a) => a.value !== null && a.value !== undefined).map((a) => ({ name: a.name, value: a.value, ...(a.updated_at ? { updated_at: a.updated_at } : {}) }));
  return {
    customer: {
      id: c.id, aliases: b.aliases.filter((a) => a !== c.id), first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at ?? null,
      last_seen_app_version: c.last_seen_app_version ?? null, last_seen_country: c.last_seen_country ?? null, last_seen_platform: c.last_seen_platform ?? null,
      attributes, subscriptions, purchases,
    },
    problems,
    googleWithoutToken,
  };
}

/**
 * Reads a CSV of Google purchase tokens (RevenueCat's support export or your own records). Columns, in any order:
 * `purchase_token` (or `token`), plus `order_id`, or `app_user_id` and `product_id`.
 */
export function parseTokenCsv(text: string): TokenBook {
  const book: TokenBook = { byOrder: new Map(), byUserProduct: new Map() };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return book;
  const split = (l: string) => l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const tok = col("purchase_token", "token", "fetch_token");
  const order = col("order_id", "orderid", "store_transaction_id", "store_subscription_identifier");
  const user = col("app_user_id", "rc_original_app_user_id", "customer_id");
  const prod = col("product_id", "product_identifier");
  if (tok < 0) throw new Error("The token CSV needs a purchase_token (or token) column.");
  for (const l of lines.slice(1)) {
    const v = split(l);
    const t = v[tok];
    if (!t) continue;
    if (order >= 0 && v[order]) { book.byOrder.set(v[order]!, t); book.byOrder.set(baseOrderId(v[order]!), t); }
    if (user >= 0 && prod >= 0 && v[user] && v[prod]) book.byUserProduct.set(`${v[user]}|${v[prod]}`, t);
  }
  return book;
}
