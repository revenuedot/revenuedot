import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { ADSERVICES_URL } from "@revenuedot/server/services/attribution.js";
import { resyncAppleAdsNames } from "@revenuedot/server/repo/attribution.js";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";
import { seedChartsHistory } from "./charts-fixture.js";

/**
 * Attribution in charts and the revenue-by-campaign report (prd/attribution-benchmarks-insights §1), on the chart
 * history of charts-fixture.ts, with attribution set the three ways it arrives:
 *   u_a  the app's SDK sets $mediaSource "Meta" and $campaign "Spring" (POST /v1/subscribers/{id}/attributes)
 *   u_b  the iOS SDK posts an AdServices token; Apple answers campaign 111, ad group 222, keyword 333 ("Brand US" once names load)
 *   u_e  a backend sets $mediaSource "Google Ads" and $campaign "Brand" through the REST API
 * Everyone else has no attribution. Numbers worked out by hand from the fixture.
 */
let h: Harness;
let call: ReturnType<typeof v2>;
const pending: Promise<unknown>[] = [];
const apple = { attribution: true, orgId: 9, campaignId: 111, adGroupId: 222, keywordId: 333, adId: 444, countryOrRegion: "GB", claimType: "Click", conversionType: "Download" };

beforeAll(async () => {
  h = await harness({
    // AdServices answers; exchange rates come from the bundled set (anything else is "not found").
    fetch: async (input) => (String(input instanceof Request ? input.url : input) === ADSERVICES_URL ? Response.json(apple) : new Response("", { status: 404 })),
    defer: (t) => { pending.push(t()); },
  });
  call = v2(h);
  await seedChartsHistory(h);
  const at = h.now().getTime();
  const sdk = await h.fetch("/v1/subscribers/u_a/attributes", { method: "POST", json: { attributes: { $mediaSource: { value: "Meta", updated_at_ms: at }, $campaign: { value: "Spring", updated_at_ms: at } } } });
  expect(sdk.status).toBe(200);
  const ads = await h.fetch("/v1/subscribers/u_b/adservices_attribution", { method: "POST", json: { aad_attribution_token: "token-from-the-device" } });
  expect(ads.status).toBe(200);
  while (pending.length) await pending.shift();
  const rest = await call("POST", "/v2/projects/{project_id}/customers/{customer_id}/attributes", { customer_id: "u_e" }, { json: { attributes: [{ name: "$mediaSource", value: "Google Ads" }, { name: "$campaign", value: "Brand" }] } });
  expect(rest.status).toBe(200);
});
afterAll(async () => { await h.close(); });

const C = "/v2/projects/{project_id}/charts/{chart_name}";
const chart = (chart_name: string, query: string) => call("GET", C, { chart_name }, { query });
const MONTHS = "resolution=2&start_date=2026-05-01&end_date=2026-08-31";
/** segment display name → [May, Jun, Jul, Aug] of the first measure. */
const bySegment = (body: any) => {
  const out: Record<string, (number | null)[]> = {};
  const months = [...new Set(body.values.map((v: any) => v.cohort))].sort();
  for (const v of body.values) if (v.measure === 0) (out[body.segments[v.segment].display_name] ??= [])[months.indexOf(v.cohort)] = v.value;
  return out;
};
const report = (query: string) => call("GET", "/v2/projects/{project_id}/attribution/report", {}, { query, ext: true });

describe("attribution arrives from the SDK, AdServices and the REST API", () => {
  it("stores one first-class row per attributed customer", async () => {
    const rows = await h.db.select().from(schema.customerAttribution).where(eq(schema.customerAttribution.projectId, "proj1"));
    expect(rows).toHaveLength(3);
    const a = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/attribution", { customer_id: "u_b" }, { ext: true });
    expect(a.body.attribution).toMatchObject({ media_source: "Apple Search Ads", campaign: "111", campaign_id: "111", ad_group: "222", keyword: "333", ad: "444", claim_type: "Click", attribution_country: "GB" });
  });

  it("names Apple Search Ads campaigns once the connection has loaded the names", async () => {
    await h.db.insert(schema.integrations).values({ id: newId("int_", 10), projectId: "proj1", kind: "apple_search_ads", name: "Apple Search Ads", settings: { names: { campaigns: { 111: "Brand US" }, ad_groups: { 222: "Exact" } } } });
    await resyncAppleAdsNames(h.db, "proj1");
    const a = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/attribution", { customer_id: "u_b" }, { ext: true });
    expect(a.body.attribution).toMatchObject({ campaign: "Brand US", campaign_id: "111", ad_group: "Exact" });
  });
});

describe("attribution dimensions in charts", () => {
  it("segments revenue by media source", async () => {
    const r = await chart("revenue", `${MONTHS}&segment=media_source`);
    expect(r.status).toBe(200);
    expect(bySegment(r.body)).toEqual({
      // u_a renewals, plus $0.02 of ad revenue on Aug 15.
      Meta: [10, 10, 10, 10.02],
      // u_e: Jun 5 and Jul 5.
      "Google Ads": [0, 10, 10, 0],
      // u_b: converted Jul 8, renewed Aug 8.
      "Apple Search Ads": [0, 0, 10, 10],
      // u_d bought and was refunded in June; u_g $5 and u_p $10 in August.
      "No attribution": [0, 0, 0, 15],
      Total: [10, 20, 30, 35.02],
    });
  });

  it("filters by campaign name, with customer charts too", async () => {
    const brand = await chart("revenue", `${MONTHS}&filters=${encodeURIComponent(JSON.stringify([{ name: "campaign", values: ["Brand US", "Brand"] }]))}`);
    expect(brand.body.values.filter((v: any) => v.measure === 0).map((v: any) => v.value)).toEqual([0, 10, 20, 10]);
    const newCustomers = await chart("customers_new", `${MONTHS}&filters=${encodeURIComponent(JSON.stringify([{ name: "media_source", values: ["Apple Search Ads"] }]))}`);
    expect(newCustomers.body.values.map((v: any) => v.value)).toEqual([0, 0, 1, 0]);
    const none = await chart("customers_new", `${MONTHS}&filters=${encodeURIComponent(JSON.stringify([{ name: "media_source", values: [""] }]))}`);
    // u_d (Jun), u_c, u_p, u_x, u_g, u_s (Aug).
    expect(none.body.values.map((v: any) => v.value)).toEqual([0, 1, 0, 5]);
    const conv = await chart("trial_conversion_rate", `${MONTHS}&segment=campaign`);
    expect(conv.status).toBe(200);
    expect(conv.body.segments.map((s: any) => s.display_name)).toContain("Brand US");
  });

  it("lists attribution dimensions and their values with labels", async () => {
    const o = await call("GET", `${C}/options`, { chart_name: "revenue" });
    const seg = o.body.segments.filter((s: any) => s.group_display_name === "Attribution").map((s: any) => s.id);
    expect(seg).toEqual(["media_source", "campaign", "ad_group", "keyword", "ad", "creative"]);
    const ms = o.body.filters.find((f: any) => f.id === "media_source");
    expect(ms.options).toEqual(expect.arrayContaining([{ id: "", display_name: "No attribution" }, { id: "Meta", display_name: "Meta" }, { id: "Apple Search Ads", display_name: "Apple Search Ads" }]));
    const kw = o.body.filters.find((f: any) => f.id === "keyword");
    expect(kw.options.map((x: any) => x.id)).toEqual(["", "333"]);
  });
});

describe("revenue by campaign", () => {
  it("groups the period's new customers by media source with windowed revenue", async () => {
    const r = await report("group_by=media_source&start_date=2026-05-01&end_date=2026-08-31");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "attribution_report", group_by: "media_source", start_date: "2026-05-01", end_date: "2026-08-31", currency: "USD" });
    const rows = Object.fromEntries(r.body.rows.map((x: any) => [x.label, x]));
    expect(r.body.rows.map((x: any) => x.label)).toEqual(["Meta", "Apple Search Ads", "Google Ads", "No attribution"]);
    // u_a: $10 on day 0; the Jun 10 renewal is day 31.
    expect(rows.Meta).toMatchObject({ customers: 1, paying_customers: 1, revenue_day_0: 10, revenue_day_7: 10, revenue_day_30: 10, revenue_to_date: 40 });
    // u_b: trial on day 0, converted on day 7.
    expect(rows["Apple Search Ads"]).toMatchObject({ customers: 1, trial_starts: 1, paying_customers: 1, revenue_day_0: 0, revenue_day_7: 10, revenue_day_30: 10, revenue_to_date: 20 });
    // u_e: Jun 5 and Jul 5 (day 30).
    expect(rows["Google Ads"]).toMatchObject({ revenue_day_0: 10, revenue_day_30: 20, revenue_to_date: 20 });
    // u_c, u_d (refunded), u_g, u_p, u_x and the sandbox-only u_s.
    expect(rows["No attribution"]).toMatchObject({ customers: 6, paying_customers: 2, revenue_to_date: 15, conversion_to_paying: 33.3 });
    expect(r.body.total).toMatchObject({ label: "Total", customers: 9, paying_customers: 5, revenue_to_date: 95 });
    expect(r.body.media_sources).toEqual(["Apple Search Ads", "Google Ads", "Meta"]);
  });

  it("narrows to one media source, and checks its parameters", async () => {
    const asa = await report("group_by=campaign&media_source=Apple%20Search%20Ads&start_date=2026-05-01&end_date=2026-08-31");
    expect(asa.body.rows.map((x: any) => x.label)).toEqual(["Brand US"]);
    const none = await report("group_by=campaign&media_source=No%20attribution&start_date=2026-05-01&end_date=2026-08-31");
    expect(none.body.rows.map((x: any) => x.label)).toEqual(["No attribution"]);
    expect((await report("group_by=platform")).status).toBe(400);
    expect((await report("start_date=2026-09-01&end_date=2026-08-01")).status).toBe(400);
    expect((await report("start_date=yesterday")).status).toBe(400);
  });
});
