// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `revenuedot import verify`, which compares access per customer and totals between RevenueCat and RevenueDot.
// Docs: https://revenuedot.app/docs/migrate
import { HttpError, pool } from "./http.js";
import type { RevenueCatClient } from "./revenuecat.js";
import type { RevenueDotClient } from "./revenuedot.js";

export interface Mismatch {
  customer: string;
  kind: "missing_customer" | "entitlement_only_in_revenuecat" | "entitlement_only_in_revenuedot" | "entitlement_expiry" | "active_subscriptions";
  detail: string;
}

export interface VerifyReport {
  customers: { revenuecat: number; revenuedot: number; checked: number };
  activeSubscriptions: { revenuecat: number; revenuedot: number };
  activeEntitlements: { revenuecat: number; revenuedot: number };
  mismatches: Mismatch[];
  mismatchedCustomers: number;
}

export interface VerifyOptions {
  concurrency: number;
  /** Check only the first N customers (the totals still count everyone). */
  limit?: number;
  /** Expiry differences up to this many ms are equal (default 1 s: stores round to the second). */
  toleranceMs?: number;
  progress?: (m: string) => void;
}

const fmt = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());

/**
 * For every RevenueCat customer: the set of active entitlements (by lookup key), each one's expiry, and the number of
 * subscriptions that give access now, against the same customer in RevenueDot. Totals compare customer counts too.
 */
export async function verifyImport(rc: RevenueCatClient, rd: RevenueDotClient, o: VerifyOptions): Promise<VerifyReport> {
  const tolerance = o.toleranceMs ?? 1000;
  const rcEnts = new Map((await rc.entitlements()).map((e) => [e.id, e.lookup_key]));
  const rdEnts = new Map((await rd.entitlements()).map((e) => [e.id, e.lookup_key]));
  const report: VerifyReport = {
    customers: { revenuecat: 0, revenuedot: 0, checked: 0 }, activeSubscriptions: { revenuecat: 0, revenuedot: 0 },
    activeEntitlements: { revenuecat: 0, revenuedot: 0 }, mismatches: [], mismatchedCustomers: 0,
  };
  const bad = new Set<string>();
  const add = (m: Mismatch) => { report.mismatches.push(m); bad.add(m.customer); };

  let after: string | null = null;
  for (;;) {
    const page: Awaited<ReturnType<RevenueCatClient["customersPage"]>> = await rc.customersPage(after);
    if (!page.items.length) break;
    report.customers.revenuecat += page.items.length;
    const todo = o.limit === undefined ? page.items : page.items.slice(0, Math.max(0, o.limit - report.customers.checked));
    await pool(todo, o.concurrency, async ({ id }) => {
      const [rcCustomer, rcSubs] = await Promise.all([rc.customer(id), rc.subscriptions(id)]);
      let rdCustomer: Awaited<ReturnType<RevenueDotClient["customer"]>>;
      let rdSubs: Awaited<ReturnType<RevenueDotClient["subscriptions"]>>;
      try {
        [rdCustomer, rdSubs] = await Promise.all([rd.customer(id), rd.subscriptions(id)]);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) { add({ customer: id, kind: "missing_customer", detail: "not found in RevenueDot" }); return; }
        throw e;
      }
      const a = new Map((rcCustomer.active_entitlements?.items ?? []).map((x) => [rcEnts.get(x.entitlement_id) ?? x.entitlement_id, x.expires_at]));
      const b = new Map((rdCustomer.active_entitlements?.items ?? []).map((x) => [rdEnts.get(x.entitlement_id) ?? x.entitlement_id, x.expires_at]));
      report.activeEntitlements.revenuecat += a.size;
      report.activeEntitlements.revenuedot += b.size;
      for (const [key, exp] of a) {
        if (!b.has(key)) add({ customer: id, kind: "entitlement_only_in_revenuecat", detail: `${key} active until ${fmt(exp)} in RevenueCat, not active in RevenueDot` });
        else {
          const other = b.get(key)!;
          if ((exp === null) !== (other === null) || (exp !== null && other !== null && Math.abs(exp - other) > tolerance)) {
            add({ customer: id, kind: "entitlement_expiry", detail: `${key} expires ${fmt(exp)} in RevenueCat, ${fmt(other)} in RevenueDot` });
          }
        }
      }
      for (const [key, exp] of b) if (!a.has(key)) add({ customer: id, kind: "entitlement_only_in_revenuedot", detail: `${key} active until ${fmt(exp)} in RevenueDot, not active in RevenueCat` });
      const rcActive = rcSubs.filter((s) => s.gives_access).length;
      const rdActive = rdSubs.filter((s) => s.gives_access).length;
      report.activeSubscriptions.revenuecat += rcActive;
      report.activeSubscriptions.revenuedot += rdActive;
      if (rcActive !== rdActive) add({ customer: id, kind: "active_subscriptions", detail: `${rcActive} subscription(s) give access in RevenueCat, ${rdActive} in RevenueDot` });
    });
    report.customers.checked += todo.length;
    o.progress?.(`verify: ${report.customers.checked} customers checked, ${bad.size} with differences`);
    after = page.items[page.items.length - 1]!.id;
    if (!page.next) break;
  }
  // RevenueDot's own count (it can be higher: customers created by live traffic since the import).
  let rdAfter: string | null = null;
  for (;;) {
    const p = await rd.customersPage(rdAfter);
    report.customers.revenuedot += p.items.length;
    if (!p.next_page || !p.items.length) break;
    rdAfter = new URL(p.next_page, rd.base).searchParams.get("starting_after");
  }
  report.mismatchedCustomers = bad.size;
  report.mismatches.sort((x, y) => x.customer.localeCompare(y.customer) || x.kind.localeCompare(y.kind));
  return report;
}
