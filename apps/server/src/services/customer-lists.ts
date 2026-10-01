import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { projectContexts, subActive, type LoadedContext } from "./customer-context.js";
import { rulesMatch, type Rules } from "./targeting.js";

/**
 * Customers lists (prd/lifecycle/PRD.md): the built-in lists in the Customers rail, saved audiences, filters from the
 * condition builder, the four summary cards and the CSV export. Lists look at the most recently seen customers (SCAN_LIMIT).
 */

export const BUILT_IN_LISTS = ["all", "active", "sandbox", "non_subscription", "expired"] as const;
export type BuiltInList = (typeof BUILT_IN_LISTS)[number];

const prodSubs = (i: LoadedContext) => i.data.subs.filter((s) => s.store !== "promotional" && !s.isSandbox);

/** Built-in lists: production subscriptions decide Active and Expired; Sandbox is anyone with a sandbox purchase. */
export function inBuiltIn(list: BuiltInList, i: LoadedContext, now: Date): boolean {
  switch (list) {
    case "all": return true;
    case "active": return prodSubs(i).some((s) => subActive(s, now));
    case "sandbox": return i.ctx.hasMadeSandboxPurchase;
    case "non_subscription": return i.data.ones.some((o) => !o.isSandbox);
    case "expired": {
      const subs = prodSubs(i);
      // Subscribers whose every subscription has ended (one-time buyers are in Non-subscription).
      return subs.length > 0 && !subs.some((s) => subActive(s, now));
    }
  }
}

export interface ListRow {
  object: "customer_list_row";
  id: string; customer_uuid: string; email: string | null;
  subscription_status: "active" | "trialing" | "grace_period" | "billing_issue" | "expired" | "none";
  auto_renewal_status: "on" | "off" | null;
  first_seen_at: number; last_seen_at: number; spent_in_usd: number;
  latest_purchase: { product_id: string; store: string; purchased_at: number; environment: "production" | "sandbox" } | null;
  country: string | null; platform: string | null;
}

export function rowOf(i: LoadedContext, now: Date): ListRow {
  const d = i.data;
  const real = d.subs.filter((s) => s.store !== "promotional");
  const active = real.filter((s) => subActive(s, now)).sort((a, b) => (b.expiresDate?.getTime() ?? Infinity) - (a.expiresDate?.getTime() ?? Infinity));
  const lead = active[0];
  let status: ListRow["subscription_status"] = real.length ? "expired" : "none";
  if (lead) {
    const inGrace = !!lead.gracePeriodExpiresDate && lead.gracePeriodExpiresDate > now && (!lead.expiresDate || lead.expiresDate <= now);
    status = inGrace ? "grace_period" : lead.billingIssuesDetectedAt ? "billing_issue" : lead.periodType === "trial" ? "trialing" : "active";
  }
  const purchases = [
    ...real.map((s) => ({ product_id: s.productIdentifier, store: s.store, purchased_at: s.purchaseDate.getTime(), environment: s.isSandbox ? "sandbox" as const : "production" as const })),
    ...d.ones.map((o) => ({ product_id: o.productIdentifier, store: o.store, purchased_at: o.purchaseDate.getTime(), environment: o.isSandbox ? "sandbox" as const : "production" as const })),
  ].sort((a, b) => b.purchased_at - a.purchased_at);
  return {
    object: "customer_list_row", id: d.aliases.find((a) => !a.startsWith("$RCAnonymousID:")) ?? d.customer.originalAppUserId, customer_uuid: d.customer.id,
    email: d.attributes.$email ?? null, subscription_status: status,
    auto_renewal_status: lead ? (lead.unsubscribeDetectedAt ? "off" : "on") : null,
    first_seen_at: d.customer.firstSeen.getTime(), last_seen_at: d.customer.lastSeen.getTime(), spent_in_usd: i.ctx.totalSpent,
    latest_purchase: purchases[0] ?? null, country: d.customer.lastSeenCountry?.toUpperCase() ?? null, platform: d.customer.lastSeenPlatform,
  };
}

export interface ListQuery { list: string; rules?: Rules | null; search?: string | null }

/** Every matching customer (newest last seen first), the summary cards, and whether the scan stopped at the limit. */
export async function queryCustomerList(db: DB, projectId: string, q: ListQuery, now: Date) {
  let builtIn: BuiltInList = "all";
  let audienceRules: Rules | null = null;
  if ((BUILT_IN_LISTS as readonly string[]).includes(q.list)) builtIn = q.list as BuiltInList;
  else {
    const [a] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, q.list))).limit(1);
    if (!a) return null;
    audienceRules = a.rules as Rules;
  }
  const { items, truncated } = await projectContexts(db, projectId, now);
  const s = q.search?.trim().toLowerCase();
  const t = now.getTime();
  const matched = items.filter((i) => inBuiltIn(builtIn, i, now)
    && (!audienceRules || rulesMatch(i.ctx, audienceRules, t))
    && (!q.rules || rulesMatch(i.ctx, q.rules, t))
    && (!s || i.data.aliases.some((a) => a.toLowerCase().includes(s)) || (i.data.attributes.$email ?? "").toLowerCase().includes(s)));
  const rows = matched.map((i) => rowOf(i, now));
  return {
    rows,
    summary: {
      object: "customer_list_summary" as const,
      customers: rows.length,
      // The cards count production subscriptions only, like charts; sandbox testers are in the Sandbox list.
      trialing_subscribers: matched.filter((i) => prodSubs(i).some((x) => subActive(x, now) && x.periodType === "trial")).length,
      paid_subscribers: matched.filter((i) => prodSubs(i).some((x) => subActive(x, now) && x.periodType !== "trial")).length,
      total_revenue_in_usd: Math.round(rows.reduce((x, r) => x + r.spent_in_usd, 0) * 100) / 100,
      is_approximate: truncated,
    },
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");

export function toCsv(rows: ListRow[]): string {
  const head = ["app_user_id", "email", "subscription_status", "auto_renewal_status", "first_seen_at", "last_seen_at", "spent_in_usd", "latest_product_id", "latest_store", "latest_purchase_at", "country", "platform"];
  const lines = rows.map((r) => [r.id, r.email, r.subscription_status, r.auto_renewal_status, iso(r.first_seen_at), iso(r.last_seen_at), r.spent_in_usd.toFixed(2),
    r.latest_purchase?.product_id, r.latest_purchase?.store, iso(r.latest_purchase?.purchased_at), r.country, r.platform].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
