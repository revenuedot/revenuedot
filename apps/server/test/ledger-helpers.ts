// Seeds a project's production history straight into the tables the charts read (customers, attributes, transactions),
// for the benchmark and insights tests (prd/attribution-benchmarks-insights). Deterministic: the same options give the
// same rows. The purchase pipeline itself is covered by the contract tests; here only the numbers matter.
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { setAttributes } from "../src/repo/customers.js";

const DAY = 86_400_000;

export interface LedgerOptions {
  projectId: string;
  /** New customers per month, over `months` months ending the month before `now`. */
  perMonth: number;
  months?: number;
  now: Date;
  /** Every n-th customer starts a 7-day trial; `convertEvery` of those convert to $`monthlyPrice` monthly. */
  trialEvery?: number;
  convertEvery?: number;
  monthlyPrice?: number;
  /** Every n-th of the rest buys an annual subscription at $`annualPrice` on day 0. */
  annualEvery?: number;
  annualPrice?: number;
  /** Every n-th annual purchase is refunded on day 2. */
  refundEvery?: number;
  platform?: (i: number) => string;
  country?: (i: number) => string;
  /** Attribution attributes for customer i (set through setAttributes, so customer_attribution follows). */
  attribution?: (i: number) => Record<string, string> | null;
}

/** Creates an App Store app with monthly and annual products, then the history. Returns the app id and customer ids. */
export async function seedLedger(db: DB, o: LedgerOptions) {
  const appId = newId("app_", 10);
  await db.insert(schema.apps).values({ id: appId, projectId: o.projectId, name: "iOS", type: "app_store", bundleId: `com.example.${appId}`, publicKey: `appl_${appId}` });
  await db.insert(schema.products).values([
    { id: newId("prod_", 10), projectId: o.projectId, appId, storeIdentifier: "monthly", type: "subscription", duration: "P1M", displayName: "Monthly" },
    { id: newId("prod_", 10), projectId: o.projectId, appId, storeIdentifier: "annual", type: "subscription", duration: "P1Y", displayName: "Annual" },
  ]);
  const months = o.months ?? 12;
  const end = Date.UTC(o.now.getUTCFullYear(), o.now.getUTCMonth(), 1);
  const customers: string[] = [];
  const txs: (typeof schema.transactions.$inferInsert)[] = [];
  const cust: (typeof schema.customers.$inferInsert)[] = [];
  let i = 0;
  for (let m = months; m >= 1; m--) {
    const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - m);
    const month = d.getTime();
    for (let k = 0; k < o.perMonth; k++, i++) {
      const id = `cus_${o.projectId}_${i}`;
      const at = month + Math.floor(((k + 0.5) / o.perMonth) * 25 * DAY);
      if (at >= o.now.getTime()) continue;
      customers.push(id);
      cust.push({ id, projectId: o.projectId, originalAppUserId: `user_${i}`, firstSeen: new Date(at), lastSeen: new Date(at), lastSeenPlatform: o.platform?.(i) ?? "iOS", lastSeenCountry: o.country?.(i) ?? "US" });
      const tx = (kind: string, t: number, days: number | null, usd: number, product: string, storeTx = `${id}-${kind}-${t}`) => txs.push({
        id: newId("txn_", 14), projectId: o.projectId, customerId: id, appId, store: "app_store", storeTransactionId: storeTx, productIdentifier: product, kind,
        isSandbox: false, purchasedAt: new Date(t), expiresAt: days === null ? null : new Date(t + days * DAY), revenueUsd: usd, priceAmount: usd, priceCurrency: "USD", countryCode: o.country?.(i) ?? "US",
      });
      if (o.trialEvery && i % o.trialEvery === 0) {
        tx("trial", at, 7, 0, "monthly");
        if (o.convertEvery && (i / o.trialEvery) % o.convertEvery === 0) {
          for (let r = 0, t = at + 7 * DAY; r < 3 && t < o.now.getTime(); r++, t += 30 * DAY) tx("renewal", t, 30, o.monthlyPrice ?? 10, "monthly");
        }
      } else if (o.annualEvery && i % o.annualEvery === 0) {
        tx("purchase", at, 365, o.annualPrice ?? 50, "annual", `${id}-annual`);
        if (o.refundEvery && i % (o.annualEvery * o.refundEvery) === 0) tx("refund", at + 2 * DAY, null, -(o.annualPrice ?? 50), "annual", `${id}-annual`);
      }
    }
  }
  for (let j = 0; j < cust.length; j += 500) await db.insert(schema.customers).values(cust.slice(j, j + 500));
  for (let j = 0; j < cust.length; j += 500) await db.insert(schema.customerAliases).values(cust.slice(j, j + 500).map((c) => ({ projectId: o.projectId, appUserId: c.originalAppUserId, customerId: c.id! })));
  for (let j = 0; j < txs.length; j += 500) await db.insert(schema.transactions).values(txs.slice(j, j + 500));
  // One activity day per customer (their first), so ARPU has active customers.
  for (let j = 0; j < cust.length; j += 500) await db.insert(schema.customerActivity).values(cust.slice(j, j + 500).map((c) => ({ projectId: o.projectId, customerId: c.id!, day: c.firstSeen!.toISOString().slice(0, 10) })));
  if (o.attribution) {
    for (let j = 0; j < customers.length; j++) {
      const a = o.attribution(Number(customers[j]!.split("_").pop()));
      if (a) await setAttributes(db, customers[j]!, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { value: v }])), o.now);
    }
  }
  return { appId, customers };
}
