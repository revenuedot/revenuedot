import type { AttributionDim } from "../attribution.js";
import { Prepared } from "./compute.js";
import type { ChartInput, ChartTx } from "./model.js";
import { DAY, dayStart } from "./time.js";

/**
 * Revenue by campaign (prd/attribution-benchmarks-insights §1): customers whose cohort date (the earlier of first seen and
 * first transaction, as in the charts) falls in [from, to), grouped by one attribution dimension, with what they did
 * since: trial starts, paying customers, and revenue on day 0, by day 7, by day 30 and to date. Revenue is purchases and
 * renewals minus refunds recorded in the window, in the input's currency (USD), ads excluded. A day-N window is
 * "day 0 through day N" from the calendar day of the cohort date, like the LTV charts.
 */

export interface AttributionReportRow {
  /** The dimension's value; "" is customers without one. */
  key: string;
  customers: number;
  trial_starts: number;
  paying_customers: number;
  /** Paying customers ÷ customers, in %. */
  conversion_to_paying: number | null;
  revenue_day_0: number;
  revenue_day_7: number;
  revenue_day_30: number;
  revenue_to_date: number;
  revenue_per_customer: number | null;
  revenue_per_paying_customer: number | null;
  /** Some customers' day-7 (day-30) window has not closed yet, so the figure can still grow. */
  day_7_incomplete: boolean;
  day_30_incomplete: boolean;
}

export interface AttributionReportOptions {
  from: number;
  to: number;
  groupBy: AttributionDim;
  /** Only customers with this media source ("" = without one). */
  mediaSource?: string | null;
}

const PAID = new Set(["purchase", "renewal", "one_time"]);
const windowEnd = (t: number, days: number) => dayStart(t) + (days + 1) * DAY;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function attributionReport(input: ChartInput, o: AttributionReportOptions): { rows: AttributionReportRow[]; total: AttributionReportRow } {
  const d = new Prepared(input);
  const now = input.now;
  const byId = new Map(input.customers.map((c) => [c.id, c]));
  const revenue = (txs: ChartTx[], from: number, to: number) =>
    txs.reduce((s, t) => (t.at >= from && t.at < to && t.at <= now && t.kind !== "trial" ? s + d.money(t) : s), 0);

  const blank = (key: string): AttributionReportRow => ({
    key, customers: 0, trial_starts: 0, paying_customers: 0, conversion_to_paying: null, revenue_day_0: 0, revenue_day_7: 0, revenue_day_30: 0,
    revenue_to_date: 0, revenue_per_customer: null, revenue_per_paying_customer: null, day_7_incomplete: false, day_30_incomplete: false,
  });
  const groups = new Map<string, AttributionReportRow>();
  const total = blank("");
  for (const [id, at] of d.cohortDate) {
    if (at < o.from || at >= o.to) continue;
    const attribution = byId.get(id)?.attribution;
    if (o.mediaSource !== undefined && o.mediaSource !== null && (attribution?.media_source ?? "") !== o.mediaSource) continue;
    const key = attribution?.[o.groupBy] ?? "";
    const g = groups.get(key) ?? groups.set(key, blank(key)).get(key)!;
    const txs = d.txsOf(id);
    const start = dayStart(at);
    const first = txs.find((t) => PAID.has(t.kind));
    const refunded = first ? d.refundedAt(first) : undefined;
    const paying = !!first && first.at <= now && !(refunded !== undefined && refunded <= now);
    const add = (row: AttributionReportRow) => {
      row.customers++;
      if (txs.some((t) => t.kind === "trial")) row.trial_starts++;
      if (paying) row.paying_customers++;
      row.revenue_day_0 += revenue(txs, start, windowEnd(at, 0));
      row.revenue_day_7 += revenue(txs, start, windowEnd(at, 7));
      row.revenue_day_30 += revenue(txs, start, windowEnd(at, 30));
      row.revenue_to_date += revenue(txs, start, Infinity);
      if (windowEnd(at, 7) > now) row.day_7_incomplete = true;
      if (windowEnd(at, 30) > now) row.day_30_incomplete = true;
    };
    add(g);
    add(total);
  }
  const finish = (r: AttributionReportRow): AttributionReportRow => ({
    ...r,
    revenue_day_0: r2(r.revenue_day_0), revenue_day_7: r2(r.revenue_day_7), revenue_day_30: r2(r.revenue_day_30), revenue_to_date: r2(r.revenue_to_date),
    conversion_to_paying: r.customers ? Math.round((r.paying_customers / r.customers) * 1000) / 10 : null,
    revenue_per_customer: r.customers ? r2(r.revenue_to_date / r.customers) : null,
    revenue_per_paying_customer: r.paying_customers ? r2(r.revenue_to_date / r.paying_customers) : null,
  });
  const rows = [...groups.values()].map(finish)
    .sort((a, b) => b.revenue_to_date - a.revenue_to_date || b.customers - a.customers || (a.key === "" ? 1 : b.key === "" ? -1 : a.key.localeCompare(b.key)));
  return { rows, total: finish(total) };
}
