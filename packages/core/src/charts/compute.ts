import { commission } from "../events.js";
import type { Store } from "../types.js";
import { CANCEL_REASONS, type ChartDef, type MeasureDef } from "./catalog.js";
import {
  buildSubscriptions, chainKey, isExcludedStore, moneyOf, paidAt, productIndex, purchaseTimes, refundTimes, subMoves, trialAt,
  type ChartInput, type ChartTx, type Sub, type SubMove,
} from "./model.js";
import { addMonths, buckets, DAY, dayStart, type Bucket, type Resolution } from "./time.js";

export interface ChartRequest {
  resolution: Resolution;
  /** Inclusive start and exclusive end of the requested range (ms). */
  rangeStart: number;
  rangeEnd: number;
  /** Count the whole first period of flow charts (RevenueCat's `expand_periods`). */
  expand: boolean;
  selectors: Record<string, string>;
}

export interface SeriesPoint { start: number; values: (number | null)[]; incomplete: boolean }
export interface SeriesOutput { kind: "series"; measures: MeasureDef[]; points: SeriesPoint[] }
export interface CohortCell { value: number | null; incomplete: boolean; predicted?: boolean }
export interface CohortOutput {
  kind: "cohort";
  /** periods[0] is the cohort size; periods[k] the k-th column. */
  periods: { display_name: string; description: string; unit: "$" | "#" | "%"; decimal_precision: number; scale: "absolute" | "relative" }[];
  measure: MeasureDef;
  rows: { start: number; cells: CohortCell[] }[];
}
export type ChartOutput = SeriesOutput | CohortOutput;

const PAID_KINDS = new Set(["purchase", "renewal", "one_time"]);
const CONVERSION_KINDS = new Set(["trial", "purchase", "one_time"]);
const rate = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const div = (a: number, b: number) => (b > 0 ? a / b : null);
const proceedsFactor = (t: { store: string; commission?: number }) => 1 - (t.commission ?? commission(t.store as Store));

/** Parses "7_days" / "unbounded" selector values into days (Infinity for unbounded). */
export const selectorDays = (v: string) => (v === "unbounded" ? Infinity : Number(v.split("_")[0]));
/** End of a "day 0 through day N" window that starts on the calendar day of `t`. */
const windowEnd = (t: number, days: number) => (days === Infinity ? Infinity : dayStart(t) + (days + 1) * DAY);

/** Rows prepared once per (filtered) input and shared by every chart computation. */
export class Prepared {
  readonly txs: ChartTx[];
  readonly purchases: Map<string, number>;
  readonly refunds: Map<string, number>;
  readonly product: ReturnType<typeof productIndex>;
  private _subs: Sub[] | null = null;
  private _moves: Move[] | null = null;
  private _cohort: Map<string, number> | null = null;
  private _byCustomer: Map<string, ChartTx[]> | null = null;
  private _subsByCustomer: Map<string, Sub[]> | null = null;
  private _lifecycle: Map<string, ChartInput["lifecycle"]> | null = null;
  private _firstImpression: Map<string, number> | null = null;
  private _sorted = new Map<string, unknown[]>();
  constructor(readonly input: ChartInput) {
    const family = new Set(input.subStates.filter((s) => s.familyShared).map(chainKey));
    this.txs = input.txs.filter((t) => !isExcludedStore(t.store) && !family.has(chainKey(t)));
    this.purchases = purchaseTimes(this.txs);
    this.refunds = refundTimes(this.txs);
    this.product = productIndex(input.products);
  }
  get now() { return this.input.now; }
  get subs() { return (this._subs ??= buildSubscriptions({ ...this.input, txs: this.txs })); }
  get moves() { return (this._moves ??= pairMoves(subMoves(this.subs, this.now))); }
  private sortedBy<T>(key: string, rows: () => T[], at: (x: T) => number): T[] {
    let v = this._sorted.get(key) as T[] | undefined;
    if (!v) this._sorted.set(key, (v = [...rows()].sort((a, b) => at(a) - at(b))));
    return v;
  }
  /** Rows in time order, so each period reads only its own slice (see `within`). */
  get txsByTime() { return this.sortedBy("txs", () => this.txs, atOf); }
  get sdkByTime() { return this.sortedBy("sdk", () => this.input.sdkEvents, atOf); }
  get movesByTime() { return this.sortedBy("moves", () => this.moves, atOf); }
  get activityByTime() { return this.sortedBy("activity", () => this.input.activity, (a) => a.day); }
  get trialsByStart() { return this.sortedBy("trials", () => trialPeriods(this), (t) => t.start); }
  get trialsByEnd() { return this.sortedBy("trialEnds", () => trialPeriods(this), (t) => t.end); }
  get cohortTimes() { return this.sortedBy("cohort", () => [...this.cohortDate.values()], (t) => t); }
  money(t: ChartTx) { return moneyOf(t, this.input, this.purchases); }
  /** Each customer's cohort date: the earlier of first seen and first transaction. */
  get cohortDate() {
    if (this._cohort) return this._cohort;
    const m = new Map<string, number>();
    for (const c of this.input.customers) m.set(c.id, c.firstSeen);
    for (const t of this.txs) { const c = m.get(t.customerId); if (c !== undefined && t.at < c) m.set(t.customerId, t.at); }
    return (this._cohort = m);
  }
  /** The customer's ledger rows in time order. */
  txsOf(customerId: string): ChartTx[] {
    if (!this._byCustomer) this._byCustomer = groupBy(this.txsByTime, (t) => t.customerId);
    return this._byCustomer.get(customerId) ?? [];
  }
  /** The customer's subscriptions. */
  subsOf(customerId: string): Sub[] {
    return (this._subsByCustomer ??= groupBy(this.subs, (s) => s.customerId)).get(customerId) ?? [];
  }
  /** Lifecycle events of one subscription chain (customer, store, product) in time order. */
  lifecycleOf(s: Pick<Sub, "customerId" | "store" | "productId">): ChartInput["lifecycle"] {
    this._lifecycle ??= groupBy([...this.input.lifecycle].sort((a, b) => a.at - b.at), (e) => `${e.customerId}|${e.store}|${e.productId}`);
    return this._lifecycle.get(`${s.customerId}|${s.store}|${s.productId}`) ?? [];
  }
  /** Each customer's first paywall impression. */
  get firstImpression(): Map<string, number> {
    if (this._firstImpression) return this._firstImpression;
    const m = new Map<string, number>();
    for (const e of this.input.sdkEvents) if (e.type === "paywall_impression" && e.customerId && (m.get(e.customerId) ?? Infinity) > e.at) m.set(e.customerId, e.at);
    return (this._firstImpression = m);
  }
  refundedAt(t: ChartTx) { return this.refunds.get(`${t.store}|${t.storeTransactionId}`); }
}

const atOf = (x: { at: number }) => x.at;
/** The first index whose time is at or after `t` in rows sorted by time. */
function lowerBound<T>(rows: T[], at: (x: T) => number, t: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at(rows[mid]!) < t) lo = mid + 1; else hi = mid; }
  return lo;
}
/** The rows of a time-sorted list in [from, to). */
function within<T>(rows: T[], at: (x: T) => number, [from, to]: [number, number]): T[] {
  return to > from ? rows.slice(lowerBound(rows, at, from), lowerBound(rows, at, to)) : [];
}

function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) { const k = key(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); }
  return m;
}

/** A move annotated for the movement charts: paid-to-paid product changes become one expansion or contraction. */
export interface Move extends SubMove { category: "new" | "resubscription" | "change" | "paired_out" | "churn" | "recovery" | "reprice" }
function pairMoves(moves: SubMove[]): Move[] {
  const changes = moves.filter((x) => x.type === "product_change" && x.paidToPaid);
  const replaced = new Map<Sub, SubMove>();
  for (const x of moves) if (x.type === "replaced") replaced.set(x.sub, x);
  const paired = new Set<SubMove>();
  const out: Move[] = [];
  for (const c of changes) {
    const r = c.sub.predecessor ? replaced.get(c.sub.predecessor) : undefined;
    if (r) paired.add(r);
    out.push({ ...c, category: "change", mrr: c.mrr + (r?.mrr ?? 0) });
  }
  for (const x of moves) {
    if (x.type === "product_change" && x.paidToPaid) continue;
    if (paired.has(x)) { out.push({ ...x, category: "paired_out" }); continue; }
    const category = x.type === "new" || x.type === "trial_conversion" || x.type === "product_change" ? "new"
      : x.type === "resubscription" ? "resubscription" : x.type === "recovery" ? "recovery" : x.type === "reprice" ? "reprice" : "churn";
    out.push({ ...x, category });
  }
  return out;
}

/** The request's periods and the windows each chart shape reads. */
export class Frame {
  readonly buckets: Bucket[];
  constructor(readonly req: ChartRequest, readonly now: number, max = 1000) {
    this.buckets = buckets(req.rangeStart, req.rangeEnd, req.resolution, max);
  }
  private get stop() { return Math.min(this.req.rangeEnd, this.now + 1); }
  /** [from, to) of a flow or cohort period: clipped to the range and to now. */
  window(b: Bucket): [number, number] { return [this.req.expand ? b.start : Math.max(b.start, this.req.rangeStart), Math.min(b.end, this.stop)]; }
  /** The instant a stock period is measured at: its end, the range end or now, whichever is first. */
  snapshot(b: Bucket) { return Math.min(b.end, this.stop) - 1; }
  clipped(b: Bucket) { return b.end > this.stop || (!this.req.expand && b.start < this.req.rangeStart); }
  stockIncomplete(b: Bucket) { return b.end > this.stop; }
}

type SeriesFn = (d: Prepared, f: Frame, sel: Record<string, string>) => { measures?: MeasureDef[]; points: SeriesPoint[] };
type CohortFn = (d: Prepared, f: Frame, sel: Record<string, string>, def: ChartDef) => CohortOutput;

const inW = (t: number, [a, b]: [number, number]) => t >= a && t < b;
/** Items grouped by the period whose window holds their time (windows are ordered and do not overlap). */
function byBucket<T>(f: Frame, items: T[], at: (x: T) => number): T[][] {
  const sorted = [...items].sort((a, b) => at(a) - at(b));
  return f.buckets.map((b) => within(sorted, at, f.window(b)));
}

/** A flow chart: one value per measure from the things that happened in each period. */
const flow = (fn: (d: Prepared, w: [number, number], sel: Record<string, string>, f: Frame) => (number | null)[]): SeriesFn =>
  (d, f, sel) => ({ points: f.buckets.map((b) => ({ start: b.start, values: fn(d, f.window(b), sel, f), incomplete: f.clipped(b) })) });
/** A stock chart: one snapshot per period. */
const stock = (fn: (d: Prepared, at: number, sel: Record<string, string>) => (number | null)[]): SeriesFn =>
  (d, f, sel) => ({ points: f.buckets.map((b) => ({ start: b.start, values: fn(d, f.snapshot(b), sel), incomplete: f.stockIncomplete(b) })) });
/**
 * A cohort shown as a series: members are customers (or trials, pairs …) whose cohort time is in the period; each is
 * measured over its own window. The period is incomplete while any member's window is still open.
 */
function cohortSeries<T>(members: (d: Prepared, sel: Record<string, string>) => { at: number; item: T; windowEnd: number }[],
  measure: (d: Prepared, items: T[], sel: Record<string, string>) => (number | null)[]): SeriesFn {
  return (d, f, sel) => {
    const all = members(d, sel).sort((a, b) => a.at - b.at);
    return {
      points: f.buckets.map((b) => {
        const w = f.window(b);
        const mine = within(all, atOf, w);
        return { start: b.start, values: measure(d, mine.map((x) => x.item), sel), incomplete: f.clipped(b) || mine.some((x) => x.windowEnd > d.now + 1) };
      }),
    };
  };
}

// ── Revenue ────────────────────────────────────────────────────────────────────────────────────────────────────────
const revenue = flow((d, w, sel) => {
  const proceeds = sel.revenue_type === "proceeds";
  let money = 0, count = 0;
  for (const t of within(d.txsByTime, atOf, w)) {
    if (t.kind === "trial") continue;
    money += d.money(t) * (proceeds ? proceedsFactor(t) : 1);
    if (PAID_KINDS.has(t.kind)) count++;
  }
  for (const e of within(d.sdkByTime, atOf, w)) if (e.type === "rc_ads_ad_revenue") money += (e.revenueUsd ?? 0) * d.input.fx(e.at);
  return [money, count];
});

const mrrAt = (d: Prepared, at: number) => d.subs.reduce((s, x) => s + (paidAt(x, at)?.monthly ?? 0), 0);
const mrr = stock((d, at) => [mrrAt(d, at)]);
const arr = stock((d, at) => [mrrAt(d, at) * 12]);

const mrrMovement = flow((d, w) => {
  let nw = 0, resub = 0, exp = 0, churn = 0, contr = 0;
  for (const x of within(d.movesByTime, atOf, w)) {
    if (x.category === "new") nw += x.mrr;
    else if (x.category === "resubscription") resub += x.mrr;
    else if (x.category === "change" || x.category === "reprice") { if (x.mrr > 0) exp += x.mrr; else contr += x.mrr; }
    else if (x.category === "churn" || x.category === "recovery") churn += x.mrr;
  }
  return [nw, resub, exp, churn, contr, nw + resub + exp + churn + contr];
});

const nonSubscription = flow((d, w) => [within(d.txsByTime, atOf, w).filter((t) => t.kind === "one_time").length]);

// ── Ads ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function ads(d: Prepared, w: [number, number]) {
  let revenue = 0, impressions = 0, clicks = 0, loaded = 0, failed = 0;
  const daily = new Map<number, Set<string>>();
  for (const e of within(d.sdkByTime, atOf, w)) {
    if (e.type === "rc_ads_ad_revenue") {
      revenue += (e.revenueUsd ?? 0) * d.input.fx(e.at);
      if (e.customerId) { const k = dayStart(e.at); daily.set(k, (daily.get(k) ?? new Set()).add(e.customerId)); }
    } else if (e.type === "rc_ads_ad_displayed") impressions++;
    else if (e.type === "rc_ads_ad_opened") clicks++;
    else if (e.type === "rc_ads_ad_loaded") loaded++;
    else if (e.type === "rc_ads_ad_failed_to_load") failed++;
  }
  const dayCount = Math.max(1, Math.ceil((w[1] - w[0]) / DAY));
  const dau = [...daily.values()].reduce((s, x) => s + x.size, 0);
  return { revenue, impressions, clicks, loaded, failed, dau, dayCount };
}
const adRevenue = flow((d, w) => [ads(d, w).revenue]);
const adRpm = flow((d, w) => { const a = ads(d, w); return [a.impressions ? (a.revenue / a.impressions) * 1000 : null, a.revenue, a.impressions]; });
const adImpressions = flow((d, w) => [ads(d, w).impressions]);
const adClicks = flow((d, w) => [ads(d, w).clicks]);
const adFill = flow((d, w) => { const a = ads(d, w); return [rate(a.loaded, a.loaded + a.failed), a.loaded + a.failed, a.loaded]; });
const adCtr = flow((d, w) => { const a = ads(d, w); return [rate(a.clicks, a.impressions), a.clicks, a.impressions]; });
const adMonetized = flow((d, w) => { const a = ads(d, w); return w[1] > w[0] ? [a.dau / a.dayCount] : [null]; });
const adArpdau = flow((d, w) => { const a = ads(d, w); return [div(a.revenue, a.dau)]; });

// ── Subscriptions ──────────────────────────────────────────────────────────────────────────────────────────────────
const actives = stock((d, at) => [d.subs.filter((s) => paidAt(s, at)).length]);

const activesMovement = flow((d, w) => {
  let nw = 0, resub = 0, churned = 0;
  for (const x of within(d.movesByTime, atOf, w)) {
    if (x.category === "new") nw += 1;
    else if (x.category === "resubscription") resub += 1;
    else if (x.category === "churn" || x.category === "recovery") churned += x.actives;
  }
  return [nw, resub, churned, nw + resub + churned];
});

const activesNew = flow((d, w) => {
  const c = { trial_conversion: 0, new: 0, product_change: 0, resubscription: 0 };
  for (const x of within(d.movesByTime, atOf, w)) {
    if (x.type === "trial_conversion" || x.type === "new" || x.type === "product_change" || x.type === "resubscription") c[x.type]++;
  }
  return [c.trial_conversion + c.new + c.product_change + c.resubscription, c.trial_conversion, c.new, c.product_change, c.resubscription];
});

/**
 * A subscription's renewal state as known now, applied to a moment in its past: a period that was followed by another
 * paid period or a product change was "set to renew"; the current period uses the store's current state; a period that
 * ended without renewing was "set to cancel" (or "billing issue" if the store reported one).
 */
function statusAt(s: Sub, at: number, now: number): "set_to_renew" | "set_to_cancel" | "billing_issue" {
  const i = s.periods.findIndex((p) => p.start <= at && at < p.end);
  const later = i >= 0 && s.periods.slice(i + 1).some((p) => !p.trial);
  if (later || (s.replacedAt !== null && s.replacedAt === s.end)) return "set_to_renew";
  if (s.state && s.end > now) return s.state.billingIssue ? "billing_issue" : s.state.autoRenew ? "set_to_renew" : "set_to_cancel";
  if (i >= 0 && s.periods[i]!.trial && s.paidStart !== null) return "set_to_renew";
  return s.state?.billingIssue ? "billing_issue" : "set_to_cancel";
}
const subscriptionStatus: SeriesFn = (d, f, sel) => {
  const what = sel.status_measure ?? "actives";
  const unit = what === "mrr" || what === "arr" ? "$" : "#";
  const base = [["set_to_renew", "Set to renew"], ["set_to_cancel", "Set to cancel"], ["billing_issue", "Billing issue"]] as const;
  return {
    measures: base.map(([id, name]) => ({ id, display_name: name, description: `${name}: subscriptions in this state, measured by ${what === "actives" ? "count" : what}.`, unit, decimal_precision: unit === "$" ? 2 : 0, chartable: true, tabulable: true, flow: false })),
    points: stock((dd, at) => {
      const out = { set_to_renew: 0, set_to_cancel: 0, billing_issue: 0 };
      for (const s of dd.subs) {
        const p = what === "trials" ? trialAt(s, at) : paidAt(s, at);
        if (!p) continue;
        out[statusAt(s, at, dd.now)] += what === "mrr" ? p.monthly : what === "arr" ? p.monthly * 12 : 1;
      }
      return [out.set_to_renew, out.set_to_cancel, out.billing_issue];
    })(d, f, sel).points,
  };
};

// ── Trials ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const trials = stock((d, at) => [d.subs.filter((s) => trialAt(s, at)).length]);
/** Trial periods with whether a paid period of the same subscription followed. */
function trialPeriods(d: Prepared) {
  const out: { sub: Sub; start: number; end: number; converted: boolean }[] = [];
  for (const s of d.subs) s.periods.forEach((p, i) => {
    if (!p.trial) return;
    const next = s.periods[i + 1];
    out.push({ sub: s, start: p.start, end: p.end, converted: !!next && !next.trial && next.end > next.start });
  });
  return out;
}
const trialsNew = flow((d, w) => [within(d.trialsByStart, (t) => t.start, w).length]);
const trialsMovement = flow((d, w) => {
  let nw = 0, conv = 0, exp = 0;
  nw = within(d.trialsByStart, (t) => t.start, w).length;
  for (const t of within(d.trialsByEnd, (t) => t.end, w)) { if (t.end > d.now) continue; if (t.converted) conv--; else exp--; }
  return [nw, conv, exp, nw + conv + exp];
});

/** Customers by the start of their first trial in a period; each customer once per period (their first trial in it). */
function trialStarters(d: Prepared) {
  return d.subs.filter((s) => s.trialStart !== null).map((s) => ({ at: s.trialStart!, item: s, windowEnd: s.trialEnd ?? Infinity }));
}
const oncePerCustomer = (subs: Sub[]) => {
  const seen = new Map<string, Sub>();
  for (const s of [...subs].sort((a, b) => a.trialStart! - b.trialStart!)) if (!seen.has(s.customerId)) seen.set(s.customerId, s);
  return [...seen.values()];
};
const trialConversionRate = cohortSeries(trialStarters, (d, subs) => {
  const firsts = oncePerCustomer(subs);
  const byCustomer = new Map<string, Sub[]>();
  for (const s of subs) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
  let conv = 0, pending = 0;
  for (const s of firsts) {
    const mine = byCustomer.get(s.customerId)!;
    if (mine.some((x) => x.paidStart !== null && x.trialEnd !== null && x.paidStart >= x.trialEnd - 1)) conv++;
    else if (mine.some((x) => (x.trialEnd ?? 0) > d.now)) pending++;
  }
  return [rate(conv, firsts.length), firsts.length, conv, pending];
});

function lastOptOut(d: Prepared, s: Sub): number | null {
  const evs = d.lifecycleOf(s).filter((e) => e.at >= s.trialStart! && e.at < (s.trialEnd ?? Infinity));
  let out: number | null = null;
  for (const e of evs) { if (e.type === "CANCELLATION") out = e.at; else if (e.type === "UNCANCELLATION") out = null; }
  return out;
}
const billingIssueInTrial = (d: Prepared, s: Sub) => d.lifecycleOf(s).some((e) => e.type === "BILLING_ISSUE" && e.at >= s.trialStart! && e.at <= (s.trialEnd ?? Infinity) + DAY);
const trialCancellation = cohortSeries(trialStarters, (d, subs, sel) => {
  const limit = selectorDays(sel.cancellation_timeframe ?? "7_days") * DAY;
  const firsts = oncePerCustomer(subs);
  let cancels = 0, billing = 0, elapsed = 0;
  for (const s of firsts) {
    if (s.paidStart !== null || (s.trialEnd ?? Infinity) > d.now) continue;
    const opt = lastOptOut(d, s);
    if (opt !== null && opt - s.trialStart! <= limit) cancels++;
    else if (billingIssueInTrial(d, s)) billing++;
    else elapsed++;
  }
  return [rate(cancels, firsts.length), firsts.length, cancels, billing, elapsed];
});

// ── Customers and conversion ───────────────────────────────────────────────────────────────────────────────────────
const customersNew = flow((d, w) => [within(d.cohortTimes, (t) => t, w).length]);
/** A day counts when any part of it falls in the window. */
const customersActive = flow((d, w) => [new Set(within(d.activityByTime, (a) => a.day, [w[0] - DAY + 1, w[1]]).map((a) => a.customerId)).size]);

/** New customers by cohort date, each with the window that the selector gives them. */
const newCustomers = (days: (sel: Record<string, string>) => number) => (d: Prepared, sel: Record<string, string>) =>
  [...d.cohortDate].map(([id, at]) => ({ at, item: id, windowEnd: windowEnd(at, days(sel)) }));
const conversionDays = (sel: Record<string, string>) => selectorDays(sel.conversion_timeframe ?? "7_days");
const lifetimeDays = (sel: Record<string, string>) => selectorDays(sel.customer_lifetime ?? "30_days");

const initialConversion = cohortSeries(newCustomers(conversionDays), (d, ids, sel) => {
  const days = conversionDays(sel);
  let n = 0;
  for (const id of ids) {
    const end = windowEnd(d.cohortDate.get(id)!, days);
    if (d.txsOf(id).some((t) => CONVERSION_KINDS.has(t.kind) && t.at < end)) n++;
  }
  return [rate(n, ids.length), n, ids.length];
});

/** The customer's first payment (a paid purchase, trial conversion, renewal or one-time purchase). */
const firstPayment = (d: Prepared, id: string) => d.txsOf(id).find((t) => PAID_KINDS.has(t.kind));
const paidInWindow = (d: Prepared, id: string, end: number) => {
  const p = firstPayment(d, id);
  if (!p || p.at >= end) return false;
  const r = d.refundedAt(p);
  return !(r !== undefined && r < end);
};
const conversionToPaying = cohortSeries(newCustomers(conversionDays), (d, ids, sel) => {
  const days = conversionDays(sel);
  const n = ids.filter((id) => paidInWindow(d, id, windowEnd(d.cohortDate.get(id)!, days))).length;
  return [rate(n, ids.length), n, ids.length];
});

/** Revenue of a customer in [from, to): purchases and renewals minus refunds recorded in it. */
const revenueIn = (d: Prepared, id: string, from: number, to: number, proceeds = false) =>
  d.txsOf(id).reduce((s, t) => (t.at >= from && t.at < to && t.at <= d.now && t.kind !== "trial" ? s + d.money(t) * (proceeds ? proceedsFactor(t) : 1) : s), 0);

const ltvPerCustomer = cohortSeries(newCustomers(lifetimeDays), (d, ids, sel) => {
  const days = lifetimeDays(sel);
  let rev = 0;
  for (const id of ids) { const c = d.cohortDate.get(id)!; rev += revenueIn(d, id, dayStart(c), windowEnd(c, days)); }
  return [div(rev, ids.length), rev, ids.length];
});
const ltvPerPaying = cohortSeries(newCustomers(lifetimeDays), (d, ids, sel) => {
  const days = lifetimeDays(sel);
  let rev = 0, paying = 0;
  for (const id of ids) {
    const c = d.cohortDate.get(id)!;
    const end = windowEnd(c, days);
    rev += revenueIn(d, id, dayStart(c), end);
    if (paidInWindow(d, id, end)) paying++;
  }
  return [div(rev, paying), rev, paying];
});

const RANK = ["converted", "set_to_convert", "set_to_cancel", "billing_issue", "abandoned"] as const;
const trialFunnel = cohortSeries((d) => [...d.cohortDate].map(([id, at]) => {
  const running = d.subsOf(id).some((s) => s.trialStart !== null && (s.trialEnd ?? Infinity) > d.now && s.paidStart === null);
  return { at, item: id, windowEnd: running ? Infinity : at };
}), (d, ids) => {
  const counts = { converted: 0, set_to_convert: 0, set_to_cancel: 0, billing_issue: 0, abandoned: 0 };
  let started = 0;
  for (const id of ids) {
    const mine = d.subsOf(id).filter((s) => s.trialStart !== null);
    if (!mine.length) continue;
    started++;
    const statuses = mine.map((s): (typeof RANK)[number] => {
      if (s.paidStart !== null) return "converted";
      if ((s.trialEnd ?? Infinity) > d.now) return s.state?.billingIssue ? "billing_issue" : s.state && !s.state.autoRenew ? "set_to_cancel" : "set_to_convert";
      return billingIssueInTrial(d, s) ? "billing_issue" : "abandoned";
    });
    counts[RANK.find((r) => statuses.includes(r))!]++;
  }
  return [ids.length, started, counts.converted, counts.set_to_convert, counts.set_to_cancel, counts.billing_issue, counts.abandoned, rate(started, ids.length), rate(counts.converted, started)];
});

// ── Paywalls ───────────────────────────────────────────────────────────────────────────────────────────────────────
const paywallEncounter = cohortSeries(newCustomers(() => 14), (d, ids) => {
  const first = d.firstImpression;
  const share = (k: number) => rate(ids.filter((id) => { const t = first.get(id); return t !== undefined && t < windowEnd(d.cohortDate.get(id)!, k); }).length, ids.length);
  return [share(0), share(1), share(3), share(7), share(14), ids.length];
});

/** Customer–paywall pairs by first impression, with their first conversion on calendar days 0–3. */
interface Pair { customerId: string; paywall: string; first: number; conversion: ChartTx | null; initiated: boolean }
function pairs(d: Prepared): Pair[] {
  const m = new Map<string, Pair>();
  const evs = d.sdkByTime;
  for (const e of evs) {
    if (e.type !== "paywall_impression" || !e.customerId) continue;
    const k = `${e.customerId}|${e.paywallId ?? ""}`;
    if (!m.has(k)) m.set(k, { customerId: e.customerId, paywall: e.paywallId ?? "", first: e.at, conversion: null, initiated: false });
  }
  const initiated = groupBy(evs.filter((e) => e.type === "paywall_purchase_initiated" && e.customerId), (e) => `${e.customerId}|${e.paywallId ?? ""}`);
  for (const [k, p] of m) {
    const end = windowEnd(p.first, 3);
    p.conversion = d.txsOf(p.customerId).find((t) => CONVERSION_KINDS.has(t.kind) && t.at >= dayStart(p.first) && t.at < end) ?? null;
    p.initiated = (initiated.get(k) ?? []).some((e) => e.at >= p.first && e.at < end);
  }
  return [...m.values()];
}
const pairMembers = (days: (sel: Record<string, string>) => number) => (d: Prepared, sel: Record<string, string>) =>
  pairs(d).map((p) => ({ at: p.first, item: p, windowEnd: Math.max(windowEnd(p.first, 3), windowEnd(p.first, days(sel))) }));
const trialOf = (d: Prepared, t: ChartTx) => d.subsOf(t.customerId).find((s) => s.store === t.store && s.productId === t.productId && s.trialStart === t.at) ?? null;
const paywallConversion = cohortSeries(pairMembers(() => 3), (d, ps) => {
  let init = 0, paid = 0, trialStarts = 0, trialConv = 0;
  for (const p of ps) {
    if (!p.conversion) continue;
    init++;
    if (p.conversion.kind === "trial") {
      trialStarts++;
      if (trialOf(d, p.conversion)?.paidStart != null) { trialConv++; paid++; }
    } else paid++;
  }
  const n = ps.length;
  return [rate(init, n), rate(paid, n), rate(trialStarts, n), rate(trialConv, n), n, init, paid, trialStarts, trialConv];
});
const paywallLtv = cohortSeries(pairMembers(lifetimeDays), (d, ps, sel) => {
  const days = lifetimeDays(sel);
  let rev = 0, conv = 0;
  for (const p of ps) { if (!p.conversion) continue; conv++; rev += revenueIn(d, p.customerId, dayStart(p.first), windowEnd(p.first, days)); }
  return [div(rev, ps.length), div(rev, conv), rev, ps.length];
});
const paywallAbandonment = cohortSeries(pairMembers(() => 3), (d, ps) => {
  let bounce = 0, cancel = 0;
  for (const p of ps) { if (p.conversion) continue; if (p.initiated) cancel++; else bounce++; }
  const n = ps.length;
  return [rate(bounce + cancel, n), rate(bounce, n), rate(cancel, n), n, bounce, cancel];
});

// ── Churn and refunds ──────────────────────────────────────────────────────────────────────────────────────────────
const churn: SeriesFn = (d, f) => ({
  points: f.buckets.map((b) => {
    const w = f.window(b);
    const atStart = d.subs.filter((s) => paidAt(s, w[0] - 1)).length;
    let churned = 0;
    for (const x of within(d.movesByTime, atOf, w)) if (x.category === "churn" || x.category === "paired_out" || x.category === "recovery") churned -= x.actives;
    return { start: b.start, values: [rate(churned, atStart), atStart, churned], incomplete: f.clipped(b) };
  }),
});

const refundRate = flow((d, w) => {
  const paid = within(d.txsByTime, atOf, w).filter((t) => PAID_KINDS.has(t.kind));
  const refunded = paid.filter((t) => d.refundedAt(t) !== undefined).length;
  return [rate(refunded, paid.length), paid.length, refunded];
});
const refunds = flow((d, w) => {
  let money = 0, n = 0;
  for (const t of within(d.txsByTime, atOf, w)) {
    if (t.kind === "refund") { money -= d.money(t); n++; }
    if (t.kind === "refund_reversal") { money -= d.money(t); n--; }
  }
  return [money, n];
});
const refundRequests = flow((d, w) => {
  const evs = d.input.refundEvents;
  const c = { granted: 0, declined: 0, reversed: 0, no_resolution: 0 };
  let amount = 0, total = 0;
  for (const r of evs) {
    if (r.kind !== "request" || !inW(r.at, w)) continue;
    total++;
    amount += (r.usd ?? 0) * d.input.fx(r.purchasedAt ?? r.at);
    const after = evs.filter((x) => x.transactionId === r.transactionId && x.kind !== "request" && x.at >= r.at).sort((a, b) => a.at - b.at);
    const granted = after.find((x) => x.kind === "granted");
    if (granted && after.some((x) => x.kind === "reversed" && x.at >= granted.at)) c.reversed++;
    else if (granted) c.granted++;
    else if (after.some((x) => x.kind === "declined") || d.now - r.at >= 2 * DAY) c.declined++;
    else c.no_resolution++;
  }
  return [c.granted, c.declined, c.reversed, c.no_resolution, total, amount];
});

const playStoreCancelReasons: SeriesFn = (d, f) => {
  const reasonOf = new Map<string, string>();
  for (const s of d.input.subStates) if (s.store === "play_store") reasonOf.set(`${s.customerId}|${s.productId}`, s.cancelSurveyReason ?? "UNKNOWN");
  const measures = [...CANCEL_REASONS.map((r) => ({ id: r.id.toLowerCase(), display_name: r.display_name, description: `Cancellations whose survey answer was "${r.display_name}".`, unit: "#" as const, decimal_precision: 0, chartable: true, tabulable: true, flow: true })),
    { id: "cancellations", display_name: "Cancellations", description: "Google Play subscriptions whose auto-renew was turned off in the period.", unit: "#" as const, decimal_precision: 0, chartable: false, tabulable: true, flow: true }];
  return {
    measures,
    points: flow((dd, w) => {
      const counts = new Map<string, number>();
      let total = 0;
      for (const e of dd.input.lifecycle) {
        if (e.type !== "CANCELLATION" || e.store !== "play_store" || !inW(e.at, w)) continue;
        const r = reasonOf.get(`${e.customerId}|${e.productId}`) ?? "UNKNOWN";
        const k = CANCEL_REASONS.some((x) => x.id === r) ? r : "CANCEL_SURVEY_REASON_OTHERS";
        counts.set(k, (counts.get(k) ?? 0) + 1);
        total++;
      }
      return [...CANCEL_REASONS.map((r) => counts.get(r.id) ?? 0), total];
    })(d, f, {}).points,
  };
};

const surveyResponses: SeriesFn = (d, f) => {
  const evs = d.input.sdkEvents.filter((e) => e.type === "customer_center_survey_option_chosen");
  const totals = new Map<string, number>();
  const windows = f.buckets.map((b) => f.window(b));
  const from = Math.min(...windows.map((w) => w[0])), to = Math.max(...windows.map((w) => w[1]));
  for (const e of evs) if (e.at >= from && e.at < to) totals.set(e.surveyOptionId ?? "", (totals.get(e.surveyOptionId ?? "") ?? 0) + 1);
  const options = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
  return {
    measures: [{ id: "responses", display_name: "Responses", description: "Survey answers in the period.", unit: "#", decimal_precision: 0, chartable: false, tabulable: true, flow: true },
      ...options.map((id) => ({ id: `option:${id}`, display_name: id || "Unknown option", description: `Answers that chose the option "${id}".`, unit: "#" as const, decimal_precision: 0, chartable: true, tabulable: true, flow: true }))],
    points: flow((dd, w) => {
      const mine = evs.filter((e) => inW(e.at, w));
      return [mine.length, ...options.map((id) => mine.filter((e) => (e.surveyOptionId ?? "") === id).length)];
    })(d, f, {}).points,
  };
};

const saveOutcomes = flow(() => [0, 0, 0]);

// ── Cohort tables ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Each customer's cohort time for the Cohort and Prediction Explorers. */
function cohortMembers(d: Prepared, how: string): Map<string, number> {
  if (how === "new_customers") return d.cohortDate;
  const out = new Map<string, number>();
  for (const c of d.input.customers) {
    const t = d.txsOf(c.id).find((x) => (how === "initial_conversions" ? CONVERSION_KINDS : PAID_KINDS).has(x.kind));
    if (t) out.set(c.id, t.at);
  }
  return out;
}
const MAX_AGE = 24;

function explorerRows(d: Prepared, f: Frame, how: string, cell: (ids: string[], start: Map<string, number>, n: number) => number) {
  const members = cohortMembers(d, how);
  const rows = byBucket(f, [...members], ([, t]) => t).map((list, i) => ({ b: f.buckets[i]!, ids: list.map(([id]) => id) }));
  const oldest = f.buckets[0]?.start ?? d.now;
  let ages = 0;
  while (ages < MAX_AGE && addMonths(oldest, ages + 1) <= d.now) ages++;
  return rows.map(({ b, ids }) => {
    const cells: CohortCell[] = [{ value: ids.length, incomplete: f.clipped(b) }];
    for (let n = 0; n <= ages; n++) {
      if (addMonths(b.start, n) > d.now || !ids.length) { cells.push({ value: null, incomplete: true }); continue; }
      cells.push({ value: cell(ids, members, n), incomplete: f.clipped(b) || addMonths(Math.min(b.end, f.req.rangeEnd), n + 1) > d.now + 1 });
    }
    return { start: b.start, cells };
  });
}

const cohortExplorer: CohortFn = (d, f, sel) => {
  const how = sel.cohorting_date ?? "new_customers";
  const what = sel.cohort_measure ?? "realized_ltv_per_customer";
  const money = !["retained_subscriptions", "subscriptions_set_to_renew"].includes(what);
  const cumulative = what === "realized_ltv" || what === "realized_ltv_per_customer";
  const rows = explorerRows(d, f, how, (ids, start, n) => {
    let v = 0;
    for (const id of ids) {
      const c = start.get(id)!;
      const from = cumulative ? c : addMonths(c, n), to = addMonths(c, n + 1);
      if (money) { v += revenueIn(d, id, from, to, what === "proceeds"); continue; }
      const at = Math.min(to, d.now + 1) - 1;
      for (const s of d.subsOf(id)) if (paidAt(s, at) && (what === "retained_subscriptions" || statusAt(s, at, d.now) === "set_to_renew")) v++;
    }
    return what === "realized_ltv_per_customer" ? v / ids.length : v;
  });
  const measureName = ({ revenue: "Revenue", revenue_net_of_taxes: "Revenue (net of taxes)", proceeds: "Proceeds", realized_ltv: "Realized LTV", realized_ltv_per_customer: "Realized LTV / Customer", retained_subscriptions: "Retained Subscriptions", subscriptions_set_to_renew: "Subscriptions Set to Renew" } as Record<string, string>)[what] ?? what;
  const unit = money ? "$" : "#";
  return explorerOutput(rows, how, measureName, unit);
};

function explorerOutput(rows: CohortOutput["rows"], how: string, measureName: string, unit: "$" | "#", predicted = false): CohortOutput {
  const size = { new_customers: "New Customers", initial_conversions: "Initial Conversions", new_paying_customers: "New Paying Customers" }[how] ?? "Customers";
  const cols = Math.max(0, ...rows.map((r) => r.cells.length - 1));
  return {
    kind: "cohort",
    measure: { id: "value", display_name: measureName, description: `${measureName} by month of customer age.`, unit, decimal_precision: unit === "#" ? 0 : 2, chartable: true, tabulable: true, flow: false },
    periods: [
      { display_name: size, description: "Customers in the cohort.", unit: "#", decimal_precision: 0, scale: "absolute" },
      ...Array.from({ length: cols }, (_, i) => ({ display_name: `Month ${i}`, description: `${measureName}${predicted ? " (realized, then predicted)" : ""} through month ${i} of each customer's age.`, unit, decimal_precision: unit === "#" ? 0 : 2, scale: "absolute" as const })),
    ],
    rows,
  };
}

/**
 * Prediction Explorer: realized LTV per customer, then the chain-ladder method for the months each cohort has not
 * reached: month n grows by the average growth from month n−1 to n of the cohorts that completed both months.
 */
const predictionExplorer: CohortFn = (d, f, sel) => {
  const how = sel.cohorting_date ?? "new_customers";
  const members = cohortMembers(d, how);
  const rows = byBucket(f, [...members], ([, t]) => t).map((list, i) => ({ b: f.buckets[i]!, ids: list.map(([id]) => id) }));
  const realized = rows.map(({ b, ids }) => Array.from({ length: MAX_AGE + 1 }, (_, n) => {
    if (!ids.length || addMonths(b.start, n) > d.now) return null;
    let v = 0;
    for (const id of ids) { const c = members.get(id)!; v += revenueIn(d, id, c, addMonths(c, n + 1)); }
    return { value: v / ids.length, complete: !f.clipped(b) && addMonths(b.end, n + 1) <= d.now + 1 };
  }));
  const growth = Array.from({ length: MAX_AGE + 1 }, (_, n) => {
    if (n === 0) return 1;
    let num = 0, den = 0;
    for (const r of realized) { const a = r[n - 1], c = r[n]; if (a?.complete && c?.complete && a.value > 0) { num += c.value; den += a.value; } }
    return den > 0 ? num / den : 1;
  });
  const out = rows.map(({ b, ids }, i) => {
    const r = realized[i]!;
    const cells: CohortCell[] = [{ value: ids.length, incomplete: f.clipped(b) }];
    let last: number | null = null;
    for (let n = 0; n <= MAX_AGE; n++) {
      const x = r[n];
      if (x) { last = x.value; cells.push({ value: x.value, incomplete: !x.complete }); continue; }
      if (last === null || !ids.length) { cells.push({ value: null, incomplete: true }); continue; }
      last = last * growth[n]!;
      cells.push({ value: last, incomplete: true, predicted: true });
    }
    return { start: b.start, cells };
  });
  return explorerOutput(out, how, "LTV / Customer", "$", true);
};

/** Subscription Retention: subscriptions by paid start; column k is the share that reached paid period k. */
const subscriptionRetention: CohortFn = (d, f, sel) => {
  const relative = (sel.retention_scale ?? "relative") === "relative";
  const subs = d.subs.filter((s) => s.paidStart !== null);
  const len = (s: Sub, k: number) => {
    // When paid period k (0-based) would start, from the product duration or the first paid period's length.
    const first = s.periods.find((p) => !p.trial)!;
    const dur = s.duration ? /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(s.duration) : null;
    if (dur) {
      const months = Number(dur[1] ?? 0) * 12 + Number(dur[2] ?? 0), daysN = Number(dur[3] ?? 0) * 7 + Number(dur[4] ?? 0);
      return addMonths(s.paidStart!, months * k) + daysN * k * DAY;
    }
    return s.paidStart! + k * Math.max(DAY, first.end - first.start);
  };
  const reached = (s: Sub) => s.periods.filter((p) => !p.trial && p.end > p.start).length;
  const rows = byBucket(f, subs, (s) => s.paidStart!).map((list, i) => ({ b: f.buckets[i]!, subs: list }));
  let cols = 1;
  for (const r of rows) for (const s of r.subs) { let k = 1; while (k < MAX_AGE && len(s, k) <= d.now) k++; cols = Math.max(cols, k); }
  return {
    kind: "cohort",
    measure: { id: "retention", display_name: "Retention", description: "Subscriptions that reached each paid period.", unit: relative ? "%" : "#", decimal_precision: relative ? 1 : 0, chartable: true, tabulable: true, flow: false },
    periods: [
      { display_name: "Subscriptions", description: "New paid subscriptions in the cohort.", unit: "#", decimal_precision: 0, scale: "absolute" },
      ...Array.from({ length: cols }, (_, k) => ({ display_name: `Period ${k}`, description: k === 0 ? "The first paid period." : `Paid period ${k} after ${k} renewal${k > 1 ? "s" : ""}.`, unit: relative ? "%" as const : "#" as const, decimal_precision: relative ? 1 : 0, scale: relative ? "relative" as const : "absolute" as const })),
    ],
    rows: rows.map(({ b, subs: ss }) => {
      const cells: CohortCell[] = [{ value: ss.length, incomplete: f.clipped(b) }];
      for (let k = 0; k < cols; k++) {
        const chance = ss.filter((s) => len(s, k) <= d.now);
        const got = chance.filter((s) => reached(s) > k).length;
        cells.push(chance.length ? { value: relative ? (got / chance.length) * 100 : got, incomplete: chance.length < ss.length } : { value: null, incomplete: true });
      }
      return { start: b.start, cells };
    }),
  };
};

const SERIES: Record<string, SeriesFn> = {
  revenue, arr, mrr, mrr_movement: mrrMovement, "non-subscription_purchases": nonSubscription, ad_revenue: adRevenue,
  actives, actives_movement: activesMovement, actives_new: activesNew, subscription_status: subscriptionStatus,
  ad_rpm: adRpm, ad_impressions: adImpressions, ad_fill_rate: adFill, ad_monetized_customers: adMonetized, ad_clicks: adClicks, ad_ctr: adCtr, ad_arpdau: adArpdau,
  ltv_per_customer: ltvPerCustomer, ltv_per_paying_customer: ltvPerPaying,
  customers_new: customersNew, customers_active: customersActive,
  initial_conversion: initialConversion, trial_conversion: trialFunnel, trial_conversion_rate: trialConversionRate, conversion_to_paying: conversionToPaying,
  paywall_encounter: paywallEncounter, paywall_conversion: paywallConversion, paywall_ltv: paywallLtv, paywall_abandonment: paywallAbandonment,
  trials, trials_movement: trialsMovement, trials_new: trialsNew, trial_cancellation: trialCancellation,
  churn, refund_rate: refundRate, refunds, refund_request: refundRequests,
  play_store_cancel_reasons: playStoreCancelReasons, customer_center_survey_responses: surveyResponses, app_store_save_outcomes: saveOutcomes,
};
const COHORTS: Record<string, CohortFn> = { cohort_explorer: cohortExplorer, prediction_explorer: predictionExplorer, subscription_retention: subscriptionRetention };

/** Computes one chart for already filtered rows. */
export function computeChart(def: ChartDef, data: Prepared, frame: Frame, selectors: Record<string, string>): ChartOutput {
  const sel = { ...Object.fromEntries(def.selectors.map((s) => [s.id, s.default])), ...selectors };
  const c = COHORTS[def.name];
  if (c) return c(data, frame, sel, def);
  const s = SERIES[def.name];
  if (!s) throw new Error(`No computation for chart ${def.name}`);
  const r = s(data, frame, sel);
  const measures = [...(r.measures ?? def.measures)];
  if (def.name === "revenue" && sel.revenue_type && sel.revenue_type !== "revenue") {
    const name = sel.revenue_type === "proceeds" ? "Proceeds" : "Revenue (net of taxes)";
    measures[0] = { ...measures[0]!, display_name: name };
  }
  return { kind: "series", measures, points: r.points };
}

export const hasComputation = (name: string) => name in SERIES || name in COHORTS;
