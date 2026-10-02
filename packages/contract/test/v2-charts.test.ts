import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHARTS } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { otherProject, spec, v2 } from "./v2-helpers.js";
import { d, seedChartsHistory } from "./charts-fixture.js";

/**
 * Charts (prd/charts/PRD.md) on the realistic history in charts-fixture.ts. Every number below is worked out by hand
 * from that history; every response is validated against RevenueCat's OpenAPI when the spec is on disk.
 */
let h: Harness;
let call: ReturnType<typeof v2>;

beforeAll(async () => {
  // A stub outbound HTTP client: exchange rates come from the cache (and the bundled set), never the network.
  h = await harness({ fetch: async () => new Response("", { status: 404 }) });
  call = v2(h);
  await seedChartsHistory(h);
});
afterAll(async () => { await h.close(); });

const P = "/v2/projects/{project_id}/charts/{chart_name}";
const get = (chart_name: string, query = "", o: { key?: string } = {}) => call("GET", P, { chart_name }, { query, ...o });
const MONTHS = "resolution=2&start_date=2026-05-01&end_date=2026-09-01";
/** values → { "2026-07": [measure0, measure1, …] } */
const table = (body: any) => {
  const out: Record<string, (number | null)[]> = {};
  for (const v of body.values) { const k = new Date(v.cohort * 1000).toISOString().slice(0, 7); (out[k] ??= [])[v.measure] = v.value; }
  return out;
};
const col = (body: any, i = 0) => body.values.filter((v: any) => v.measure === i).map((v: any) => v.value);

describe("charts: the response", () => {
  it("serves every chart and validates against RevenueCat's schema", async () => {
    for (const c of CHARTS) {
      const r = await get(c.name, c.shape === "cohort_table" ? "" : MONTHS);
      expect(r.status, c.name).toBe(200);
      expect(r.body).toMatchObject({ object: "chart_data", display_name: c.display_name, category: c.group, resolution: c.shape === "cohort_table" ? "month" : "month", yaxis_currency: "USD" });
      const o = await call("GET", `${P}/options`, { chart_name: c.name });
      expect(o.status, c.name).toBe(200);
      expect(o.body.resolutions.map((x: any) => x.display_name)).toEqual(["day", "week", "month", "quarter", "year"]);
    }
  });

  it("shapes a time series: measures, Unix-second cohorts, incomplete current period, summary", async () => {
    const r = await get("revenue", MONTHS);
    expect(r.body.measures.map((m: any) => m.display_name)).toEqual(["Revenue", "Transactions"]);
    expect(r.body.yaxis).toBe("$");
    expect(r.body.values[0]).toEqual({ cohort: Date.parse("2026-05-01T00:00:00Z") / 1000, measure: 0, value: 10, incomplete: false });
    expect(r.body.values.filter((v: any) => v.incomplete).map((v: any) => v.cohort)).toEqual([Date.parse("2026-09-01T00:00:00Z") / 1000, Date.parse("2026-09-01T00:00:00Z") / 1000]);
    expect(r.body.summary.total).toEqual({ Revenue: 95.02, Transactions: 11 });
    expect(r.body).toMatchObject({ start_date: Date.parse("2026-05-01T00:00:00Z"), end_date: Date.parse("2026-09-01T00:00:00Z"), segments: null, user_selectors: { revenue_type: "revenue" } });
    const agg = await get("revenue", `${MONTHS}&aggregate=total`);
    expect(agg.body.values).toEqual([]);
    expect(Object.keys(agg.body.summary)).toEqual(["total"]);
  });

  it("rejects unknown charts, bad dates, resolutions, filters, selectors and segments", async () => {
    expect((await get("no_such_chart")).status).toBe(404);
    expect((await get("revenue", "start_date=2026-13-01")).body).toMatchObject({ type: "parameter_error", param: "start_date" });
    expect((await get("revenue", "start_date=2026-08-01&end_date=2026-07-01")).body.param).toBe("end_date");
    expect((await get("revenue", "resolution=9")).body.param).toBe("resolution");
    expect((await get("revenue", "resolution=0&start_date=2020-01-01&end_date=2026-08-01")).body.param).toBe("start_date");
    expect((await get("revenue", `filters=${encodeURIComponent('[{"name":"paywall","values":["x"]}]')}`)).body.param).toBe("filters");
    expect((await get("revenue", "filters=not-json")).body.param).toBe("filters");
    expect((await get("revenue", `selectors=${encodeURIComponent('{"revenue_type":"cash"}')}`)).body.param).toBe("selectors");
    const seg = await get("revenue", "segment=paywall");
    expect(seg.body.param).toBe("segment");
    expect(seg.body.message).toContain("store");
    expect((await get("cohort_explorer", "segment=country")).body.param).toBe("segment");
    expect((await get("revenue", "currency=XYZ")).body.param).toBe("currency");
    expect((await get("revenue", "aggregate=median")).body.param).toBe("aggregate");
  });

  it("needs the charts scope and stays inside the project", async () => {
    const other = await otherProject(h);
    expect((await call("GET", P, { chart_name: "revenue", project_id: "proj1" }, { key: other.key })).status).toBe(404);
    // The other project has one $9.99 purchase today.
    const b = await call("GET", P, { chart_name: "revenue", project_id: "projB" }, { key: other.key, query: MONTHS });
    expect(col(b.body)).toEqual([0, 0, 0, 0, 9.99]);
  });
});

describe("charts: numbers by hand", () => {
  it("revenue, transactions, proceeds and the sandbox switch", async () => {
    const r = table((await get("revenue", MONTHS)).body);
    // May u_a; Jun u_a + u_e + u_d 120 − 120 refunded; Jul u_a u_b u_e; Aug u_a u_b u_p + u_g $5 + $0.02 of ads.
    expect(r).toEqual({ "2026-05": [10, 1], "2026-06": [20, 3], "2026-07": [30, 3], "2026-08": [35.02, 4], "2026-09": [0, 0] });
    const proceeds = table((await get("revenue", `${MONTHS}&selectors=${encodeURIComponent('{"revenue_type":"proceeds"}')}`)).body);
    expect(proceeds["2026-08"]![0]).toBe(24.52);
    const sandbox = table((await get("revenue", `${MONTHS}&environment=sandbox`)).body);
    expect(sandbox["2026-08"]).toEqual([9.99, 1]);
  });

  it("active subscriptions, MRR, ARR and their movements", async () => {
    expect(col((await get("actives", MONTHS)).body)).toEqual([1, 2, 3, 3, 3]);
    expect(col((await get("mrr", MONTHS)).body)).toEqual([10, 20, 30, 30, 30]);
    expect(col((await get("arr", MONTHS)).body)).toEqual([120, 240, 360, 360, 360]);
    const mv = table((await get("actives_movement", MONTHS)).body);
    expect(mv).toEqual({ "2026-05": [1, 0, 0, 1], "2026-06": [2, 0, -1, 1], "2026-07": [1, 0, 0, 1], "2026-08": [1, 0, -1, 0], "2026-09": [0, 0, 0, 0] });
    const mm = table((await get("mrr_movement", MONTHS)).body);
    expect(mm["2026-06"]).toEqual([20, 0, 0, -10, 0, 10]);
    expect(mm["2026-08"]).toEqual([10, 0, 0, -10, 0, 0]);
    const paid = table((await get("actives_new", MONTHS)).body);
    expect(paid["2026-07"]).toEqual([1, 1, 0, 0, 0]);
    expect(paid["2026-06"]).toEqual([2, 0, 2, 0, 0]);
    const status = table((await get("subscription_status", MONTHS)).body);
    // Now: u_a and u_b renew, u_p is cancelled. At the end of June: u_a (renewed since) and u_e (renewed in July).
    expect(status["2026-09"]).toEqual([2, 1, 0]);
    expect(status["2026-06"]).toEqual([2, 0, 0]);
    expect(status["2026-07"]).toEqual([2, 1, 0]);
    const mrrStatus = table((await get("subscription_status", `${MONTHS}&selectors=${encodeURIComponent('{"status_measure":"mrr"}')}`)).body);
    expect(mrrStatus["2026-09"]).toEqual([20, 10, 0]);
  });

  it("churn, refunds, refund rate and refund requests", async () => {
    const churn = table((await get("churn", MONTHS)).body);
    expect(churn["2026-06"]).toEqual([100, 1, 1]);
    expect(churn["2026-07"]).toEqual([0, 2, 0]);
    expect(churn["2026-08"]).toEqual([33.33, 3, 1]);
    expect(table((await get("refunds", MONTHS)).body)["2026-06"]).toEqual([120, 1]);
    expect(table((await get("refund_rate", MONTHS)).body)["2026-06"]).toEqual([33.33, 3, 1]);
    const req = table((await get("refund_request", MONTHS)).body);
    expect(req["2026-06"]).toEqual([1, 0, 0, 0, 1, 120]);
    expect(req["2026-08"]).toEqual([0, 0, 0, 1, 1, 10]);
    expect(req["2026-07"]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("trials: active, new, movement, conversion rate, cancellations and the funnel", async () => {
    const daily = "resolution=day&start_date=2026-08-01&end_date=2026-08-09";
    expect(col((await get("trials", daily)).body)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(col((await get("trials_new", MONTHS)).body)).toEqual([0, 0, 1, 1, 0]);
    expect(table((await get("trials_movement", MONTHS)).body)["2026-07"]).toEqual([1, -1, 0, 0]);
    expect(table((await get("trials_movement", MONTHS)).body)["2026-08"]).toEqual([1, 0, -1, 0]);
    const rate = table((await get("trial_conversion_rate", MONTHS)).body);
    expect(rate["2026-07"]).toEqual([100, 1, 1, 0]);
    expect(rate["2026-08"]).toEqual([0, 1, 0, 0]);
    const cancel = table((await get("trial_cancellation", MONTHS)).body);
    expect(cancel["2026-08"]).toEqual([100, 1, 1, 0, 0]);
    // A 1-day timeframe misses the opt-out two days into the trial: it counts as elapsed.
    expect(table((await get("trial_cancellation", `${MONTHS}&selectors=${encodeURIComponent('{"cancellation_timeframe":"1_days"}')}`)).body)["2026-08"]).toEqual([0, 1, 0, 0, 1]);
    const funnel = table((await get("trial_conversion", MONTHS)).body);
    // August cohort: u_c, u_g, u_p, u_x, u_s; one trial, abandoned.
    expect(funnel["2026-08"]).toEqual([5, 1, 0, 0, 0, 0, 1, 20, 0]);
    expect(funnel["2026-07"]).toEqual([1, 1, 1, 0, 0, 0, 0, 100, 100]);
  });

  it("customers and conversion", async () => {
    expect(col((await get("customers_new", MONTHS)).body)).toEqual([1, 2, 1, 5, 0]);
    expect(col((await get("customers_active", MONTHS)).body)).toEqual([1, 2, 1, 6, 0]);
    const init = table((await get("initial_conversion", MONTHS)).body);
    expect(init["2026-08"]).toEqual([60, 3, 5]);
    expect(init["2026-06"]).toEqual([100, 2, 2]);
    const paying = table((await get("conversion_to_paying", MONTHS)).body);
    // u_d's first payment was refunded inside the 7 days.
    expect(paying["2026-06"]).toEqual([50, 1, 2]);
    expect(paying["2026-08"]).toEqual([40, 2, 5]);
    const ltv = table((await get("ltv_per_customer", `${MONTHS}&selectors=${encodeURIComponent('{"customer_lifetime":"30_days"}')}`)).body);
    // June: u_d 120 − 120, u_e's purchase and its renewal on day 30. May: u_a's purchase only (the renewal on day 31 is outside).
    expect(ltv["2026-06"]).toEqual([10, 20, 2]);
    expect(ltv["2026-05"]).toEqual([10, 10, 1]);
    const ltvPaying = table((await get("ltv_per_paying_customer", `${MONTHS}&selectors=${encodeURIComponent('{"customer_lifetime":"30_days"}')}`)).body);
    expect(ltvPaying["2026-06"]).toEqual([20, 20, 1]);
  });

  it("paywalls, ads, survey answers and Google cancel reasons", async () => {
    const conv = table((await get("paywall_conversion", MONTHS)).body);
    expect(conv["2026-07"]).toEqual([100, 100, 100, 100, 1, 1, 1, 1, 1]);
    expect(conv["2026-08"]).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(table((await get("paywall_abandonment", MONTHS)).body)["2026-08"]).toEqual([100, 0, 100, 1, 0, 1]);
    expect(table((await get("paywall_encounter", MONTHS)).body)["2026-07"]).toEqual([100, 100, 100, 100, 100, 1]);
    const ltv = table((await get("paywall_ltv", `${MONTHS}&selectors=${encodeURIComponent('{"customer_lifetime":"30_days"}')}`)).body);
    expect(ltv["2026-07"]).toEqual([10, 10, 10, 1]);
    const ad = async (name: string) => table((await get(name, MONTHS)).body)["2026-08"];
    expect(await ad("ad_revenue")).toEqual([0.02]);
    expect(await ad("ad_impressions")).toEqual([4]);
    expect(await ad("ad_clicks")).toEqual([1]);
    expect(await ad("ad_ctr")).toEqual([25, 1, 4]);
    expect(await ad("ad_rpm")).toEqual([5, 0.02, 4]);
    expect(await ad("ad_fill_rate")).toEqual([80, 5, 4]);
    expect(await ad("ad_arpdau")).toEqual([0.02]);
    expect(await ad("ad_monetized_customers")).toEqual([0.03]);
    const survey = await get("customer_center_survey_responses", MONTHS);
    expect(survey.body.measures.map((m: any) => m.display_name)).toEqual(["Responses", "too_expensive", "other"]);
    expect(table(survey.body)["2026-08"]).toEqual([2, 1, 1]);
    const reasons = await get("play_store_cancel_reasons", MONTHS);
    expect(reasons.body.measures.map((m: any) => m.id)).toContain("cancel_survey_reason_cost_related");
    expect(table(reasons.body)["2026-08"]).toEqual([0, 0, 1, 0, 0, 0, 1]);
    expect(col((await get("non-subscription_purchases", MONTHS)).body)).toEqual([0, 0, 0, 1, 0]);
    expect(col((await get("app_store_save_outcomes", MONTHS)).body)).toEqual([0, 0, 0, 0, 0]);
  });

  it("cohort tables: subscription retention, cohort explorer and prediction explorer", async () => {
    const ret = await get("subscription_retention", "start_date=2026-05-01&end_date=2026-09-01");
    expect(ret.body.periods[0]).toMatchObject({ display_name: "Subscriptions", unit: "#" });
    expect(ret.body.periods[1]).toMatchObject({ display_name: "Period 0", unit: "%", scale: "relative" });
    const row = (body: any, month: string) => body.values.filter((v: any) => new Date(v.cohort * 1000).toISOString().startsWith(month)).map((v: any) => v.value);
    // May: u_a (4 paid periods). June: u_d (annual, refunded; no second period due yet) and u_e (2 periods), so periods 1
    // and 2 only count u_e.
    expect(row(ret.body, "2026-05").slice(0, 5)).toEqual([1, 100, 100, 100, 100]);
    expect(row(ret.body, "2026-06").slice(0, 4)).toEqual([2, 100, 100, 0]);
    const ce = await get("cohort_explorer", `start_date=2026-05-01&end_date=2026-09-01&selectors=${encodeURIComponent('{"cohorting_date":"new_paying_customers","cohort_measure":"realized_ltv"}')}`);
    expect(ce.body.periods[0].display_name).toBe("New Paying Customers");
    // June paying cohort: u_d (120, refunded on day 5 → 0) and u_e (10 + 10): month 0 = 10, month 1 = 20.
    expect(row(ce.body, "2026-06").slice(0, 3)).toEqual([2, 10, 20]);
    const pe = await get("prediction_explorer", "start_date=2026-05-01&end_date=2026-09-01");
    const aug = pe.body.values.filter((v: any) => new Date(v.cohort * 1000).toISOString().startsWith("2026-08"));
    expect(aug.some((v: any) => v.predicted)).toBe(true);
    expect(pe.body.periods).toHaveLength(26);
  });

  it("filters, segments, currencies and expand_periods", async () => {
    const f = encodeURIComponent('[{"name":"store","values":["play_store"]}]');
    expect(col((await get("actives", `${MONTHS}&filters=${f}`)).body)).toEqual([0, 0, 0, 1, 1]);
    // Purchase filters leave new customers alone.
    expect(table((await get("initial_conversion", `${MONTHS}&filters=${f}`)).body)["2026-08"]).toEqual([20, 1, 5]);
    const seg = await get("actives", `${MONTHS}&segment=country&limit_num_segments=1`);
    expect(seg.body.segments.map((s: any) => [s.display_name, s.is_other, s.is_total])).toEqual([["United States", false, false], ["Other", true, false], ["Total", false, true]]);
    const by = (i: number) => seg.body.values.filter((v: any) => v.segment === i).map((v: any) => v.value);
    expect(by(0)).toEqual([1, 2, 2, 2, 2]);
    expect(by(1)).toEqual([0, 0, 1, 1, 1]);
    expect(by(2)).toEqual([1, 2, 3, 3, 3]);
    // A display currency converts each purchase at its own date's rate: here 0.8 EUR per USD from May on.
    await h.db.insert(schema.fxRates).values({ source: "ecb", date: "2026-05-01", rates: { EUR: 1, USD: 1.25 } });
    const eur = await get("revenue", `${MONTHS}&currency=EUR`);
    expect(eur.body.yaxis_currency).toBe("EUR");
    expect(table(eur.body)["2026-05"]).toEqual([8, 1]);
    // A mid-month start counts flows from that day and marks the first month incomplete, unless expand_periods=true.
    const mid = await get("revenue", "resolution=2&start_date=2026-06-10&end_date=2026-07-31");
    // From Jun 10: u_a's renewal, and u_d's purchase refunded five days later (still a transaction).
    expect(table(mid.body)["2026-06"]).toEqual([10, 2]);
    expect(mid.body.values[0].incomplete).toBe(true);
    expect(table((await get("revenue", "resolution=2&start_date=2026-06-10&end_date=2026-07-31&expand_periods=true")).body)["2026-06"]).toEqual([20, 3]);
  });

  it("week_start (RevenueDot extension) moves weekly buckets to the viewer's first day", async () => {
    const q = "resolution=week&start_date=2026-08-03&end_date=2026-08-16";
    const starts = (body: any) => [...new Set(body.values.map((v: any) => new Date(v.cohort * 1000).toISOString().slice(0, 10)))];
    // Monday by default (Aug 3, 2026 is a Monday); Sunday and Saturday weeks start before the range.
    expect(starts((await get("revenue", q)).body)).toEqual(["2026-08-03", "2026-08-10"]);
    expect(starts((await get("revenue", `${q}&week_start=0`)).body)).toEqual(["2026-08-02", "2026-08-09", "2026-08-16"]);
    expect(starts((await get("revenue", `${q}&week_start=saturday`)).body)).toEqual(["2026-08-01", "2026-08-08", "2026-08-15"]);
    const bad = await get("revenue", `${q}&week_start=funday`);
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("week_start");
  });

  it("options list the values in the data", async () => {
    const o = await call("GET", `${P}/options`, { chart_name: "revenue" });
    const store = o.body.filters.find((x: any) => x.id === "store");
    expect(store.options.map((x: any) => x.display_name).sort()).toEqual(["App Store", "Google Play"]);
    expect(o.body.segments.map((s: any) => s.id)).toContain("country");
    expect(o.body.user_selectors.revenue_type).toMatchObject({ default: "revenue" });
    const ce = await call("GET", `${P}/options`, { chart_name: "cohort_explorer" });
    expect(ce.body.segments).toEqual([]);
  });
});

describe("SDK events and activity behind the charts", () => {
  it("keeps each /v1/events event once, with its customer, and records one activity row per customer per day", async () => {
    const rows = await h.db.select().from(schema.sdkEvents);
    expect(rows).toHaveLength(19);
    expect(rows.find((r) => r.type === "paywall_impression" && r.appUserId === "u_b")).toMatchObject({ appId: "app_ios", isSandbox: false, occurredAt: d("2026-07-01T08:00:00Z") });
    expect(rows.every((r) => r.customerId)).toBe(true);
    // A bad batch is still a 200, so the SDK does not resend it forever.
    expect((await h.fetch("/v1/events", { method: "POST", body: "not json", headers: { "content-type": "application/json" } })).status).toBe(200);
    expect((await h.fetch("/v1/events", { method: "POST", json: { events: [{ id: "x" }, 5, null] } })).status).toBe(200);
    const days = await h.db.select().from(schema.customerActivity);
    expect(days.filter((x) => x.day === "2026-08-15")).toHaveLength(1);
  });

  it("caps what a public key can store, and marks iOS sandbox builds' events as sandbox", async () => {
    const at = h.now().getTime() - 60_000;
    const post = (body: unknown, headers: Record<string, string> = {}) => h.fetch("/v1/events", { method: "POST", json: body, headers });
    // X-Is-Sandbox (iOS sandbox and TestFlight builds) keeps the events out of production charts.
    const sb = await post({ events: [{ id: "probe_sandbox", type: "probe", app_user_id: "u_a", timestamp: at }] }, { "x-is-sandbox": "true" });
    expect(sb.status).toBe(200);
    expect(await sb.json()).toEqual({});
    // A NUL character (rejected by Postgres) and a 100 kB string do not lose the batch; the payload is capped.
    await post({ events: [{ id: "probe_nul", type: "pro\u0000be", app_user_id: "u_a\u0000", timestamp: at, note: "a\u0000b" }, { id: "probe_big", type: "probe", timestamp: at, blob: "x".repeat(100_000) }] });
    // A body over the limit is answered 200 and dropped unread.
    const huge = await post({ events: [{ id: "probe_huge", type: "probe", timestamp: at, blob: "x".repeat(600_000) }] });
    expect(huge.status).toBe(200);
    const rows = await h.db.select().from(schema.sdkEvents);
    const byId = (id: string) => rows.find((r) => r.id === id);
    expect(byId("probe_sandbox")).toMatchObject({ isSandbox: true, customerId: expect.any(String) });
    expect(byId("probe_nul")).toMatchObject({ type: "probe", appUserId: "u_a", isSandbox: false, payload: expect.objectContaining({ note: "ab" }) });
    expect(byId("probe_nul")!.customerId).toBe(byId("probe_sandbox")!.customerId);
    expect(JSON.stringify(byId("probe_big")!.payload).length).toBeLessThanOrEqual(8_000);
    expect(byId("probe_huge")).toBeUndefined();
  });

  it("segments a chart whose measures follow the data: every value points at the total's measure with the same id", async () => {
    // An Android answer with an option the iOS app never saw: the iOS segment has one measure fewer than the total.
    await h.fetch("/v1/events", { method: "POST", key: h.ids.androidKey, json: { events: [{ id: "probe_android_survey", type: "customer_center_survey_option_chosen", app_user_id: "u_p", timestamp: d("2026-08-20T09:00:00Z").getTime(), survey_option_id: "missing_features" }] } });
    const r = await get("customer_center_survey_responses", `${MONTHS}&segment=app`);
    expect(r.status).toBe(200);
    expect(r.body.measures.map((m: any) => m.display_name)).toEqual(["Responses", "too_expensive", "missing_features", "other"]);
    expect(r.body.segments.map((s: any) => s.display_name)).toEqual(["Scanner iOS", "Scanner Android", "Total"]);
    const total = r.body.segments.findIndex((s: any) => s.is_total);
    const sum = new Map<string, number>();
    for (const v of r.body.values) {
      expect(r.body.measures[v.measure]).toBeDefined();
      if (v.segment !== total) sum.set(`${v.cohort}|${v.measure}`, (sum.get(`${v.cohort}|${v.measure}`) ?? 0) + (v.value ?? 0));
    }
    for (const v of r.body.values.filter((x: any) => x.segment === total)) expect(sum.get(`${v.cohort}|${v.measure}`) ?? 0).toBe(v.value);
  });
});

describe("schema coverage", () => {
  it("validated both chart operations against RevenueCat's spec", () => {
    if (!spec) return;
    const want = [`GET ${P} 200`, `GET ${P}/options 200`, `GET ${P} 400`, `GET ${P} 404`];
    expect(want.filter((w) => !spec!.checked.has(w))).toEqual([]);
  });
});
