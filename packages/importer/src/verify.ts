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
  customers: {
    /** Unique customer ids RevenueCat lists, and RevenueDot's (live traffic can add some since the import). */
    revenuecat: number; revenuedot: number; checked: number;
    /** RevenueCat customers RevenueDot does not know, by id or alias. */
    missingInRevenueDot: number;
    /** RevenueDot customers RevenueCat does not know by id (merged or deleted there, or created by live traffic since). */
    onlyInRevenueDot: number;
    /** RevenueCat customers its list left out, found by id from RevenueDot's side (counted in `revenuecat` and checked). */
    notListedByRevenueCat: number;
  };
  /** Ids behind `onlyInRevenueDot` (the RevenueCat side is in `mismatches` as missing_customer). Empty with --limit. */
  onlyInRevenueDot: string[];
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
 * Every unique customer id of a paginated list. RevenueCat orders its list by activity, so a customer that is active
 * during a long walk can move and turn up again; listing ids only takes minutes, and the set drops repeats.
 */
export async function listCustomerIds(next: (after: string | null) => Promise<{ ids: string[]; more: boolean }>, progress?: (n: number) => void): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = await next(after);
    if (!page.ids.length) break;
    for (const id of page.ids) ids.add(id);
    progress?.(ids.size);
    if (!page.more) break;
    after = page.ids[page.ids.length - 1]!;
  }
  return ids;
}

export const revenueCatIds = (rc: RevenueCatClient, progress?: (n: number) => void) =>
  listCustomerIds(async (after) => { const p = await rc.customersPage(after); return { ids: p.items.map((c) => c.id), more: !!p.next }; }, progress);

export const revenueDotIds = (rd: RevenueDotClient, progress?: (n: number) => void) =>
  listCustomerIds(async (after) => { const p = await rd.customersPage(after); return { ids: p.items.map((c) => c.id), more: !!p.next_page }; }, progress);

/**
 * For every RevenueCat customer, checked once: the set of active entitlements (by lookup key), each one's expiry, and
 * the number of subscriptions that give access now, against the same customer in RevenueDot. Customer ids are listed
 * first on both sides, so the counts are of unique customers and missing ones are named.
 */
export async function verifyImport(rc: RevenueCatClient, rd: RevenueDotClient, o: VerifyOptions): Promise<VerifyReport> {
  const tolerance = o.toleranceMs ?? 1000;
  const rcEnts = new Map((await rc.entitlements()).map((e) => [e.id, e.lookup_key]));
  const rdEnts = new Map((await rd.entitlements()).map((e) => [e.id, e.lookup_key]));
  const rcIds = await revenueCatIds(rc, (n) => o.progress?.(`verify: listing RevenueCat customers, ${n} so far`));
  const rdIds = await revenueDotIds(rd, (n) => o.progress?.(`verify: listing RevenueDot customers, ${n} so far`));
  const report: VerifyReport = {
    customers: { revenuecat: rcIds.size, revenuedot: rdIds.size, checked: 0, missingInRevenueDot: 0, onlyInRevenueDot: 0, notListedByRevenueCat: 0 },
    onlyInRevenueDot: [],
    activeSubscriptions: { revenuecat: 0, revenuedot: 0 },
    activeEntitlements: { revenuecat: 0, revenuedot: 0 }, mismatches: [], mismatchedCustomers: 0,
  };
  const bad = new Set<string>();
  const add = (m: Mismatch) => { report.mismatches.push(m); bad.add(m.customer); };

  /** RevenueDot ids the RevenueCat customers resolved to (a merged customer is listed under one id, found by any alias). */
  const matched = new Set<string>();
  const all = [...rcIds];
  const todo = o.limit === undefined ? all : all.slice(0, Math.max(0, o.limit));
  const PAGE = 100;
  /** Compares one customer; "no_revenuecat" when RevenueCat answers 404 for the id. */
  const checkOne = async (id: string): Promise<"ok" | "no_revenuecat" | "no_revenuedot"> => {
      let rdCustomer: Awaited<ReturnType<RevenueDotClient["customer"]>>;
      let rdSubs: Awaited<ReturnType<RevenueDotClient["subscriptions"]>>;
      try {
        // Also by alias: a customer the import merged into another one is found under its RevenueCat id.
        [rdCustomer, rdSubs] = await Promise.all([rd.customer(id), rd.subscriptions(id)]);
        matched.add(rdCustomer.id);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          report.customers.missingInRevenueDot++;
          add({ customer: id, kind: "missing_customer", detail: "not found in RevenueDot" });
          return "no_revenuedot";
        }
        throw e;
      }
      let rcCustomer: Awaited<ReturnType<RevenueCatClient["customer"]>>;
      let rcSubs: Awaited<ReturnType<RevenueCatClient["subscriptions"]>>;
      try {
        [rcCustomer, rcSubs] = await Promise.all([rc.customer(id), rc.subscriptions(id)]);
      } catch (e) {
        // Deleted or merged in RevenueCat after it was listed: nothing to compare.
        if (e instanceof HttpError && e.status === 404) return "no_revenuecat";
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
      return "ok";
  };
  for (let i = 0; i < todo.length; i += PAGE) {
    await pool(todo.slice(i, i + PAGE), o.concurrency, checkOne);
    report.customers.checked = Math.min(todo.length, i + PAGE);
    o.progress?.(`verify: ${report.customers.checked} of ${todo.length} customers checked, ${bad.size} with differences`);
  }
  if (o.limit === undefined) {
    // RevenueCat's list does not return every customer (SuperScan, 2026-10-02: 32,045 listed, thousands more found by
    // id). A RevenueDot customer RevenueCat does not list is looked up by id there and, when it exists, checked too.
    const extra = [...rdIds].filter((id) => !rcIds.has(id) && !matched.has(id));
    const only: string[] = [];
    for (let i = 0; i < extra.length; i += PAGE) {
      const part = extra.slice(i, i + PAGE);
      const res = await pool(part, o.concurrency, checkOne);
      res.forEach((r, j) => { if (r === "no_revenuecat") only.push(part[j]!); else report.customers.notListedByRevenueCat++; });
      o.progress?.(`verify: ${Math.min(extra.length, i + PAGE)} of ${extra.length} customers RevenueCat does not list checked by id`);
    }
    report.customers.checked += report.customers.notListedByRevenueCat;
    report.customers.revenuecat += report.customers.notListedByRevenueCat;
    report.onlyInRevenueDot = only.sort();
    report.customers.onlyInRevenueDot = only.length;
  }
  report.mismatchedCustomers = bad.size;
  report.mismatches.sort((x, y) => x.customer.localeCompare(y.customer) || x.kind.localeCompare(y.kind));
  return report;
}
