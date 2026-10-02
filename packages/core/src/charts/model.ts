import { DAY, HOUR, mrrFactor } from "./time.js";

/**
 * The rows every chart is computed from, already scoped to one project and one environment, with times in epoch ms.
 * The server loads them (apps/server/src/services/charts); tests build them by hand.
 */
export type TxKind = "trial" | "purchase" | "renewal" | "one_time" | "refund" | "refund_reversal";

/** One row of the `transactions` ledger. `usd` is negative for refunds. */
export interface ChartTx {
  id: string;
  customerId: string;
  appId: string | null;
  store: string;
  storeTransactionId: string;
  productId: string;
  kind: TxKind;
  at: number;
  expiresAt: number | null;
  usd: number;
  country: string | null;
  /** The offering the SDK presented with the purchase, when known. */
  offering?: string | null;
  /** The store's commission rate for this transaction (commission.ts); the store's default rate when absent. */
  commission?: number;
}

export interface ChartCustomer {
  id: string;
  firstSeen: number;
  country: string | null;
  platform: string | null;
  appVersion: string | null;
}

export interface ChartProduct { appId: string | null; storeIdentifier: string; type: string; duration: string | null }

/** The current state of one subscription chain (the `subscriptions` row), keyed like the ledger: customer, store, app, product. */
export interface ChartSubState {
  customerId: string;
  store: string;
  appId: string | null;
  productId: string;
  expiresAt: number | null;
  autoRenew: boolean;
  billingIssue: boolean;
  graceUntil: number | null;
  familyShared: boolean;
  offering: string | null;
  cancelSurveyReason: string | null;
  /** When the store last reported auto-renew off (Google cancellations), for the cancel reasons chart. */
  unsubscribeAt: number | null;
}

/** Lifecycle moments from the `events` table that the ledger does not hold. */
export interface ChartLifecycle {
  customerId: string;
  store: string;
  productId: string;
  type: "CANCELLATION" | "UNCANCELLATION" | "BILLING_ISSUE";
  at: number;
}

/** A paywall, Customer Center or ad event the SDK posted to /v1/events. Ad revenue is already in USD. */
export interface ChartSdkEvent {
  customerId: string | null;
  appId: string | null;
  type: string;
  at: number;
  paywallId?: string | null;
  surveyOptionId?: string | null;
  revenueUsd?: number | null;
}

/** An Apple refund request or outcome, from store notifications. */
export interface ChartRefundEvent {
  transactionId: string;
  kind: "request" | "granted" | "declined" | "reversed";
  at: number;
  appId: string | null;
  store: string;
  customerId: string | null;
  usd: number | null;
  /** When the refunded transaction was bought: its money converts at that date's rate. */
  purchasedAt: number | null;
}

export interface ChartInput {
  now: number;
  txs: ChartTx[];
  customers: ChartCustomer[];
  products: ChartProduct[];
  subStates: ChartSubState[];
  lifecycle: ChartLifecycle[];
  sdkEvents: ChartSdkEvent[];
  refundEvents: ChartRefundEvent[];
  /** Customer id and UTC day start (ms) of each day with SDK activity. */
  activity: { customerId: string; day: number }[];
  /** USD → display currency multiplier on a date (1 for USD). */
  fx: (at: number) => number;
}

/** One paid or trial period of a subscription. */
export interface Period {
  start: number;
  /** Effective end: expiry, cut short by a refund, extended by a grace period, or the moment a product change replaced it. */
  end: number;
  trial: boolean;
  /** Price in the display currency at the purchase-date rate. */
  money: number;
  /** Monthly value in the display currency (0 for trials). */
  monthly: number;
  storeTransactionId: string;
}

/**
 * A subscription the way RevenueCat's Charts v3 counts them: one product in one store and app for one customer, from
 * its first period until access lapses. A resubscription after a lapse is a new subscription; a billing recovery is not.
 */
export interface Sub {
  id: string;
  customerId: string;
  store: string;
  appId: string | null;
  productId: string;
  duration: string | null;
  offering: string | null;
  country: string | null;
  periods: Period[];
  start: number;
  end: number;
  /** First paid (non-trial) period start. */
  paidStart: number | null;
  trialStart: number | null;
  trialEnd: number | null;
  origin: "new" | "resubscription" | "product_change";
  predecessor: Sub | null;
  /** Set when a product change ended this subscription. */
  replacedAt: number | null;
  /** Billing-retry gaps the subscription recovered from: inactive in [from, to). */
  gaps: { from: number; to: number }[];
  /** The chain's current state when this is the chain's latest subscription. */
  state: ChartSubState | null;
}

export const chainKey = (x: { customerId: string; store: string; appId: string | null; productId: string }) => `${x.customerId}|${x.store}|${x.appId ?? ""}|${x.productId}`;
const txKey = (store: string, id: string) => `${store}|${id}`;

/** Refund time per store transaction, net of reversals: a reversed refund gives the period back. */
export function refundTimes(txs: ChartTx[]): Map<string, number> {
  const refunds = new Map<string, number[]>();
  const reversals = new Map<string, number>();
  for (const t of txs) {
    const k = txKey(t.store, t.storeTransactionId);
    if (t.kind === "refund") refunds.set(k, [...(refunds.get(k) ?? []), t.at]);
    if (t.kind === "refund_reversal") reversals.set(k, (reversals.get(k) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [k, at] of refunds) if (at.length > (reversals.get(k) ?? 0)) out.set(k, Math.max(...at));
  return out;
}

/** The purchase date of each store transaction (for converting its refund at the purchase-date rate). */
export function purchaseTimes(txs: ChartTx[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of txs) if (t.kind !== "refund" && t.kind !== "refund_reversal") out.set(txKey(t.store, t.storeTransactionId), t.at);
  return out;
}

/** Money of a ledger row in the display currency, at the rate of the purchase it belongs to. */
export function moneyOf(t: ChartTx, input: ChartInput, purchases: Map<string, number>): number {
  const at = t.kind === "refund" || t.kind === "refund_reversal" ? purchases.get(txKey(t.store, t.storeTransactionId)) ?? t.at : t.at;
  return t.usd * input.fx(at);
}

export function productIndex(products: ChartProduct[]) {
  const byApp = new Map<string, ChartProduct>();
  const any = new Map<string, ChartProduct>();
  const add = (key: string, p: ChartProduct) => { if (!byApp.has(`${p.appId ?? ""}|${key}`)) byApp.set(`${p.appId ?? ""}|${key}`, p); if (!any.has(key)) any.set(key, p); };
  for (const p of products) add(p.storeIdentifier, p);
  // Google products are "subscription:base_plan" in the catalog while the ledger holds the subscription id.
  for (const p of products) if (p.storeIdentifier.includes(":")) add(p.storeIdentifier.split(":")[0]!, p);
  return (appId: string | null, productId: string) => byApp.get(`${appId ?? ""}|${productId}`) ?? any.get(productId) ?? null;
}

/** Excluded from every money and subscription measure: granted access and Family Sharing. */
export const isExcludedStore = (store: string) => store === "promotional";

/**
 * Builds subscriptions from the ledger (see prd/charts/PRD.md, "How a subscription is built"):
 * periods from trial, purchase and renewal rows, cut by refunds; split into subscriptions at gaps longer than an hour
 * unless a billing issue explains the gap; the latest period extended by a current grace period; product changes end
 * the replaced subscription.
 */
export function buildSubscriptions(input: ChartInput): Sub[] {
  const product = productIndex(input.products);
  const refunds = refundTimes(input.txs);
  const states = new Map<string, ChartSubState>();
  for (const s of input.subStates) states.set(chainKey(s), s);
  const billingIssues = new Map<string, number[]>();
  for (const e of input.lifecycle) {
    if (e.type !== "BILLING_ISSUE") continue;
    const k = `${e.customerId}|${e.store}|${e.productId}`;
    billingIssues.set(k, [...(billingIssues.get(k) ?? []), e.at]);
  }

  // 1. Periods per chain.
  type Raw = { tx: ChartTx; start: number; end: number };
  const chains = new Map<string, Raw[]>();
  for (const t of input.txs) {
    if (t.kind !== "trial" && t.kind !== "purchase" && t.kind !== "renewal") continue;
    if (isExcludedStore(t.store)) continue;
    const k = chainKey(t);
    if (states.get(k)?.familyShared) continue;
    let end = t.expiresAt ?? Infinity;
    const refundedAt = refunds.get(txKey(t.store, t.storeTransactionId));
    if (refundedAt !== undefined) end = Math.min(end, refundedAt);
    const list = chains.get(k) ?? [];
    // The same store transaction can appear once per kind; keep the first.
    if (!list.some((r) => r.tx.storeTransactionId === t.storeTransactionId && r.tx.kind === t.kind)) list.push({ tx: t, start: t.at, end });
    chains.set(k, list);
  }

  // 2. Split chains into subscriptions.
  const subs: Sub[] = [];
  let n = 0;
  for (const [k, raw] of chains) {
    raw.sort((a, b) => a.start - b.start);
    const first = raw[0]!.tx;
    const p = product(first.appId, first.productId);
    const duration = p?.duration ?? null;
    const factorOf = (r: Raw) => mrrFactor(duration) ?? (Number.isFinite(r.tx.expiresAt ?? Infinity) ? 30 * DAY / Math.max(DAY, (r.tx.expiresAt as number) - r.tx.at) : 0);
    let cur: Sub | null = null;
    let lastEnd = -Infinity;
    for (const r of raw) {
      const money = r.tx.usd * input.fx(r.tx.at);
      const trial = r.tx.kind === "trial";
      const period: Period = { start: r.start, end: Math.max(r.start, r.end), trial, money: trial ? 0 : money, monthly: trial ? 0 : money * factorOf(r), storeTransactionId: r.tx.storeTransactionId };
      if (cur && r.start <= lastEnd + HOUR) {
        cur.periods.push(period);
      } else if (cur && r.tx.kind === "renewal" && r.start - lastEnd <= 60 * DAY
        && (billingIssues.get(`${first.customerId}|${first.store}|${first.productId}`) ?? []).some((at) => at >= lastEnd - DAY && at <= r.start)) {
        cur.gaps.push({ from: lastEnd, to: r.start });
        cur.periods.push(period);
      } else {
        cur = {
          id: `${k}#${n++}`, customerId: first.customerId, store: first.store, appId: first.appId, productId: first.productId, duration,
          offering: r.tx.offering ?? null, country: r.tx.country, periods: [period], start: r.start, end: 0, paidStart: null, trialStart: null,
          trialEnd: null, origin: "new", predecessor: null, replacedAt: null, gaps: [], state: null,
        };
        subs.push(cur);
      }
      lastEnd = Math.max(lastEnd, period.end);
    }
  }

  // 3. Grace period on each chain's latest subscription; derived fields.
  const latest = new Map<string, Sub>();
  for (const s of subs) { const k = chainKey(s); const l = latest.get(k); if (!l || l.start < s.start) latest.set(k, s); }
  for (const [k, s] of latest) {
    const st = states.get(k) ?? null;
    s.state = st;
    const last = s.periods[s.periods.length - 1]!;
    if (st?.graceUntil && st.graceUntil > last.end && last.end >= (st.expiresAt ?? last.end) - HOUR) last.end = st.graceUntil;
  }
  const finish = (s: Sub) => {
    s.end = Math.max(...s.periods.map((p) => p.end));
    const paid = s.periods.find((p) => !p.trial && p.end > p.start);
    s.paidStart = paid ? paid.start : null;
    const t = s.periods[0]!.trial ? s.periods[0]! : null;
    s.trialStart = t ? t.start : null;
    s.trialEnd = t ? t.end : null;
  };
  subs.forEach(finish);

  // 4. Product changes within a customer's store and app; then resubscriptions.
  const byCustomerApp = new Map<string, Sub[]>();
  for (const s of subs) { const k = `${s.customerId}|${s.store}|${s.appId ?? ""}`; byCustomerApp.set(k, [...(byCustomerApp.get(k) ?? []), s]); }
  for (const list of byCustomerApp.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const s = list[i]!;
      const prev = list.slice(0, i).filter((p) => p.productId !== s.productId && p.start < s.start && p.end >= s.start - HOUR).sort((a, b) => b.end - a.end)[0];
      if (!prev) continue;
      s.origin = "product_change";
      s.predecessor = prev;
      if (prev.end > s.start) {
        prev.replacedAt = s.start;
        prev.periods = prev.periods.filter((p) => p.start < s.start).map((p) => ({ ...p, end: Math.min(p.end, s.start) }));
        finish(prev);
      } else prev.replacedAt = prev.end;
    }
  }
  const byCustomer = new Map<string, Sub[]>();
  for (const s of subs) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
  for (const list of byCustomer.values()) {
    for (const s of list) {
      if (s.origin !== "new") continue;
      if (list.some((o) => o !== s && o.paidStart !== null && o.end <= s.start + HOUR && o.start < s.start)) s.origin = "resubscription";
    }
  }
  return subs;
}

/** The paid period that gives access at `t`, if any. */
export function paidAt(s: Sub, t: number): Period | null {
  if (t < s.start || t >= s.end) return null;
  for (const p of s.periods) if (!p.trial && p.start <= t && t < p.end) return p;
  return null;
}
export function trialAt(s: Sub, t: number): Period | null {
  if (t < s.start || t >= s.end) return null;
  for (const p of s.periods) if (p.trial && p.start <= t && t < p.end) return p;
  return null;
}

/** One change in a subscription's paid state or monthly value. */
export interface SubMove {
  at: number;
  sub: Sub;
  type: "new" | "trial_conversion" | "resubscription" | "product_change" | "churn" | "replaced" | "lapse" | "recovery" | "reprice";
  /** Change in monthly value (display currency): positive for starts, negative for ends. */
  mrr: number;
  /** +1 for a paid start or recovery, −1 for an end or lapse, 0 for a reprice. */
  actives: number;
  /** Product change from a subscription that was paid at the moment of the change. */
  paidToPaid?: boolean;
}

/** Every paid start, end, lapse, recovery and price change, for the movement and churn charts. Only moves up to `now`. */
export function subMoves(subs: Sub[], now: number): SubMove[] {
  const out: SubMove[] = [];
  for (const s of subs) {
    const paid = s.periods.filter((p) => !p.trial && p.end > p.start);
    if (!paid.length) continue;
    const first = paid[0]!;
    const predPaid = s.predecessor ? paidAt(s.predecessor, s.start - 1) ?? (s.predecessor.end >= s.start - HOUR ? [...s.predecessor.periods].reverse().find((p) => !p.trial) ?? null : null) : null;
    const type = s.origin === "resubscription" ? "resubscription" : s.origin === "product_change" ? "product_change" : s.trialStart !== null ? "trial_conversion" : "new";
    if (first.start <= now) out.push({ at: first.start, sub: s, type, mrr: first.monthly, actives: 1, paidToPaid: s.origin === "product_change" && !!predPaid && first.start === s.start });
    // Walk the paid timeline: price changes between touching periods, lapses at gaps, the final end.
    let prev = first;
    for (const p of paid.slice(1)) {
      if (p.start > now) break;
      const gap = s.gaps.find((g) => g.to === p.start);
      if (gap || p.start > prev.end + HOUR) {
        if (prev.end <= now) out.push({ at: prev.end, sub: s, type: "lapse", mrr: -prev.monthly, actives: -1 });
        out.push({ at: p.start, sub: s, type: "recovery", mrr: p.monthly, actives: 1 });
      } else if (Math.abs(p.monthly - prev.monthly) > 1e-9) {
        out.push({ at: p.start, sub: s, type: "reprice", mrr: p.monthly - prev.monthly, actives: 0 });
      }
      prev = p;
    }
    const last = paid[paid.length - 1]!;
    if (last.end <= now && last.end === s.end) out.push({ at: last.end, sub: s, type: s.replacedAt !== null && s.replacedAt === s.end ? "replaced" : "churn", mrr: -last.monthly, actives: -1 });
  }
  return out;
}
