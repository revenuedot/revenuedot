import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { usdValue, type FxFetch } from "./fx.js";

/**
 * Recomputes USD values of rows saved before prices were converted (before migration 0004, or with a currency no source
 * covered then). A row is fixed when its currency is not USD and its USD value is missing, 0, or the raw amount (the old
 * behaviour). Values imported from RevenueCat (revenue_usd) never equal the raw amount, so they are kept. Idempotent:
 * a fixed row no longer matches. Refund and refund-reversal rows use the date of the purchase they reverse.
 */
export interface BackfillTable { table: string; candidates: number; changed: number; noRate: number; samples: string[] }

const needsFix = (amount: number | null, currency: string | null, usd: number | null) =>
  amount !== null && amount !== 0 && !!currency && currency.toUpperCase() !== "USD"
  && (usd === null || usd === 0 || Math.abs(Math.abs(usd) - Math.abs(amount)) < 1e-9);

export async function backfillUsd(db: DB, opts: { apply: boolean; fetch?: FxFetch | null; log?: (line: string) => void } = { apply: false }): Promise<BackfillTable[]> {
  const out: BackfillTable[] = [];
  const convert = (amount: number, currency: string, at: Date) => usdValue(db, { amount, currency }, at, opts.fetch);
  const sample = (t: BackfillTable, line: string) => { if (t.samples.length < 5) t.samples.push(line); };

  for (const [name, T] of [["subscriptions", schema.subscriptions], ["non_subscriptions", schema.nonSubscriptions]] as const) {
    const t: BackfillTable = { table: name, candidates: 0, changed: 0, noRate: 0, samples: [] };
    const rows = await db.select({ id: T.id, amount: T.priceAmount, currency: T.priceCurrency, usd: T.priceUsd, at: T.purchaseDate }).from(T)
      .where(and(isNotNull(T.priceAmount), isNotNull(T.priceCurrency), ne(T.priceCurrency, "USD")));
    for (const r of rows) {
      if (!needsFix(r.amount, r.currency, r.usd)) continue;
      t.candidates++;
      const usd = await convert(r.amount!, r.currency!, r.at);
      if (usd === null) { t.noRate++; continue; }
      if (usd === r.usd) continue;
      t.changed++;
      sample(t, `${r.id}: ${r.currency} ${r.amount} on ${r.at.toISOString().slice(0, 10)}: ${r.usd} -> ${usd} USD`);
      if (opts.apply) await db.update(T).set({ priceUsd: usd }).where(eq(T.id, r.id));
    }
    out.push(t);
  }

  const X = schema.transactions;
  const t: BackfillTable = { table: "transactions", candidates: 0, changed: 0, noRate: 0, samples: [] };
  const rows = await db.select().from(X).where(and(isNotNull(X.priceAmount), isNotNull(X.priceCurrency), ne(X.priceCurrency, "USD"), ne(X.kind, "trial")));
  const reversing = rows.filter((r) => r.kind === "refund" || r.kind === "refund_reversal");
  const originals = reversing.length
    ? await db.select({ projectId: X.projectId, store: X.store, tx: X.storeTransactionId, at: X.purchasedAt }).from(X)
      .where(and(inArray(X.storeTransactionId, [...new Set(reversing.map((r) => r.storeTransactionId))]), inArray(X.kind, ["purchase", "renewal", "one_time"])))
    : [];
  const purchaseDate = (r: typeof rows[number]) =>
    originals.find((o) => o.projectId === r.projectId && o.store === r.store && o.tx === r.storeTransactionId)?.at ?? r.purchasedAt;
  for (const r of rows) {
    if (!needsFix(r.priceAmount, r.priceCurrency, r.revenueUsd)) continue;
    t.candidates++;
    const sign = r.kind === "refund" ? -1 : 1;
    const at = r.kind === "refund" || r.kind === "refund_reversal" ? purchaseDate(r) : r.purchasedAt;
    const usd = await convert(Math.abs(r.priceAmount!), r.priceCurrency!, at);
    if (usd === null) { t.noRate++; continue; }
    const revenue = sign * usd;
    if (revenue === r.revenueUsd) continue;
    t.changed++;
    sample(t, `${r.id} (${r.kind}): ${r.priceCurrency} ${r.priceAmount} on ${at.toISOString().slice(0, 10)}: ${r.revenueUsd} -> ${revenue} USD`);
    if (opts.apply) await db.update(X).set({ revenueUsd: revenue }).where(eq(X.id, r.id));
  }
  out.push(t);
  for (const x of out) {
    opts.log?.(`${x.table}: ${x.candidates} to check, ${x.changed} ${opts.apply ? "updated" : "would change"}, ${x.noRate} without a rate`);
    for (const s of x.samples) opts.log?.(`  ${s}`);
  }
  return out;
}
