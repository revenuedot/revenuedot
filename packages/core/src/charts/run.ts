import { customAttributeKey, isCustomAttributeDim, type ChartDef, type Dim } from "./catalog.js";
import { ATTRIBUTION_DIMS, type AttributionDim } from "../attribution.js";
import { computeChart, Frame, Prepared, type ChartOutput, type ChartRequest } from "./compute.js";
import { productIndex, type ChartCustomer, type ChartInput } from "./model.js";
import { AD_REVENUE_TAG, isPeriodDim, tagValue, txTag } from "./periods.js";

/** One filter: values are OR-ed; `exclude` keeps everything except them (the "Other" segment). */
export interface ChartFilter { name: Dim; values: string[]; exclude?: boolean }

/** The value of a dimension for each kind of row; undefined when the dimension does not apply to that kind of row. */
type Getter = (dim: Dim) => string | null | undefined;
const CUSTOMER_DIMS = new Set<Dim>(["country", "platform", "app_version", ...ATTRIBUTION_DIMS]);
const isAttribution = (d: Dim): d is AttributionDim => (ATTRIBUTION_DIMS as string[]).includes(d);
/** Dimensions of the customer (they filter customers and everything they did); custom attributes are customer dimensions. */
const isCustomerDim = (d: Dim) => CUSTOMER_DIMS.has(d) || isCustomAttributeDim(d);

function getters(input: ChartInput) {
  const customers = new Map<string, ChartCustomer>(input.customers.map((c) => [c.id, c]));
  const product = productIndex(input.products);
  const fromCustomer = (id: string | null, dim: Dim) => {
    const c = id ? customers.get(id) : undefined;
    if (isAttribution(dim)) return c?.attribution?.[dim] ?? null;
    if (isCustomAttributeDim(dim)) return c?.attributes?.[customAttributeKey(dim)] ?? null;
    return dim === "country" ? c?.country ?? null : dim === "platform" ? c?.platform ?? null : dim === "app_version" ? c?.appVersion ?? null : undefined;
  };
  const purchase = (x: { customerId: string; appId: string | null; store: string; productId: string; country?: string | null; offering?: string | null }): Getter => (dim) => {
    switch (dim) {
      case "app": return x.appId;
      case "store": return x.store;
      case "product": return x.productId;
      case "product_duration": return product(x.appId, x.productId)?.duration ?? null;
      case "offering": return x.offering ?? null;
      case "country": return x.country ?? fromCustomer(x.customerId, "country");
      default: return fromCustomer(x.customerId, dim);
    }
  };
  return { fromCustomer, purchase };
}

const matches = (v: string | null | undefined, f: ChartFilter) => {
  if (v === undefined) return true;
  const hit = f.values.includes(v ?? "");
  return f.exclude ? !hit : hit;
};

/**
 * Applies filters to every kind of row the dimension describes. Customer dimensions filter customers and everything
 * they did; purchase dimensions (store, product …) filter purchases but leave customers alone, so the new-customer
 * denominators of conversion charts do not change (RevenueCat: product filters do not apply to new customers).
 */
export function restrict(input: ChartInput, all: ChartFilter[]): ChartInput {
  if (!all.length) return input;
  // Renewal cycle and offer type select periods of subscriptions built from every row (periods.ts): kept for Prepared.
  const period = all.filter((f) => isPeriodDim(f.name));
  const filters = all.filter((f) => !isPeriodDim(f.name));
  if (period.length) input = { ...input, periodFilters: [...(input.periodFilters ?? []), ...period] };
  if (!filters.length) return input;
  const g = getters(input);
  const keep = (get: Getter) => filters.every((f) => matches(get(f.name), f));
  const customerOk = new Set(input.customers.filter((c) => keep((d) => g.fromCustomer(c.id, d))).map((c) => c.id));
  const custFiltered = filters.some((f) => isCustomerDim(f.name));
  const byCustomer = (id: string | null) => !custFiltered || (id !== null && customerOk.has(id));
  return {
    ...input,
    customers: input.customers.filter((c) => customerOk.has(c.id)),
    txs: input.txs.filter((t) => keep(g.purchase(t))),
    subStates: input.subStates.filter((s) => keep(g.purchase({ ...s, offering: s.offering }))),
    lifecycle: input.lifecycle.filter((e) => keep((d) => (d === "app" || d === "offering" ? undefined : g.purchase({ ...e, appId: null })(d)))),
    sdkEvents: input.sdkEvents.filter((e) => byCustomer(e.customerId) && keep((d) => d === "app" ? e.appId : d === "paywall" ? e.paywallId ?? null : d === "survey_option" ? e.surveyOptionId ?? null : CUSTOMER_DIMS.has(d) ? undefined : undefined)),
    refundEvents: input.refundEvents.filter((e) => byCustomer(e.customerId) && keep((d) => d === "app" ? e.appId : d === "store" ? e.store : undefined)),
    activity: input.activity.filter((a) => byCustomer(a.customerId)),
  };
}

/** Every value a dimension takes in the rows (null as ""), most frequent first. */
export function dimValues(input: ChartInput, dim: Dim): string[] {
  const g = getters(input);
  const counts = new Map<string, number>();
  const add = (v: string | null | undefined) => { if (v !== undefined) counts.set(v ?? "", (counts.get(v ?? "") ?? 0) + 1); };
  const sorted = () => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  if (isPeriodDim(dim)) {
    // Each ledger row's period: trials, paid periods by cycle, one-time purchases ("") and their offer types.
    const d = new Prepared(input);
    const { byTx } = d.periodTags;
    for (const t of d.baseTxs) if (t.kind !== "refund" && t.kind !== "refund_reversal") add(tagValue(txTag(byTx, t), dim));
    // Ad revenue (Revenue chart) belongs to no period: its value gets a segment too, so segments add up to the total.
    for (const e of input.sdkEvents) if (e.type === "rc_ads_ad_revenue") add(tagValue(AD_REVENUE_TAG, dim));
    return sorted();
  }
  if (isCustomerDim(dim)) for (const c of input.customers) add(g.fromCustomer(c.id, dim));
  if (!isCustomerDim(dim) || dim === "country") for (const t of input.txs) if (t.store !== "promotional") add(g.purchase(t)(dim));
  for (const e of input.sdkEvents) add(dim === "app" ? e.appId : dim === "paywall" ? e.paywallId ?? null : dim === "survey_option" ? e.surveyOptionId ?? null : undefined);
  return sorted();
}

export interface SegmentResult { id: string; isOther: boolean; output: ChartOutput }
export interface RunResult { output: ChartOutput; segments: SegmentResult[] | null }

/** Size of a series for ranking segments: the first measure summed over periods (its last value for snapshots). */
function weight(def: ChartDef, o: ChartOutput): number {
  if (o.kind === "cohort") return o.rows.reduce((s, r) => s + (r.cells[0]?.value ?? 0), 0);
  const vals = o.points.map((p) => p.values[0] ?? 0);
  return def.shape === "stock" ? Math.abs(vals[vals.length - 1] ?? 0) : vals.reduce((s, v) => s + Math.abs(v), 0);
}

/**
 * Computes a chart: filters, then either one result or one per segment value (plus "Other" past `limit`).
 * At most 50 segment values are computed one by one; the rest always go to "Other".
 */
export function runChart(def: ChartDef, input: ChartInput, req: ChartRequest, opts: { filters?: ChartFilter[]; segment?: Dim | null; limit?: number | null } = {}): RunResult {
  const filtered = restrict(input, opts.filters ?? []);
  const frame = new Frame(req, input.now);
  const run = (inp: ChartInput) => computeChart(def, new Prepared(inp), frame, req.selectors);
  const output = run(filtered);
  if (!opts.segment) return { output, segments: null };
  const dim = opts.segment;
  const values = dimValues(filtered, dim);
  const head = values.slice(0, 50);
  let segs = head.map((v) => ({ id: v, isOther: false, output: run(restrict(filtered, [{ name: dim, values: [v] }])) }));
  segs.sort((a, b) => weight(def, b.output) - weight(def, a.output));
  const limit = opts.limit ?? null;
  const top = limit !== null ? segs.slice(0, limit) : segs;
  const rest = values.filter((v) => !top.some((s) => s.id === v));
  segs = top;
  if (rest.length) segs.push({ id: "Other", isOther: true, output: run(restrict(filtered, [{ name: dim, values: top.map((s) => s.id), exclude: true }])) });
  return { output, segments: segs };
}
