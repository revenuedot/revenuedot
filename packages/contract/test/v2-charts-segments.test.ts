import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";
import { seedChartsHistory } from "./charts-fixture.js";

/**
 * Renewal cycle, offer type and custom attribute dimensions through the charts API (prd/charts/PRD.md "Renewal cycle
 * and offer type"), on the chart history of charts-fixture.ts. Custom attributes: u_a and u_b set `source` to "web" and
 * "ios" through the SDK; nobody else has one. Numbers worked out by hand from the fixture.
 */
let h: Harness;
let call: ReturnType<typeof v2>;
beforeAll(async () => {
  h = await harness();
  call = v2(h);
  await seedChartsHistory(h);
  const at = h.now().getTime();
  for (const [user, source] of [["u_a", "web"], ["u_b", "ios"]] as const) {
    const r = await h.fetch(`/v1/subscribers/${user}/attributes`, { method: "POST", json: { attributes: { source: { value: source, updated_at_ms: at }, $email: { value: `${user}@example.com`, updated_at_ms: at } } } });
    expect(r.status).toBe(200);
  }
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
const q = (o: unknown) => encodeURIComponent(JSON.stringify(o));

describe("renewal cycle", () => {
  it("segments revenue by the cycle of each paid period", async () => {
    const r = await chart("revenue", `${MONTHS}&segment=subscription_renewal_cycle_group`);
    expect(r.status).toBe(200);
    const s = bySegment(r.body);
    // Cycle 1: u_a May 10; u_e Jun 5 and u_d's refunded annual (+120 −120); u_b Jul 8; u_p Aug 2.
    expect(s["Cycle 1"]).toEqual([10, 10, 10, 10]);
    // Cycle 2: u_a Jun 10, u_e Jul 5, u_b Aug 8.
    expect(s["Cycle 2"]).toEqual([0, 10, 10, 10]);
    expect(s["Cycle 3"]).toEqual([0, 0, 10, 0]);
    expect(s["Cycle 4"]).toEqual([0, 0, 0, 10]);
    // u_g's one-time purchase and u_a's ad revenue belong to no cycle.
    expect(s["Non-subscription"]).toEqual([0, 0, 0, 5.02]);
    const total = s.Total!;
    for (let k = 0; k < 4; k++) expect(Object.entries(s).filter(([n]) => n !== "Total").reduce((a, [, v]) => a + (v[k] ?? 0), 0)).toBeCloseTo(total[k]!, 6);
  });

  it("filters MRR to subscriptions in their first paid period", async () => {
    const r = await chart("mrr", `${MONTHS}&filters=${q([{ name: "subscription_renewal_cycle_group", values: ["cycle_1"] }])}`);
    expect(r.status).toBe(200);
    // End of August: u_p's first month ($10; cancelled but not expired). u_a, u_b are in later cycles.
    expect(r.body.values.filter((v: any) => v.measure === 0).map((v: any) => v.value)).toEqual([10, 10, 10, 10]);
  });

  it("is offered to ARR and MRR but offer type is not, and neither to the movement charts", async () => {
    expect((await chart("arr", `${MONTHS}&segment=subscription_renewal_cycle_group`)).status).toBe(200);
    const r = await chart("arr", `${MONTHS}&segment=offer_type`);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("offer_type");
    expect((await chart("mrr", `${MONTHS}&segment=offer_type`)).status).toBe(400);
    expect((await chart("mrr_movement", `${MONTHS}&segment=subscription_renewal_cycle_group`)).status).toBe(400);
  });
});

describe("offer type", () => {
  it("counts the trials as free trials", async () => {
    const r = await chart("trials_new", `${MONTHS}&segment=offer_type`);
    expect(r.status).toBe(200);
    expect(bySegment(r.body)["Free trial"]).toEqual([0, 0, 1, 1]);
  });
});

describe("custom attributes", () => {
  it("lists the project's attributes in the filter and segment menus", async () => {
    const r = await call("GET", `${C}/options`, { chart_name: "revenue" });
    expect(r.status).toBe(200);
    const seg = r.body.segments.find((s: any) => s.id === "custom_attribute:source");
    expect(seg).toMatchObject({ display_name: "source", group_display_name: "Custom attributes" });
    expect(r.body.segments.some((s: any) => s.id === "custom_attribute:$email")).toBe(false);
    expect(r.body.filters.find((f: any) => f.id === "custom_attribute:source").options.map((o: any) => o.id).sort()).toEqual(["ios", "web"]);
    expect(r.body.segments.find((s: any) => s.id === "subscription_renewal_cycle_group")).toMatchObject({ display_name: "Renewal Cycle" });
    expect(r.body.filters.find((f: any) => f.id === "subscription_renewal_cycle_group").options.map((o: any) => o.display_name)).toContain("Cycle 1");
  });

  it("filters and segments a chart by a custom attribute", async () => {
    const web = await chart("revenue", `${MONTHS}&filters=${q([{ name: "custom_attribute:source", values: ["web"] }])}`);
    expect(web.status).toBe(200);
    expect(web.body.values.filter((v: any) => v.measure === 0).map((v: any) => v.value)).toEqual([10, 10, 10, 10.02]);
    const seg = await chart("revenue", `${MONTHS}&segment=custom_attribute:source`);
    expect(seg.status).toBe(200);
    const s = bySegment(seg.body);
    expect(s.ios).toEqual([0, 0, 10, 10]);
    expect(s["Not set"]).toEqual([0, 10, 10, 15]);
    expect((await chart("revenue", `${MONTHS}&segment=custom_attribute:`)).status).toBe(400);
    // Reserved attributes such as $email never become a dimension.
    expect((await chart("revenue", `${MONTHS}&segment=${encodeURIComponent("custom_attribute:$email")}`)).status).toBe(400);
    expect((await chart("revenue", `${MONTHS}&filters=${q([{ name: "custom_attribute:$email", values: ["u_a@example.com"] }])}`)).status).toBe(400);
  });
});
