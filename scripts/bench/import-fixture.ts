// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a deterministic page of customers for POST /v2/projects/{id}/import/customers, shaped like a real
// RevenueCat export (anonymous aliases, SDK attributes, App Store and Play subscriptions with renewal history, purchases).
// Used by scripts/bench/import-page.ts and the import journey. Docs: https://revenuedot.app/docs/migrate

const DAY = 86_400_000;

/** A small seeded random generator, so every run imports the same page. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export interface FixtureApps { ios: string; play: string }

/**
 * `n` customers starting at index `from`. Every customer has one or two aliases and 4 to 8 attributes; about 60 % have
 * an App Store subscription with 1 to 12 transactions, 10 % a Play subscription, 10 % a one-time purchase, 5 % a
 * promotional grant. `now` anchors the dates.
 */
export function importPage(apps: FixtureApps, o: { n?: number; from?: number; now?: number; seed?: number; prefix?: string } = {}) {
  const n = o.n ?? 100, from = o.from ?? 0, now = o.now ?? Date.UTC(2026, 9, 1), prefix = o.prefix ?? "bench";
  const r = rng(o.seed ?? 42);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const hex = (len: number) => Array.from({ length: len }, () => Math.floor(r() * 16).toString(16)).join("");
  const customers = [];
  for (let i = from; i < from + n; i++) {
    const id = `${prefix}_user_${i}`;
    const firstSeen = now - Math.floor(r() * 400) * DAY;
    const aliases = [`$RCAnonymousID:${hex(32)}`, ...(r() < 0.3 ? [`$RCAnonymousID:${hex(32)}`] : [])];
    const attrNames = ["$email", "$displayName", "$attConsentStatus", "$idfv", "$ip", "$appsflyerId", "plan_hint", "onboarding_step"];
    const attributes = attrNames.slice(0, 4 + Math.floor(r() * 5)).map((name) => ({ name, value: `${name}-${i}-${hex(6)}`, updated_at: firstSeen + Math.floor(r() * 30) * DAY }));
    const subscriptions: any[] = [];
    const purchases: any[] = [];
    if (r() < 0.6) {
      const months = 1 + Math.floor(r() * 12);
      const start = now - months * 30 * DAY + Math.floor(r() * 20) * DAY;
      const base = 2_000_000_000_000 + i * 1000;
      const txs = Array.from({ length: months }, (_, m) => ({ id: String(base + m), purchased_at: start + m * 30 * DAY, expires_at: start + (m + 1) * 30 * DAY, revenue_usd: 9.99, price: { amount: 9.99, currency: "USD" } }));
      const last = txs[txs.length - 1]!;
      const active = last.expires_at > now;
      subscriptions.push({
        source_id: `sub_rc_${i}`, app_id: apps.ios, store: "app_store", product_identifier: pick(["pro_monthly", "pro_annual"]), environment: "production",
        starts_at: start, current_period_starts_at: last.purchased_at, current_period_ends_at: last.expires_at,
        status: active ? "active" : "expired", auto_renewal_status: active ? pick(["will_renew", "will_renew", "will_not_renew"]) : "will_not_renew",
        store_subscription_identifier: last.id, original_transaction_id: txs[0]!.id, country: pick(["US", "DE", "JP", "GB"]),
        price: { amount: 9.99, currency: "USD" }, total_revenue_usd: 9.99 * months, transactions: txs,
      });
    }
    if (r() < 0.1) {
      const start = now - 20 * DAY;
      subscriptions.push({
        source_id: `sub_rc_g${i}`, app_id: apps.play, store: "play_store", product_identifier: "pro:monthly", starts_at: start, current_period_starts_at: start,
        current_period_ends_at: start + 30 * DAY, status: "active", auto_renewal_status: "will_renew", store_subscription_identifier: `GPA.${1000 + i}-0000-0000-00000`,
        transactions: [{ id: `GPA.${1000 + i}-0000-0000-00000`, purchased_at: start, revenue_usd: 4.99 }],
      });
    }
    if (r() < 0.05) {
      subscriptions.push({
        source_id: `sub_rc_p${i}`, store: "promotional", product_identifier: "rc_promo_pro_monthly", starts_at: now - 5 * DAY, current_period_starts_at: now - 5 * DAY,
        current_period_ends_at: now + 25 * DAY, status: "active", store_subscription_identifier: `promo_${i}`, entitlement_lookup_keys: ["pro"],
      });
    }
    if (r() < 0.1) {
      purchases.push({ app_id: apps.ios, store: "app_store", product_identifier: pick(["lifetime", "coins_100"]), purchased_at: now - Math.floor(r() * 100) * DAY,
        store_purchase_identifier: String(3_000_000_000_000 + i), status: r() < 0.2 ? "refunded" : "owned", price: { amount: 4.99, currency: "USD" } });
    }
    customers.push({
      id, aliases, first_seen_at: firstSeen, last_seen_at: firstSeen + Math.floor(r() * 30) * DAY, last_seen_platform: "iOS", last_seen_country: "US",
      last_seen_app_version: "3.2.1", attributes, subscriptions, purchases,
    });
  }
  return customers;
}

/** What the page holds, for reports. */
export function pageStats(customers: ReturnType<typeof importPage>) {
  const subs = customers.flatMap((c) => c.subscriptions);
  return {
    customers: customers.length,
    aliases: customers.reduce((a, c) => a + c.aliases.length, 0),
    attributes: customers.reduce((a, c) => a + c.attributes.length, 0),
    subscriptions: subs.length,
    transactions: subs.reduce((a, s) => a + (s.transactions?.length ?? 0), 0),
    purchases: customers.reduce((a, c) => a + c.purchases.length, 0),
  };
}
