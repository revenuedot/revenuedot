import { buildSubscriptions, paidAt, refundTimes, type ChartLifecycle, type ChartProduct, type ChartSubState, type ChartTx, type Sub } from "../charts/model.js";
import { DAY, dayStart } from "../charts/time.js";
import { EXPERIMENT_METRICS, metricDef, type MetricDef } from "./catalog.js";
import { chanceMeanBeats, chanceRateBeats, liftInterval, meanInterval, rateLift, sampleSizeMean, sampleSizeRate, summarize, wilson, type Summary } from "./stats.js";

/**
 * Experiment results from the ledger (prd/experiments/PRD.md §4). Pure: the server loads the enrolled customers' rows
 * of one environment, this computes every metric per variant now (with intervals and the chance to beat the control)
 * and as of the end of each day (the series).
 *
 * What counts: purchases made after the customer joined and what follows from them. Subscriptions are built with the
 * charts' rules (`buildSubscriptions`); one counts when it started at or after the enrollment (a minute of grace for
 * store clocks). Renewals and refunds count through the store transactions of those subscriptions. Money is USD.
 */

export interface ResultsInput {
  now: number;
  variants: { id: string; name: string; offering_id: string | null }[];
  controlId: string;
  primaryMetric: string;
  enrollments: { customerId: string; variant: string; enrolledAt: number }[];
  /** The enrolled customers' ledger rows (one environment). */
  txs: ChartTx[];
  products: ChartProduct[];
  subStates: ChartSubState[];
  lifecycle: ChartLifecycle[];
  /** Paywall impressions of the enrolled customers. */
  paywallViews: { customerId: string; at: number }[];
  paywall: "all" | "viewed" | "not_viewed";
  /** The series runs from this day (default: the first enrollment) to `seriesTo` (default: now), at most `maxDays` days. */
  seriesFrom?: number | null;
  seriesTo?: number;
  maxDays?: number;
}

export interface MetricValue {
  value: number | null;
  numerator?: number;
  denominator?: number;
  lower?: number | null;
  upper?: number | null;
  /** Relative to the control: 0.12 = 12% better (or worse for metrics where lower wins). Null on the control. */
  lift?: number | null;
  lift_lower?: number | null;
  lift_upper?: number | null;
  /** Probability this variant beats the control on this metric (direction from the metric's `better`). */
  chance_to_beat_control?: number | null;
}

export interface VariantResult {
  id: string;
  name: string;
  offering_id: string | null;
  customers: number;
  paywall_viewers: number;
  metrics: Record<string, MetricValue>;
}

export interface Guidance {
  enough_data: boolean;
  min_customers: number;
  min_events: number;
  /** Customers each variant needs to detect a 20% relative lift on the primary metric (null until the control has data). */
  customers_needed_per_variant: number | null;
  leader: { variant_id: string; chance_to_beat_control: number } | null;
  message: string;
}

export interface ExperimentResults {
  variants: VariantResult[];
  guidance: Guidance;
  series: { days: number[]; values: Record<string, Record<string, (number | null)[]>> };
}

export const MIN_CUSTOMERS = 100;
export const MIN_EVENTS = 10;
const GRACE = 60_000;
const txKey = (store: string, id: string) => `${store}|${id}`;
const isMoney = (k: string) => k === "purchase" || k === "renewal" || k === "one_time";

interface Trial { start: number; completeAt: number; convertedAt: number | null }
interface Facts {
  id: string;
  variant: string;
  enrolledAt: number;
  convAt: number;
  trials: Trial[];
  firstPaidAt: number;
  firstRefundAt: number;
  money: { at: number; usd: number }[];
  subs: Sub[];
  firstPaidSubAt: number;
}

/** When a subscription's chain ends now by the store's current state (an early expiry or a lapse the ledger row predates). */
const stateEnd = (s: Sub) => (s.state ? (s.state.expiresAt === null ? Infinity : Math.max(s.state.expiresAt, s.state.graceUntil ?? 0)) : Infinity);

/** `startAt`: when each customer starts to count (their enrollment, or their first paywall view after it). */
function factsOf(input: ResultsInput, included: Set<string>, startAt: Map<string, number>): Map<string, Facts> {
  const enr = new Map(input.enrollments.filter((e) => included.has(e.customerId)).map((e) => [e.customerId, { ...e, enrolledAt: startAt.get(e.customerId) ?? e.enrolledAt }]));
  const txs = input.txs.filter((t) => enr.has(t.customerId));
  const subs = buildSubscriptions({ now: input.now, txs, products: input.products, subStates: input.subStates.filter((s) => enr.has(s.customerId)), lifecycle: input.lifecycle.filter((l) => enr.has(l.customerId)), customers: [], sdkEvents: [], refundEvents: [], activity: [], fx: () => 1 });
  const successors = new Map<Sub, Sub[]>();
  for (const s of subs) if (s.predecessor) successors.set(s.predecessor, [...(successors.get(s.predecessor) ?? []), s]);
  const conversionAt = (s: Sub): number | null => {
    if (s.paidStart !== null) return s.paidStart;
    const next = (successors.get(s) ?? []).map((x) => x.paidStart).filter((x): x is number => x !== null);
    return next.length ? Math.min(...next) : null;
  };
  // A product change made during a trial continues that trial: one trial, which ends when the last product's trial does.
  const continuesTrial = (s: Sub) => s.origin === "product_change" && s.trialStart !== null && !!s.predecessor && s.predecessor.trialStart !== null && s.predecessor.paidStart === null;
  const lastTrialLink = (s: Sub): Sub => { const next = (successors.get(s) ?? []).find(continuesTrial); return next ? lastTrialLink(next) : s; };

  const out = new Map<string, Facts>();
  for (const [id, e] of enr) out.set(id, { id, variant: e.variant, enrolledAt: e.enrolledAt, convAt: Infinity, trials: [], firstPaidAt: Infinity, firstRefundAt: Infinity, money: [], subs: [], firstPaidSubAt: Infinity });
  const keys = new Set<string>();
  // A product change continues the subscription it replaced: it counts only when the first one started after joining.
  const rootStart = (s: Sub) => { let r = s; while (r.predecessor) r = r.predecessor; return r.start; };
  for (const s of subs) {
    const f = out.get(s.customerId)!;
    if (rootStart(s) < f.enrolledAt - GRACE) continue;
    f.subs.push(s);
    f.convAt = Math.min(f.convAt, s.start);
    if (s.paidStart !== null) f.firstPaidSubAt = Math.min(f.firstPaidSubAt, s.paidStart);
    if (s.trialStart !== null && !continuesTrial(s)) {
      const last = lastTrialLink(s);
      const conv = conversionAt(last);
      f.trials.push({ start: s.trialStart, completeAt: Math.min(last.trialEnd ?? Infinity, conv ?? Infinity), convertedAt: conv });
    }
    for (const p of s.periods) keys.add(txKey(s.store, p.storeTransactionId));
  }
  for (const t of txs) if (t.kind === "one_time" && t.at >= out.get(t.customerId)!.enrolledAt - GRACE) {
    keys.add(txKey(t.store, t.storeTransactionId));
    const f = out.get(t.customerId)!;
    f.convAt = Math.min(f.convAt, t.at);
  }
  // Refunds net of reversals: a reversed refund is not a refunded customer.
  const refunded = refundTimes(txs);
  for (const t of txs) {
    if (!keys.has(txKey(t.store, t.storeTransactionId))) continue;
    const f = out.get(t.customerId)!;
    f.money.push({ at: t.at, usd: t.usd });
    if (isMoney(t.kind) && t.usd > 0) f.firstPaidAt = Math.min(f.firstPaidAt, t.at);
    const r = t.kind === "refund" ? refunded.get(txKey(t.store, t.storeTransactionId)) : undefined;
    if (r !== undefined) f.firstRefundAt = Math.min(f.firstRefundAt, r);
  }
  for (const f of out.values()) f.money.sort((a, b) => a.at - b.at);
  return out;
}

interface Measured {
  counts: Record<string, number>;
  /** Revenue and MRR of the customers with any purchase; `idle` more customers have none (0 each). */
  revenue: number[];
  revenuePaying: number[];
  mrr: number[];
  mrrPaying: number[];
  idle: number;
}

/**
 * One variant's customers: those with a purchase or trial after joining, and when each of the others joined (sorted).
 * Most enrolled customers never buy, so the daily series only walks the first list.
 */
interface Group { active: Facts[]; idleJoined: number[] }
const isIdle = (f: Facts) => !f.subs.length && !f.money.length && !f.trials.length && f.convAt === Infinity && f.firstPaidAt === Infinity && f.firstRefundAt === Infinity;
function groupOf(list: Facts[]): Group {
  const active: Facts[] = [], idleJoined: number[] = [];
  for (const f of list) if (isIdle(f)) idleJoined.push(f.enrolledAt); else active.push(f);
  idleJoined.sort((a, b) => a - b);
  return { active, idleJoined };
}
/** How many of the sorted values are at most `t`. */
function countAtMost(sorted: number[], t: number) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Every metric's raw ingredients for one variant as of `t`. */
function measure(g: Group, t: number): Measured {
  const c = { customers: 0, initial_conversions: 0, trials_started: 0, trials_completed: 0, trials_converted: 0, paid_customers: 0, active_subscribers: 0, churned_subscribers: 0, refunded_customers: 0 };
  const revenue: number[] = [], revenuePaying: number[] = [], mrr: number[] = [], mrrPaying: number[] = [];
  const idle = countAtMost(g.idleJoined, t);
  c.customers = idle;
  for (const f of g.active) {
    if (f.enrolledAt > t) continue;
    c.customers++;
    if (f.convAt <= t) c.initial_conversions++;
    for (const tr of f.trials) {
      if (tr.start <= t) c.trials_started++;
      if (tr.completeAt <= t) c.trials_completed++;
      if (tr.convertedAt !== null && tr.convertedAt <= t) c.trials_converted++;
    }
    const paid = f.firstPaidAt <= t;
    if (paid) c.paid_customers++;
    let m = 0, active = false;
    for (const s of f.subs) { const p = t < stateEnd(s) ? paidAt(s, t) : null; if (p) { active = true; m += p.monthly; } }
    if (active) c.active_subscribers++;
    // Churned: paid for a subscription (a $0 period is not paying) and has none active now.
    if (paid && f.firstPaidSubAt <= t && !active) c.churned_subscribers++;
    if (f.firstRefundAt <= t) c.refunded_customers++;
    let r = 0;
    for (const x of f.money) { if (x.at > t) break; r += x.usd; }
    revenue.push(r); mrr.push(m);
    if (paid) { revenuePaying.push(r); mrrPaying.push(m); }
  }
  return { counts: c, revenue, revenuePaying, mrr, mrrPaying, idle };
}

const RATES: Record<string, [string, string]> = {
  initial_conversion_rate: ["initial_conversions", "customers"],
  trial_conversion_rate: ["trials_converted", "trials_completed"],
  conversion_to_paying: ["paid_customers", "customers"],
  refund_rate: ["refunded_customers", "paid_customers"],
};
const MEANS: Record<string, "revenue" | "revenuePaying" | "mrr" | "mrrPaying"> = {
  realized_ltv_per_customer: "revenue", realized_ltv_per_paying_customer: "revenuePaying", mrr_per_customer: "mrr", mrr_per_paying_customer: "mrrPaying",
};
/** A per-customer mean's values: per customer, idle customers (0) included; per paying customer, payers only. */
const meanOf = (m: Measured, id: string): Summary => { const k = MEANS[id]!; return summarize(m[k], k === "revenue" || k === "mrr" ? m.idle : 0); };
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** A metric's value from what was measured (no intervals): used for the series. */
function plainValue(id: string, m: Measured): number | null {
  if (RATES[id]) { const [k, n] = RATES[id]!; return m.counts[n]! > 0 ? m.counts[k]! / m.counts[n]! : null; }
  if (MEANS[id]) { const k = MEANS[id]!; const n = m[k].length + (k === "revenue" || k === "mrr" ? m.idle : 0); return n ? sum(m[k]) / n : null; }
  if (id === "realized_ltv") return sum(m.revenue);
  if (id === "mrr") return sum(m.mrr);
  return m.counts[id] ?? null;
}

function withStats(def: MetricDef, m: Measured, control: Measured | null): MetricValue {
  const r = (x: number | null | undefined, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : round(x, d));
  if (def.kind === "rate") {
    const [kk, nn] = RATES[def.id]!;
    const k = m.counts[kk]!, n = m.counts[nn]!;
    const ci = wilson(k, n);
    const out: MetricValue = { value: n ? r(k / n) : null, numerator: k, denominator: n, lower: r(ci?.lower), upper: r(ci?.upper) };
    if (control) {
      const kc = control.counts[kk]!, nc = control.counts[nn]!;
      const lift = rateLift(k, n, kc, nc);
      const chance = n && nc ? (def.better === "higher" ? chanceRateBeats(k, n, kc, nc) : chanceRateBeats(kc, nc, k, n)) : null;
      Object.assign(out, { lift: r(lift?.lift), lift_lower: r(lift?.lower), lift_upper: r(lift?.upper), chance_to_beat_control: r(chance, 4) });
    }
    return out;
  }
  if (def.kind === "mean") {
    const s = meanOf(m, def.id);
    const ci = meanInterval(s);
    const out: MetricValue = { value: s.n ? r(s.mean, 4) : null, denominator: s.n, lower: r(ci?.lower, 4), upper: r(ci?.upper, 4) };
    if (control) {
      const sc = meanOf(control, def.id);
      // An interval needs two customers on each side; with one, only the lift itself.
      const lift = s.n >= 2 && sc.n >= 2 ? liftInterval({ value: s.mean, se: s.se }, { value: sc.mean, se: sc.se })
        : s.n && sc.n && sc.mean > 0 ? { lift: s.mean / sc.mean - 1, lower: null, upper: null } : null;
      Object.assign(out, { lift: r(lift?.lift), lift_lower: r(lift?.lower), lift_upper: r(lift?.upper), chance_to_beat_control: r(chanceMeanBeats(s, sc), 4) });
    }
    return out;
  }
  const v = plainValue(def.id, m);
  return { value: v === null ? null : def.unit === "$" ? round(v, 2) : v };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function guidanceOf(input: ResultsInput, variants: VariantResult[], measured: Map<string, Measured>): Guidance {
  const def = metricDef(input.primaryMetric) ?? metricDef("initial_conversion_rate")!;
  const control = measured.get(input.controlId);
  // Events: a rate of customers needs its conversions; a rate of a sub-population (trials, payers) needs that population.
  const events = (m: Measured) => {
    if (def.kind !== "rate") return m.counts.paid_customers!;
    const [k, n] = RATES[def.id]!;
    return n === "customers" ? m.counts[k]! : m.counts[n]!;
  };
  const enough = variants.length > 1 && variants.every((v) => v.customers >= MIN_CUSTOMERS && events(measured.get(v.id)!) >= MIN_EVENTS);
  let needed: number | null = null;
  if (control) {
    if (def.kind === "rate") { const [k, n] = RATES[def.id]!; needed = control.counts[n]! ? sampleSizeRate(control.counts[k]! / control.counts[n]!) : null; }
    else { const s = meanOf(control, def.id); needed = s.n > 1 ? sampleSizeMean(s.mean, s.sd) : null; }
    // A metric measured on a sub-population (trials, payers) needs that many of them, not customers: scale back up.
    const population = def.kind === "rate" ? RATES[def.id]![1] : MEANS[def.id] === "revenuePaying" || MEANS[def.id] === "mrrPaying" ? "paid_customers" : "customers";
    if (needed !== null && population !== "customers" && control.counts[population]! > 0 && control.counts.customers! > 0) {
      needed = Math.ceil(needed * (control.counts.customers! / control.counts[population]!));
    }
  }
  const treatments = variants.filter((v) => v.id !== input.controlId);
  let leader: Guidance["leader"] = null;
  for (const v of treatments) {
    const ch = v.metrics[def.id]?.chance_to_beat_control;
    if (ch !== null && ch !== undefined && (!leader || ch > leader.chance_to_beat_control)) leader = { variant_id: v.id, chance_to_beat_control: ch };
  }
  const total = variants.reduce((s, v) => s + v.customers, 0);
  const fewest = Math.min(...variants.map((v) => v.customers));
  const name = (id: string) => variants.find((v) => v.id === id)?.name ?? id;
  let message: string;
  if (!total) message = "Nobody is enrolled yet. Customers join when your app asks for offerings while the experiment runs.";
  else if (!enough) {
    const what = def.kind !== "rate" ? "paying customers" : RATES[def.id]![1] === "customers" ? "conversions" : RATES[def.id]![1] === "trials_completed" ? "completed trials" : "paying customers";
    message = `Too early to call: each variant needs at least ${MIN_CUSTOMERS} customers and ${MIN_EVENTS} ${what} for ${def.name}.`;
    if (needed) message += ` To detect a 20% lift, plan for about ${needed.toLocaleString("en-US")} customers per variant (the smallest has ${fewest.toLocaleString("en-US")}).`;
  } else if (leader && leader.chance_to_beat_control >= 0.95) message = `${name(leader.variant_id)} leads: ${pct(leader.chance_to_beat_control)} chance to beat the control on ${def.name}.`;
  else if (treatments.length && treatments.every((v) => (v.metrics[def.id]?.chance_to_beat_control ?? 1) <= 0.05)) message = `The control leads: every treatment has at most a 5% chance to beat it on ${def.name}.`;
  else message = `No clear winner yet on ${def.name}${leader ? `: the best treatment, ${name(leader.variant_id)}, has a ${pct(leader.chance_to_beat_control)} chance to beat the control` : ""}. Many teams wait for 95%.${needed ? ` About ${needed.toLocaleString("en-US")} customers per variant would show a 20% lift.` : ""}`;
  return { enough_data: enough, min_customers: MIN_CUSTOMERS, min_events: MIN_EVENTS, customers_needed_per_variant: needed, leader, message };
}

export function computeExperimentResults(input: ResultsInput): ExperimentResults {
  const enrolledAt = new Map(input.enrollments.map((e) => [e.customerId, e.enrolledAt]));
  // First paywall view after joining, per customer.
  const viewed = new Map<string, number>();
  for (const v of input.paywallViews) {
    const at = enrolledAt.get(v.customerId);
    if (at !== undefined && v.at >= at - GRACE) viewed.set(v.customerId, Math.min(viewed.get(v.customerId) ?? Infinity, Math.max(v.at, at)));
  }
  const included = new Set(input.enrollments.map((e) => e.customerId).filter((id) => input.paywall === "all" || (input.paywall === "viewed" ? viewed.has(id) : !viewed.has(id))));
  // Viewers only: each customer counts from their first paywall view (what they bought before it does not count).
  const facts = factsOf(input, included, input.paywall === "viewed" ? viewed : new Map());
  const byVariant = new Map<string, Facts[]>(input.variants.map((v) => [v.id, []]));
  for (const f of facts.values()) byVariant.get(f.variant)?.push(f);
  const groups = new Map(input.variants.map((v) => [v.id, groupOf(byVariant.get(v.id)!)]));

  // As of now, plus a minute of grace for store clocks a little ahead of ours.
  const measured = new Map(input.variants.map((v) => [v.id, measure(groups.get(v.id)!, input.now + GRACE)]));
  const control = measured.get(input.controlId) ?? null;
  const variants: VariantResult[] = input.variants.map((v) => {
    const m = measured.get(v.id)!;
    const isControl = v.id === input.controlId;
    return {
      id: v.id, name: v.name, offering_id: v.offering_id, customers: m.counts.customers!,
      paywall_viewers: byVariant.get(v.id)!.filter((f) => viewed.has(f.id)).length,
      metrics: Object.fromEntries(EXPERIMENT_METRICS.map((d) => [d.id, withStats(d, m, isControl ? null : control)])),
    };
  });

  // Series: each metric as of the end of each day.
  // A loop, not Math.min(...): spreading 100,000+ values overflows the call stack.
  let firstEnroll: number | null = null;
  for (const e of input.enrollments) if (firstEnroll === null || e.enrolledAt < firstEnroll) firstEnroll = e.enrolledAt;
  const fromRaw = input.seriesFrom ?? firstEnroll;
  const to = Math.min(input.seriesTo ?? input.now, input.now);
  const days: number[] = [];
  if (fromRaw !== null && fromRaw <= to) {
    const maxDays = input.maxDays ?? 400;
    let d = Math.max(dayStart(fromRaw), dayStart(to) - (maxDays - 1) * DAY);
    for (; d <= to; d += DAY) days.push(d);
  }
  const values: ExperimentResults["series"]["values"] = Object.fromEntries(EXPERIMENT_METRICS.map((d) => [d.id, Object.fromEntries(input.variants.map((v) => [v.id, [] as (number | null)[]]))]));
  for (const day of days) {
    const t = Math.min(day + DAY - 1, input.now + GRACE);
    for (const v of input.variants) {
      const m = measure(groups.get(v.id)!, t);
      for (const d of EXPERIMENT_METRICS) {
        const x = plainValue(d.id, m);
        values[d.id]![v.id]!.push(x === null ? null : round(x, d.unit === "%" ? 6 : d.unit === "$" ? 4 : 0));
      }
    }
  }
  return { variants, guidance: guidanceOf(input, variants, measured), series: { days, values } };
}
