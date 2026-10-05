import { describe, expect, it } from "vitest";
import {
  addRollupDays, CHARTS, chartDef, chartFromRollup, commissionRates, computeRollupDays, finishRollupDays, playTierCrossings, firstDataDay, isEmptyDay, isRollupChart, ROLLUP_CHARTS, ROLLUP_VERSION, runChart,
  type ChartInput, type ChartOutput, type ChartRequest, type ChartTx, type Resolution, type RollupDay,
} from "../src/index.js";

// Daily rollups (prd/charts/PRD.md "Daily rollups") must answer exactly as the live computation does.
const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
const NOW = T("2026-09-20T15:30:00Z");

/** A deterministic random ledger: monthly, annual and weekly subscriptions, trials, refunds, product changes, lapses and resubscriptions, one-time purchases, ad events and billing issues. */
function seeded(n = 160): ChartInput {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const txs: ChartTx[] = [];
  const lifecycle: ChartInput["lifecycle"] = [];
  const subStates: ChartInput["subStates"] = [];
  const sdkEvents: ChartInput["sdkEvents"] = [];
  const customers: ChartInput["customers"] = [];
  let id = 0;
  const tx = (c: string, product: string, kind: ChartTx["kind"], at: number, exp: number | null, usd: number, store = "app_store", stx?: string): ChartTx =>
    ({ id: `t${id++}`, customerId: c, appId: "ios", store, storeTransactionId: stx ?? `${c}-${product}-${at}-${kind}`, productId: product, kind, at, expiresAt: exp, usd, country: pick(["US", "DE", "GB"]) });
  const addMonths = (t: number, m: number) => { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + m); return d.getTime(); };
  for (let i = 0; i < n; i++) {
    const c = `c${i}`;
    const start = T("2025-06-01") + Math.floor(rnd() * 470) * DAY + Math.floor(rnd() * DAY);
    customers.push({ id: c, firstSeen: start - Math.floor(rnd() * 3) * DAY, country: "US", platform: "iOS", appVersion: "1.0" });
    const store = pick(["app_store", "play_store", "stripe"]);
    const kind = rnd();
    if (kind < 0.12) { txs.push(tx(c, "coins", "one_time", start, null, 4.99, store)); continue; }
    const product = kind < 0.6 ? "monthly" : kind < 0.85 ? "annual" : "weekly";
    const len = (t: number, k: number) => (product === "monthly" ? addMonths(t, k) : product === "annual" ? addMonths(t, 12 * k) : t + 7 * k * DAY);
    const price = product === "monthly" ? 9.99 : product === "annual" ? 59.99 : 2.99;
    let at = start;
    if (rnd() < 0.4) { txs.push(tx(c, product, "trial", at, at + 7 * DAY, 0, store)); at += 7 * DAY; if (rnd() < 0.35) continue; }
    const periods = 1 + Math.floor(rnd() * 14);
    for (let k = 0; k < periods && at < NOW; k++) {
      const end = len(at, 1);
      const t = tx(c, product, k === 0 ? "purchase" : "renewal", at, end, price, store);
      txs.push(t);
      if (rnd() < 0.04) txs.push({ ...t, id: `t${id++}`, kind: "refund", at: at + 2 * DAY, expiresAt: null, usd: -price });
      if (rnd() < 0.05) lifecycle.push({ customerId: c, store, productId: product, type: "BILLING_ISSUE", at: end - DAY });
      at = end + (rnd() < 0.05 ? 3 * DAY : 0);
    }
    // Some upgrade from monthly to annual mid-period.
    if (product === "monthly" && rnd() < 0.15 && at < NOW) txs.push(tx(c, "annual", "purchase", at - 10 * DAY, addMonths(at - 10 * DAY, 12), 59.99, store));
    if (rnd() < 0.5) lifecycle.push({ customerId: c, store, productId: product, type: "CANCELLATION", at: at - 5 * DAY });
    subStates.push({ customerId: c, store, appId: "ios", productId: product, expiresAt: at, autoRenew: rnd() < 0.6, billingIssue: rnd() < 0.1, graceUntil: null, familyShared: false, offering: null, cancelSurveyReason: null, unsubscribeAt: null });
    if (rnd() < 0.3) for (let k = 0; k < 6; k++) {
      const t = start + Math.floor(rnd() * 200) * DAY;
      sdkEvents.push({ customerId: c, appId: "ios", type: "rc_ads_ad_revenue", at: t, revenueUsd: Math.round(rnd() * 100) / 1000 });
      sdkEvents.push({ customerId: c, appId: "ios", type: pick(["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load"]), at: t + 1000 });
    }
  }
  return {
    now: NOW, txs: txs.filter((t) => t.at <= NOW), customers, lifecycle, subStates, sdkEvents, refundEvents: [], activity: [], fx: () => 1,
    products: [
      { appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "ios", storeIdentifier: "annual", type: "subscription", duration: "P1Y" },
      { appId: "ios", storeIdentifier: "weekly", type: "subscription", duration: "P1W" }, { appId: "ios", storeIdentifier: "coins", type: "consumable", duration: null },
    ],
  };
}

const close = (a: ChartOutput, b: ChartOutput, what: string) => {
  expect(a.kind).toBe("series");
  if (a.kind !== "series" || b.kind !== "series") return;
  expect(b.measures.map((m) => [m.id, m.display_name]), what).toEqual(a.measures.map((m) => [m.id, m.display_name]));
  expect(b.points.length, what).toBe(a.points.length);
  a.points.forEach((p, i) => {
    const q = b.points[i]!;
    expect(q.start, what).toBe(p.start);
    expect(q.incomplete, `${what} incomplete ${new Date(p.start).toISOString()}`).toBe(p.incomplete);
    p.values.forEach((v, k) => {
      const w = q.values[k];
      if (v === null || w === null) expect(w, `${what} ${new Date(p.start).toISOString()} #${k}`).toBe(v);
      else expect(w, `${what} ${new Date(p.start).toISOString()} #${k}`).toBeCloseTo(v, 6);
    });
  });
};

describe("daily rollups", () => {
  const input = seeded();
  const first = firstDataDay(input)!;
  const days = computeRollupDays(input, first, Math.floor(NOW / DAY) * DAY + DAY);
  const requests: [string, ChartRequest][] = [];
  const add = (label: string, resolution: Resolution, from: string, to: string, extra: Partial<ChartRequest> = {}) =>
    requests.push([label, { resolution, rangeStart: T(from), rangeEnd: T(to) + DAY, expand: false, selectors: {}, ...extra }]);
  add("30 days", "day", "2026-08-22", "2026-09-20");
  add("12 months", "month", "2025-10-01", "2026-09-20");
  add("weeks from Sunday", "week", "2026-03-04", "2026-09-20", { weekStart: 0 });
  add("weeks, expanded", "week", "2026-03-04", "2026-09-20", { expand: true });
  add("quarters to a past day", "quarter", "2025-06-15", "2026-02-10");
  add("years", "year", "2024-01-01", "2026-09-20");
  add("months before any data", "month", "2024-06-01", "2025-08-31");

  it("has data", () => {
    for (const name of ["revenue", "mrr", "churn", "ad_rpm", "ad_monetized_customers", "subscription_status"]) {
      const o = runChart(chartDef(name)!, input, requests[1]![1]).output;
      expect(o.kind === "series" && o.points.some((p) => (p.values[0] ?? 0) !== 0), name).toBe(true);
    }
    expect(input.txs.length).toBeGreaterThan(500);
  });

  it("covers the flow, snapshot and rate charts and leaves the cohort charts live", () => {
    expect(ROLLUP_CHARTS).toHaveLength(24);
    for (const c of ["trial_conversion_rate", "cohort_explorer", "customers_active", "refund_request", "initial_conversion"]) expect(isRollupChart(c), c).toBe(false);
  });

  for (const name of ROLLUP_CHARTS) {
    it(`answers ${name} exactly as the live computation`, () => {
      const def = chartDef(name)!;
      const variants = def.selectors.length ? def.selectors[0]!.options.map((o) => ({ [def.selectors[0]!.id]: o.id })) : [{}];
      for (const sel of variants) for (const [label, r] of requests) {
        const req = { ...r, selectors: sel };
        const live = runChart(def, input, req).output;
        const rolled = chartFromRollup(def, req, NOW, days);
        expect(rolled, label).not.toBeNull();
        close(live, rolled!, `${name} ${JSON.stringify(sel)} ${label}`);
      }
    });
  }

  it("refuses periods that start after now and charts it does not keep", () => {
    expect(chartFromRollup(chartDef("churn")!, { resolution: "month", rangeStart: T("2026-08-01"), rangeEnd: T("2026-12-01"), expand: false, selectors: {} }, NOW, days)).toBeNull();
    for (const def of CHARTS.filter((d) => !isRollupChart(d.name))) expect(chartFromRollup(def, requests[0]![1], NOW, days)).toBeNull();
  });

  it("stores nothing for empty days, which read as zero, and only New Customers before the first purchase", () => {
    const sparse = new Map([...days].filter(([, v]) => !isEmptyDay(v)));
    expect(sparse.size).toBeLessThan(days.size);
    for (const name of ROLLUP_CHARTS) for (const [label, r] of requests) close(runChart(chartDef(name)!, input, r).output, chartFromRollup(chartDef(name)!, r, NOW, sparse)!, `${name} ${label} sparse`);
    // A customer first seen in 1970 (a bad import) adds days that hold New Customers only.
    const odd = { ...input, customers: [...input.customers, { id: "old", firstSeen: 0, country: null, platform: null, appVersion: null }] };
    const early = computeRollupDays(odd, 0, T("1970-01-03"));
    expect([...early.values()][0]).toEqual({ customers_new: [1] });
    expect([...early.values()].filter((v) => !isEmptyDay(v))).toHaveLength(1);
    expect(ROLLUP_VERSION).toMatch(/^[0-9a-z]+$/);
  });

  it("are versioned by a hash of the chart code that is up to date", async () => {
    // @ts-expect-error a plain script
    const { chartFingerprint } = await import("../../../scripts/chart-fingerprint.mjs");
    expect(ROLLUP_VERSION, "Run node scripts/chart-fingerprint.mjs").toBe(chartFingerprint());
  });

  // The server builds a large project's rollups customer batch by customer batch (bounded memory) and adds the days up.
  for (const k of [3, 160]) it(`customers in ${k} batches add up to the days of all of them, and answer every chart as live`, () => {
    // An ad event of no known customer goes with the first batch.
    const all = { ...input, sdkEvents: [...input.sdkEvents, { customerId: null, appId: "ios", type: "rc_ads_ad_revenue", at: T("2026-02-03T10:00:00Z"), revenueUsd: 0.25 }] };
    const group = new Map(all.customers.map((c, i) => [c.id, i % k]));
    const of = (id: string | null) => (id === null ? 0 : group.get(id)!);
    const end = Math.floor(NOW / DAY) * DAY + DAY;
    const acc = new Map<number, RollupDay>();
    for (let g = 0; g < k; g++) {
      const part: ChartInput = { ...all, customers: all.customers.filter((c) => of(c.id) === g), txs: all.txs.filter((t) => of(t.customerId) === g),
        subStates: all.subStates.filter((x) => of(x.customerId) === g), lifecycle: all.lifecycle.filter((x) => of(x.customerId) === g), sdkEvents: all.sdkEvents.filter((x) => of(x.customerId) === g) };
      const from = firstDataDay(part);
      if (from !== null) addRollupDays(acc, computeRollupDays(part, from, end));
    }
    const merged = finishRollupDays(acc);
    const whole = new Map([...computeRollupDays(all, firstDataDay(all)!, end)].filter(([, v]) => !isEmptyDay(v)));
    expect([...merged.keys()].sort()).toEqual([...whole.keys()].sort());
    for (const [d, v] of whole) for (const [key, vals] of Object.entries(v)) {
      const m = merged.get(d)![key] ?? vals.map((x) => (x === null ? null : 0));
      vals.forEach((x, i) => (x === null ? expect(m[i], `${key} ${new Date(d).toISOString()}`).toBeNull() : expect(m[i], `${key} ${new Date(d).toISOString()} #${i}`).toBeCloseTo(x, 6)));
    }
    for (const name of ROLLUP_CHARTS) {
      const def = chartDef(name)!;
      const variants = def.selectors.length ? def.selectors[0]!.options.map((o) => ({ [def.selectors[0]!.id]: o.id })) : [{}];
      for (const sel of variants) for (const [label, r] of requests) {
        const req = { ...r, selectors: sel };
        close(runChart(def, all, req).output, chartFromRollup(def, req, NOW, merged)!, `${name} ${JSON.stringify(sel)} ${label} in ${k} batches`);
      }
    }
  });

  it("gives a batch of transactions the Google Play $1M-tier rates the whole environment gives them", () => {
    const txs = [] as Parameters<typeof commissionRates>[0];
    // Two apps, two years: one-time purchases of $300,000 cross $1M on the fourth; ties in time are ordered by id.
    for (const app of ["a", "b"]) for (const y of [2025, 2026]) for (let i = 0; i < 6; i++) {
      const at = Date.UTC(y, 2, 1 + (i === 4 ? 3 : i));
      txs.push({ id: `${app}${y}-${i}`, store: "play_store", appId: app, at, usd: 300_000, kind: i === 1 && app === "b" ? "refund" : "one_time", country: "BR" });
    }
    txs.push({ id: "ios", store: "app_store", appId: "a", at: Date.UTC(2026, 2, 2), usd: 5, kind: "purchase" });
    const whole = commissionRates(txs);
    const crossings = playTierCrossings(txs);
    expect(crossings.size).toBe(4);
    expect([...whole.values()]).toContain(0.3);
    for (let s = 0; s < txs.length; s += 5) {
      const batch = commissionRates(txs.slice(s, s + 5), {}, crossings);
      for (const [id, r] of batch) expect(r, id).toBe(whole.get(id));
    }
  });

  it("a slice of days equals the same days of a full rebuild", () => {
    const slice = computeRollupDays(input, T("2026-01-01"), T("2026-03-01"));
    for (const [d, v] of slice) expect(v).toEqual(days.get(d));
  });
});
