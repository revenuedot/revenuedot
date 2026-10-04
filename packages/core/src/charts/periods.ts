import type { ChartTx, Period, Sub } from "./model.js";

/**
 * Period dimensions (prd/charts/PRD.md "Renewal cycle and offer type"): the renewal cycle and the offer type of the paid
 * period or trial a measure comes from. Unlike other dimensions they are not a property of a ledger row alone: the
 * cycle is the period's place in its built subscription. Charts therefore build subscriptions from the whole ledger and
 * keep only the periods, moves and transactions whose tags match (compute.ts `Prepared`).
 */
export const RENEWAL_CYCLE = "subscription_renewal_cycle_group";
export const OFFER_TYPE = "offer_type";
export type PeriodDim = typeof RENEWAL_CYCLE | typeof OFFER_TYPE;
export const isPeriodDim = (d: string): d is PeriodDim => d === RENEWAL_CYCLE || d === OFFER_TYPE;

/** Renewal cycle values: a trial is not a cycle; cycle 1 is the subscription's first paid period. */
export const CYCLE_LABEL: Record<string, string> = {
  trial: "Trial", cycle_1: "Cycle 1", cycle_2: "Cycle 2", cycle_3: "Cycle 3", cycle_4: "Cycle 4", cycle_5_plus: "Cycle 5+",
  "": "Non-subscription",
};
/** Offer type values. Win-back is Apple's offer type 4. */
export const OFFER_LABEL: Record<string, string> = {
  free_trial: "Free trial", introductory: "Introductory price", promotional: "Promotional offer", offer_code: "Offer code",
  win_back: "Win-back offer", no_offer: "No offer",
};
export const periodDimLabel = (dim: PeriodDim, v: string) => (dim === RENEWAL_CYCLE ? CYCLE_LABEL[v] : OFFER_LABEL[v]) ?? v;

export const cycleId = (paidIndex: number) => (paidIndex >= 5 ? "cycle_5_plus" : `cycle_${paidIndex}`);

/**
 * The offer type of a ledger row, from the `transactions.offer_type` the store mappers write: a trial row is always a free
 * trial; Google's offers that are neither a free trial nor an introductory price ("unspecified": developer-determined
 * offer phases) count as promotional offers; anything else is "no offer".
 */
export function offerTypeOf(kind: ChartTx["kind"], raw: string | null | undefined): string {
  if (kind === "trial") return "free_trial";
  if (raw === "introductory" || raw === "promotional" || raw === "offer_code" || raw === "win_back") return raw;
  if (raw === "unspecified") return "promotional";
  return "no_offer";
}

export interface PeriodTag { cycle: string; offer: string }
const key = (store: string, storeTransactionId: string, trial: boolean) => `${store}|${storeTransactionId}|${trial ? 1 : 0}`;

/** The tags of every period of the built subscriptions, by period and by store transaction. */
export function periodTags(subs: Sub[]): { byPeriod: Map<Period, PeriodTag>; byTx: Map<string, PeriodTag> } {
  const byPeriod = new Map<Period, PeriodTag>();
  const byTx = new Map<string, PeriodTag>();
  for (const s of subs) {
    let paid = 0;
    for (const p of s.periods) {
      const tag = { cycle: p.trial ? "trial" : cycleId(++paid), offer: p.offerType };
      byPeriod.set(p, tag);
      byTx.set(key(s.store, p.storeTransactionId, p.trial), tag);
    }
  }
  return { byPeriod, byTx };
}

/**
 * The tag of a ledger row: its period's, a refund's or reversal's the refunded period's. A one-time purchase (or a row
 * whose period a product change cut away) has no renewal cycle ("") and its own offer type.
 */
export function txTag(byTx: Map<string, PeriodTag>, t: ChartTx): PeriodTag {
  const own = t.kind === "trial" ? byTx.get(key(t.store, t.storeTransactionId, true))
    : t.kind === "refund" || t.kind === "refund_reversal" ? byTx.get(key(t.store, t.storeTransactionId, false)) ?? byTx.get(key(t.store, t.storeTransactionId, true))
    : t.kind === "one_time" ? undefined : byTx.get(key(t.store, t.storeTransactionId, false));
  return own ?? { cycle: "", offer: offerTypeOf(t.kind, t.offerType) };
}

export const tagValue = (tag: PeriodTag, dim: PeriodDim) => (dim === RENEWAL_CYCLE ? tag.cycle : tag.offer);
/** Ad revenue (Revenue chart) belongs to no period: no renewal cycle and no offer. */
export const AD_REVENUE_TAG: PeriodTag = { cycle: "", offer: "no_offer" };
