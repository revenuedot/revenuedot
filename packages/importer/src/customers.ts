// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: walks RevenueCat's customer list page by page and imports each page into RevenueDot in one batch.
// Docs: https://revenuedot.app/docs/migrate
import { TimeoutError, pool } from "./http.js";
import { toImportCustomer, type ImportCustomer, type RcCustomerBundle, type TokenBook } from "./convert.js";
import type { RevenueCatClient, RcAttribute } from "./revenuecat.js";
import type { RevenueDotClient } from "./revenuedot.js";
import { addProblem, type CatalogMap, type ImportState } from "./state.js";

/** Customers per page (RevenueCat list page and one import call). The import endpoint takes up to 100. */
export const DEFAULT_PAGE_SIZE = 50;

const STORE_TRANSACTIONS = new Set(["app_store", "mac_app_store", "play_store"]);

/** Everything about one customer: 4 calls, plus one per App Store or Play subscription for its transactions. */
export async function fetchBundle(rc: RevenueCatClient, id: string): Promise<RcCustomerBundle> {
  const [customer, aliases, subscriptions, purchases] = await Promise.all([rc.customer(id), rc.aliases(id), rc.subscriptions(id), rc.purchases(id)]);
  let attributes: RcAttribute[] = customer.attributes?.items ?? [];
  if (customer.attributes?.next_page) attributes = await rc.attributes(id);
  const withTx = await Promise.all(subscriptions.map(async (s) => (STORE_TRANSACTIONS.has(s.store) ? { ...s, transactions: await rc.transactions(s.id) } : s)));
  return { customer, aliases: aliases.map((a) => a.id), attributes, subscriptions: withTx, purchases };
}

export interface CustomerRunOptions {
  dryRun: boolean;
  concurrency: number;
  pageSize?: number;
  /** Stop after this many customers (for a trial run). */
  limit?: number;
  tokens?: TokenBook;
  emitEvents?: boolean;
  save: () => void;
  log: (m: string) => void;
  progress: (m: string) => void;
}

/**
 * Imports customers from `state.customers.after` onwards. After each page the state file is saved, so a failed run
 * resumes at the page that failed; pages are idempotent on the server, so repeating one is safe.
 */
export async function importCustomers(rc: RevenueCatClient, rd: RevenueDotClient, map: CatalogMap, state: ImportState, o: CustomerRunOptions) {
  const s = state.customers;
  let seen = 0;
  let googleWithoutToken = 0;
  for (;;) {
    const page = await rc.customersPage(s.after, o.pageSize ?? DEFAULT_PAGE_SIZE);
    let items = page.items;
    if (o.limit !== undefined) items = items.slice(0, Math.max(0, o.limit - seen));
    if (!items.length) break;
    const converted: ImportCustomer[] = await pool(items, o.concurrency, async (c) => {
      const out = toImportCustomer(await fetchBundle(rc, c.id), map, o.tokens);
      for (const p of out.problems) addProblem(state.problems, p);
      googleWithoutToken += out.googleWithoutToken;
      return out.customer;
    });
    const subs = converted.reduce((a, c) => a + (c.subscriptions?.length ?? 0), 0);
    const buys = converted.reduce((a, c) => a + (c.purchases?.length ?? 0), 0);
    if (!o.dryRun) {
      let res;
      try {
        res = await rd.importCustomers(converted, { emitEvents: o.emitEvents });
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        const smaller = Math.max(1, Math.floor(items.length / 2));
        throw new Error(`RevenueDot did not finish importing a page of ${items.length} customers within ${Math.round(e.timeoutMs / 1000)} s.`
          + (items.length > 1 ? ` Run the same command again with --page-size ${smaller}: it resumes at this page.` : " Run the same command again: it resumes at this page."));
      }
      for (const r of res.customers) {
        if (r.status === "created") s.created++;
        if (r.status === "merged") s.merged++;
        s.needsTokenRefresh += r.needs_token_refresh;
        for (const n of r.notes) addProblem(state.problems, { kind: "note", message: `${r.id}: ${n}` });
      }
    }
    s.imported += items.length;
    s.subscriptions += subs;
    s.purchases += buys;
    s.pages++;
    s.after = items[items.length - 1]!.id;
    seen += items.length;
    if (!o.dryRun) o.save();
    o.progress(`customers: ${s.imported} ${o.dryRun ? "read" : "imported"} (${s.subscriptions} subscriptions, ${s.purchases} purchases), page ${s.pages}`);
    if (!page.next || (o.limit !== undefined && seen >= o.limit)) break;
  }
  const finished = o.limit === undefined;
  if (finished) s.complete = true;
  if (!o.dryRun) o.save();
  return { googleWithoutToken };
}
