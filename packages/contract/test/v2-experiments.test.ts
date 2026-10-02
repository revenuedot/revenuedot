import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { parseCsv } from "@revenuedot/server/services/exports/files.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, v2 } from "./v2-helpers.js";

/** Experiments v2 (prd/experiments/PRD.md): variants, enrollment modes, priority, audiences, results, CSV, helpers. */

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const EXP = "/v2/projects/{project_id}/experiments";
const ONE = `${EXP}/{experiment_id}`;
const MIN = 60_000;
const later = (min: number) => h.setNow(new Date(h.now().getTime() + min * MIN));
const ext = (json?: unknown, query?: string) => ({ ext: true, json, query });
const sdk = async (user: string, headers: Record<string, string> = {}) => (await (await h.fetch(`/v1/subscribers/${encodeURIComponent(user)}/offerings`, { key: h.ids.testKey, headers })).json()) as any;
/** A customer the way an app makes one: customer info first (with its device headers), then offerings. */
async function newCustomer(id: string, headers: Record<string, string> = {}) {
  await h.fetch(`/v1/subscribers/${encodeURIComponent(id)}`, { key: h.ids.testKey, headers });
}
async function offering(key: string) {
  return (await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: key, display_name: key } })).body.id as string;
}
const create = (json: unknown) => call("POST", EXP, {}, ext(json));
const act = (id: string, a: "start" | "pause" | "stop") => call("POST", `${ONE}/actions/${a}`, { experiment_id: id }, ext());
const enrollments = async (id: string) => h.db.select().from(schema.experimentEnrollments).where(eq(schema.experimentEnrollments.experimentId, id));

describe("creating experiments", () => {
  it("takes every field, fills type defaults, numbers priorities and validates variants", async () => {
    const [o2, o3, o4, ob] = [await offering("o2"), await offering("o3"), await offering("o4"), await offering("onboard")];
    const made = await create({
      name: "Price test", type: "price_point", notes: "## Hypothesis\nHigher price, same conversion.", enrollment: "new", enrollment_percent: 50,
      variants: [{ offering_id: "ofr_default", placements: { onboarding: ob } }, { name: "Higher", offering_id: o2, placements: { onboarding: o2 } }, { offering_id: o3 }, { offering_id: o4 }],
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      object: "experiment", status: "draft", type: "price_point", primary_metric: "realized_ltv_per_customer", secondary_metrics: ["conversion_to_paying", "initial_conversion_rate", "refund_rate"],
      notes: "## Hypothesis\nHigher price, same conversion.", enrollment: "new", track_paywall_views: false, enrollment_percent: 50, priority: 1, enrolled_customers: 0,
      audience_id: null, audience_rules: null, started_at: null, paused_at: null, stopped_at: null,
      variants: [
        { id: "a", name: "Control", offering_id: "ofr_default", placements: { onboarding: ob } }, { id: "b", name: "Higher", offering_id: o2, placements: { onboarding: o2 } },
        { id: "c", name: "Treatment C", offering_id: o3, placements: {} }, { id: "d", name: "Treatment D", offering_id: o4, placements: {} },
      ],
    });
    const second = await create({ name: "Legacy shape", offering_a: "ofr_default", offering_b: o2 });
    expect(second.body).toMatchObject({ priority: 2, type: "other", primary_metric: "initial_conversion_rate", variants: [{ id: "a", offering_id: "ofr_default" }, { id: "b", offering_id: o2 }] });

    const bad = async (json: unknown, param?: string) => {
      const r = await create(json);
      expect(r.status, JSON.stringify(json)).toBe(400);
      if (param) expect(r.body.param).toBe(param);
      return r.body.message as string;
    };
    expect(await bad({ name: "Same", variants: [{ offering_id: o2 }, { offering_id: o2 }] }, "variants.1")).toMatch(/same offering and placements as Control/);
    await bad({ name: "Five", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }, { offering_id: o3 }, { offering_id: o4 }, { offering_id: ob }] });
    await bad({ name: "One", variants: [{ offering_id: o2 }] });
    await bad({ name: "Ghost", variants: [{ offering_id: "ofr_default" }, { offering_id: "ofrng_nope" }] }, "variants.1.offering_id");
    await bad({ name: "Slot", variants: [{ offering_id: "ofr_default" }, { offering_id: o2, placements: { "bad slot!": o3 } }] }, "variants.1.placements");
    await bad({ name: "Ids", variants: [{ id: "b", offering_id: "ofr_default" }, { offering_id: o2 }] }, "variants.0.id");
    await bad({ name: "Both", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }], offering_a: "ofr_default" }, "variants");
    await bad({ name: "None" }, "variants");
    await bad({ name: "Track", enrollment: "new_and_existing", track_paywall_views: false, variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] }, "track_paywall_views");
    await bad({ name: "Metric", primary_metric: "trials_started", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] });
    await bad({ name: "Rules", audience_rules: { groups: [{ conditions: [{ field: "favoriteColor", operator: "is", value: "x" }] }] }, variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] }, "audience_rules.groups.0.conditions.0.field");
    const aud = (await call("POST", "/v2/projects/{project_id}/audiences", {}, { json: { name: "US", rules: { groups: [{ conditions: [{ field: "country", operator: "is", value: "USA" }] }] } } })).body.id;
    await bad({ name: "Two audiences", audience_id: aud, audience_rules: { groups: [] }, variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] }, "audience_rules");
    // New and existing customers turns paywall tracking on.
    const ne = await create({ name: "Everyone", enrollment: "new_and_existing", audience_id: aud, variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] });
    expect(ne.body).toMatchObject({ enrollment: "new_and_existing", track_paywall_views: true, audience_id: aud, priority: 3 });
    expect((await call("GET", "/v2/projects/{project_id}/audiences/{audience_id}", { audience_id: aud }, { query: "expand=used_by" })).body.used_by.experiments)
      .toEqual([{ object: "experiment_reference", id: ne.body.id, display_name: "Everyone", status: "draft" }]);
  });

  it("locks variants, enrollment and audience once started; name, notes, metrics and share stay editable", async () => {
    const o2 = await offering("o2");
    const id = (await create({ name: "Lock", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    const draft = await call("POST", ONE, { experiment_id: id }, ext({ enrollment: "new_and_existing", audience_rules: { groups: [{ conditions: [{ field: "platform", operator: "is", value: "ios" }] }] } }));
    expect(draft.body).toMatchObject({ enrollment: "new_and_existing", track_paywall_views: true, audience_rules: { groups: [{ conditions: [{ field: "platform" }] }] } });
    expect((await act(id, "start")).body).toMatchObject({ status: "running", started_at: h.now().getTime() });
    const ok = await call("POST", ONE, { experiment_id: id }, ext({ name: "Locked", notes: "n", primary_metric: "conversion_to_paying", secondary_metrics: ["mrr"], enrollment_percent: 30, type: "paywall_design" }));
    expect(ok.body).toMatchObject({ name: "Locked", notes: "n", primary_metric: "conversion_to_paying", secondary_metrics: ["mrr"], enrollment_percent: 30, type: "paywall_design" });
    for (const json of [{ variants: [{ offering_id: o2 }, { offering_id: "ofr_default" }] }, { enrollment: "new" }, { audience_id: null }, { offering_b: "ofr_default" }, { track_paywall_views: false }]) {
      const r = await call("POST", ONE, { experiment_id: id }, ext(json));
      expect(r.status, JSON.stringify(json)).toBe(422);
    }
    later(1);
    expect((await act(id, "pause")).body).toMatchObject({ status: "paused", paused_at: h.now().getTime() });
    later(1);
    const resumed = (await act(id, "start")).body;
    expect(resumed).toMatchObject({ status: "running", paused_at: null });
    expect(resumed.started_at).toBeLessThan(h.now().getTime());
    expect((await call("DELETE", ONE, { experiment_id: id }, ext())).status).toBe(422);
    expect((await act(id, "stop")).body.status).toBe("stopped");
    const again = await act(id, "start");
    expect(again.status).toBe(422);
    expect(again.body.message).toMatch(/duplicate it instead/);
  });
});

describe("enrollment", () => {
  it("new customers only: customers first seen before the start are never enrolled; new ones are", async () => {
    const o2 = await offering("o2");
    await newCustomer("old1");
    later(1);
    const id = (await create({ name: "New only", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    await act(id, "start");
    later(1);
    expect((await sdk("old1")).current_offering_id).toBe("default");
    for (let i = 0; i < 10; i++) { await newCustomer(`new${i}`); await sdk(`new${i}`); }
    const rows = await enrollments(id);
    expect(rows.length).toBe(10);
    expect(rows.some((r) => r.customerId === "old1")).toBe(false);
    // The customer page's preview agrees with the SDK for the old customer.
    const summary = (await call("GET", "/v2/projects/{project_id}/customer_summaries", {}, { ext: true, query: "ids=old1" })).body.items[0].current_offering;
    expect(summary).toMatchObject({ source: "default" });
  });

  it("new and existing customers: anyone who asks is enrolled", async () => {
    const o2 = await offering("o2");
    await newCustomer("old1");
    later(1);
    const id = (await create({ name: "Everyone", enrollment: "new_and_existing", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    await act(id, "start");
    later(1);
    await sdk("old1");
    expect((await enrollments(id)).map((r) => r.customerId)).toEqual([expect.stringMatching(/^cus_/)]);
  });

  it("four variants: even split, sticky, EXPERIMENT_ENROLLMENT once, placements overlay the targeting rule's", async () => {
    const [o2, o3, o4, rulePl, pb] = [await offering("o2"), await offering("o3"), await offering("o4"), await offering("rule_pl"), await offering("pb")];
    await call("POST", "/v2/projects/{project_id}/targeting_rules", {}, ext({ name: "Everyone", offering_id: "ofr_default", placements: { settings: rulePl, onboarding: rulePl }, state: "active" }));
    const id = (await create({
      name: "Four", variants: [{ offering_id: "ofr_default" }, { offering_id: o2, placements: { onboarding: pb } }, { offering_id: o3, placements: { onboarding: null } }, { offering_id: o4 }],
    })).body.id;
    await act(id, "start");
    later(1);
    const seen: Record<string, any> = {};
    for (let i = 0; i < 200; i++) { await newCustomer(`m${i}`); seen[`m${i}`] = await sdk(`m${i}`); }
    const byOffering: Record<string, number> = {};
    for (const s of Object.values(seen)) byOffering[s.current_offering_id] = (byOffering[s.current_offering_id] ?? 0) + 1;
    expect(Object.keys(byOffering).sort()).toEqual(["default", "o2", "o3", "o4"]);
    for (const n of Object.values(byOffering)) expect(n).toBeGreaterThan(25);
    const one = (k: string) => Object.values(seen).find((s) => s.current_offering_id === k);
    expect(one("o2").placements).toEqual({ fallback_offering_id: "o2", offering_ids_by_placement: { settings: "rule_pl", onboarding: "pb" } });
    expect(one("o3").placements.offering_ids_by_placement).toEqual({ settings: "rule_pl", onboarding: null });
    expect(one("default").placements.offering_ids_by_placement).toEqual({ settings: "rule_pl", onboarding: "rule_pl" });
    // Sticky across requests and after the enrollment share drops.
    await call("POST", ONE, { experiment_id: id }, ext({ enrollment_percent: 1 }));
    for (let i = 0; i < 40; i++) expect((await sdk(`m${i}`)).current_offering_id).toBe(seen[`m${i}`].current_offering_id);
    const rows = await enrollments(id);
    expect(rows.length).toBe(200);
    expect(new Set(rows.map((r) => r.variant))).toEqual(new Set(["a", "b", "c", "d"]));
    const evs = await h.db.select().from(schema.events).where(eq(schema.events.type, "EXPERIMENT_ENROLLMENT"));
    expect(evs.length).toBe(200);
    const variantOf = Object.fromEntries(rows.map((r) => [r.customerId, r.variant]));
    for (const e of evs.slice(0, 20)) expect((e.payload as any).event.experiment_variant).toBe(variantOf[e.customerId!]);
    // A purchase's webhook event names the experiment and variant.
    const buyer = Object.keys(seen).find((u) => seen[u].current_offering_id === "o4")!;
    await buy(h, buyer, "pro_monthly", h.now());
    const ip = (await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE")))[0]!;
    expect((ip.payload as any).event.experiments).toEqual([{ experiment_id: id, experiment_variant: "d", enrolled_at_ms: expect.any(Number) }]);
    // The v2 customer names the enrollment in RevenueCat's shape (checked against its schema).
    const cust = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}", { customer_id: buyer });
    expect(cust.body.experiment).toEqual({ object: "experiment_enrollment", id, name: "Four", variant: "d" });
  });

  it("priority: the first running experiment by priority enrolls; reorder changes it for new customers only", async () => {
    const [o2, o3] = [await offering("o2"), await offering("o3")];
    const first = (await create({ name: "First", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    const second = (await create({ name: "Second", variants: [{ offering_id: "ofr_default" }, { offering_id: o3 }] })).body.id;
    const draft = (await create({ name: "Draft", variants: [{ offering_id: "ofr_default" }, { offering_id: o3 }] })).body.id;
    await act(second, "start"); later(1); await act(first, "start"); later(1);
    for (let i = 0; i < 12; i++) { await newCustomer(`p${i}`); await sdk(`p${i}`); }
    expect((await enrollments(first)).length).toBe(12);
    expect((await enrollments(second)).length).toBe(0);
    const bad = await call("POST", `${EXP}/actions/reorder`, {}, ext({ experiment_ids: [second, first] }));
    expect(bad.status).toBe(400);
    const re = await call("POST", `${EXP}/actions/reorder`, {}, ext({ experiment_ids: [second, draft, first] }));
    expect(re.body.items.map((x: any) => [x.name, x.priority])).toEqual([["Second", 1], ["Draft", 2], ["First", 3]]);
    for (let i = 0; i < 12; i++) { await newCustomer(`q${i}`); await sdk(`q${i}`); }
    expect((await enrollments(second)).length).toBe(12);
    // Customers already in First stay there.
    for (let i = 0; i < 12; i++) await sdk(`p${i}`);
    expect((await enrollments(first)).length).toBe(12);
    expect((await enrollments(second)).length).toBe(12);
    const audit = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actionType, "experiment_reorder"));
    expect(audit.length).toBe(1);
  });

  it("inline audience conditions and the enrollment share decide who joins", async () => {
    const o2 = await offering("o2");
    const id = (await create({ name: "Android only", audience_rules: { groups: [{ conditions: [{ field: "platform", operator: "is", value: "android" }] }] }, variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    await act(id, "start"); later(1);
    for (let i = 0; i < 6; i++) {
      await newCustomer(`ios${i}`, { "x-platform": "iOS" }); await sdk(`ios${i}`, { "x-platform": "iOS" });
      await newCustomer(`and${i}`, { "x-platform": "android" }); await sdk(`and${i}`, { "x-platform": "android" });
    }
    const rows = await enrollments(id);
    expect(rows.length).toBe(6);
    const ids = new Set((await h.db.select().from(schema.customerAliases)).filter((a) => a.appUserId.startsWith("and")).map((a) => a.customerId));
    expect(rows.every((r) => ids.has(r.customerId))).toBe(true);
  });

  it("migration 0032 turns an A/B experiment into variants a and b without moving anyone", async () => {
    const o2 = await offering("o2");
    const now = h.now();
    // A row as the first release wrote it: no variants, enrollment and priority at their column defaults.
    await h.db.execute(sql`insert into experiments (id, project_id, name, status, enrollment_percent, offering_a, offering_b, started_at, created_at, variants, enrollment, priority)
      values ('prexp_legacy01', 'proj1', 'Legacy AB', 'running', 100, 'ofr_default', ${o2}, ${now.toISOString()}, ${now.toISOString()}, '[]'::jsonb, 'new', 0)`);
    for (const [user, variant] of [["la", "a"], ["lb", "b"]] as const) {
      await newCustomer(user);
      const [a] = await h.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, user));
      await h.db.insert(schema.experimentEnrollments).values({ experimentId: "prexp_legacy01", customerId: a!.customerId, variant, enrolledAt: now });
    }
    // Even before the data migration runs, the server reads offering_a and offering_b.
    expect((await sdk("lb")).current_offering_id).toBe("o2");
    const file = readFileSync(fileURLToPath(new URL("../../db/migrations/0032_experiments_v2.sql", import.meta.url)), "utf8");
    for (const stmt of file.split("--> statement-breakpoint").filter((s) => /^\s*(--.*\n)*\s*UPDATE/m.test(s))) await h.db.execute(sql.raw(stmt));
    const got = (await call("GET", ONE, { experiment_id: "prexp_legacy01" }, ext())).body;
    expect(got).toMatchObject({ enrollment: "new_and_existing", priority: 1, enrolled_customers: 2, variants: [{ id: "a", name: "Control", offering_id: "ofr_default", placements: {} }, { id: "b", name: "Treatment B", offering_id: o2, placements: {} }] });
    expect((await sdk("la")).current_offering_id).toBe("default");
    expect((await sdk("lb")).current_offering_id).toBe("o2");
  });
});

describe("offerings for treatments", () => {
  it("duplicates an offering exactly, or reordered with swapped products and the paywall; refuses to delete an offering an experiment uses", async () => {
    const exact = await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({ lookup_key: "default_copy", display_name: "Copy" }));
    expect(exact.status).toBe(201);
    expect(exact.body).toMatchObject({ lookup_key: "default_copy", display_name: "Copy", is_current: false });
    expect(exact.body.packages.items.map((p: any) => [p.lookup_key, p.products.items.map((x: any) => x.product.id).sort()])).toEqual([["$rc_monthly", ["p1", "p3", "p4"]], ["$rc_annual", ["p2"]]]);
    const swapped = await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({
      lookup_key: "annual_first", display_name: "Annual first", packages: [{ source_package_id: "pkg_a" }, { source_package_id: "pkg_m", products: [{ product_id: "p2", eligibility_criteria: "all" }] }],
    }));
    expect(swapped.body.packages.items.map((p: any) => [p.lookup_key, p.position, p.products.items.map((x: any) => x.product.id)])).toEqual([["$rc_annual", 0, ["p2"]], ["$rc_monthly", 1, ["p2"]]]);
    expect((await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({ lookup_key: "default", display_name: "x" }))).status).toBe(409);
    expect((await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({ lookup_key: "x1", display_name: "x", packages: [{ source_package_id: "pkge_other" }] }))).status).toBe(400);
    expect((await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({ lookup_key: "x2", display_name: "x", copy_paywall: true }))).status).toBe(400);
    const pw = await call("POST", "/v2/projects/{project_id}/paywalls", {}, { ext: true, json: { offering_id: "ofr_default" } });
    expect(pw.status).toBeLessThan(300);
    const design = await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/actions/duplicate", { offering_id: "ofr_default" }, ext({ lookup_key: "design_b", display_name: "Design B", copy_paywall: true }));
    expect(design.status).toBe(201);
    expect(design.body.paywall_id).toEqual(expect.stringMatching(/^pw/));
    expect(design.body.paywall_id).not.toBe(pw.body.id);

    const id = (await create({ name: "Uses copy", variants: [{ offering_id: "ofr_default" }, { offering_id: exact.body.id, placements: { onboarding: swapped.body.id } }] })).body.id;
    for (const o of [exact.body.id, swapped.body.id]) {
      const del = await call("DELETE", "/v2/projects/{project_id}/offerings/{offering_id}", { offering_id: o });
      expect(del.status).toBe(409);
      expect(del.body.message).toMatch(/used by the draft experiment "Uses copy"/);
    }
    await act(id, "start"); await act(id, "stop");
    expect((await call("DELETE", "/v2/projects/{project_id}/offerings/{offering_id}", { offering_id: exact.body.id })).status).toBe(200);
    // The stopped experiment keeps its results and the deleted offering's id.
    const kept = (await call("GET", ONE, { experiment_id: id }, ext())).body;
    expect(kept.variants[1].offering_id).toBe(exact.body.id);
    expect((await call("GET", `${ONE}/results`, { experiment_id: id }, ext())).status).toBe(200);
  });
});

describe("results, CSV and the estimate", () => {
  it("reports every metric with intervals, filters by platform, country and paywall views, and exports CSV", async () => {
    const o2 = await offering("o2");
    const id = (await create({ name: "Results", type: "subscription_duration", enrollment: "new_and_existing", variants: [{ offering_id: "ofr_default" }, { offering_id: o2 }] })).body.id;
    await act(id, "start"); later(1);
    const users: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      const u = `r${i}`;
      const headers = { "x-platform": i % 3 ? "iOS" : "android", "x-storefront": i % 2 ? "USA" : "DEU" };
      await newCustomer(u, headers);
      users[u] = (await sdk(u, headers)).current_offering_id;
    }
    // Every third customer views a paywall; a few buy (sandbox: Test Store).
    const evs = Object.keys(users).filter((_, i) => i % 3 === 0).map((u, i) => ({ id: `ev${i}`, type: "paywall_impression", app_user_id: u, timestamp_ms: h.now().getTime() }));
    expect((await h.fetch("/v1/events", { method: "POST", key: h.ids.testKey, json: { events: evs } })).status).toBeLessThan(300);
    later(1);
    const buyers = Object.keys(users).filter((_, i) => i % 4 === 0);
    for (const u of buyers) expect((await buy(h, u, "pro_monthly", h.now(), 10)).status).toBe(200);
    later(60);

    const r = (await call("GET", `${ONE}/results`, { experiment_id: id }, ext(undefined, "environment=sandbox&paywall=all"))).body;
    expect(r).toMatchObject({ object: "experiment_results", environment: "sandbox", currency: "USD", primary_metric: "realized_ltv_per_customer", control_variant_id: "a", filters: { platform: null, country: null, paywall: "all" } });
    expect(r.filter_options).toEqual({ platforms: ["android", "iOS"], countries: ["DEU", "USA"] });
    expect(r.metrics.map((m: any) => m.id)).toContain("trial_conversion_rate");
    const items = r.variants.items;
    expect(items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(30);
    expect(items.reduce((s: number, v: any) => s + v.metrics.paid_customers.value, 0)).toBe(buyers.length);
    expect(items.reduce((s: number, v: any) => s + v.metrics.realized_ltv.value, 0)).toBeCloseTo(buyers.length * 10, 2);
    for (const v of items) {
      expect(v.metrics.initial_conversion_rate).toMatchObject({ numerator: v.metrics.initial_conversions.value, denominator: v.customers });
      expect(v.metrics.initial_conversion_rate.lower).toBeLessThanOrEqual(v.metrics.initial_conversion_rate.value);
      expect(v.conversions).toBe(v.metrics.initial_conversions.value);
    }
    expect(items[1].metrics.conversion_to_paying.chance_to_beat_control).toBeGreaterThanOrEqual(0);
    expect(r.guidance).toMatchObject({ enough_data: false, min_customers: 100, min_events: 10 });
    expect(r.series.days.length).toBeGreaterThanOrEqual(1);
    expect(r.series.values.realized_ltv.a.length).toBe(r.series.days.length);
    // Production: no purchases.
    expect((await call("GET", `${ONE}/results`, { experiment_id: id }, ext())).body.variants.items.every((v: any) => v.metrics.initial_conversions.value === 0)).toBe(true);
    // Tracked paywall views: the default counts viewers only.
    const viewed = (await call("GET", `${ONE}/results`, { experiment_id: id }, ext(undefined, "environment=sandbox"))).body;
    expect(viewed.filters.paywall).toBe("viewed");
    expect(viewed.variants.items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(10);
    const android = (await call("GET", `${ONE}/results`, { experiment_id: id }, ext(undefined, "environment=sandbox&paywall=all&platform=ANDROID&country=deu"))).body;
    expect(android.variants.items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(5);
    expect((await call("GET", `${ONE}/results`, { experiment_id: id }, ext(undefined, "paywall=maybe"))).status).toBe(400);

    const csv = await h.fetch(`/v2/projects/proj1/experiments/${id}/results/export?kind=summary&environment=sandbox&paywall=all`, { key: h.ids.secretKey });
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toMatch(new RegExp(`experiment-${id}-summary-sandbox-\\d{4}-\\d{2}-\\d{2}\\.csv`));
    const rows = parseCsv(await csv.text());
    expect(rows[0]!.slice(0, 7)).toEqual(["variant_id", "variant_name", "offering_id", "customers", "metric", "metric_name", "value"]);
    const ltv = rows.filter((x) => x[4] === "realized_ltv").reduce((s, x) => s + Number(x[6]), 0);
    expect(ltv).toBeCloseTo(buyers.length * 10, 2);
    const daily = parseCsv(await (await h.fetch(`/v2/projects/proj1/experiments/${id}/results/export?kind=daily&environment=sandbox`, { key: h.ids.secretKey })).text());
    expect(daily[0]!.slice(0, 4)).toEqual(["date", "variant_id", "variant_name", "initial_conversion_rate"]);
    expect(daily.length - 1).toBe(viewed.series.days.length * 2);
    expect((await h.fetch(`/v2/projects/proj1/experiments/${id}/results/export?kind=pdf`, { key: h.ids.secretKey })).status).toBe(400);
  });

  it("estimates matching customers in the last 7 days", async () => {
    for (let i = 0; i < 8; i++) await newCustomer(`e${i}`, { "x-platform": i % 2 ? "iOS" : "android" });
    const est = async (json: unknown) => (await call("POST", `${EXP}/actions/estimate`, {}, ext(json))).body;
    expect(await est({ variant_count: 2 })).toEqual({ object: "experiment_estimate", period_days: 7, matching_customers: 8, enrolled_customers: 8, customers_per_variant: 4, is_approximate: false });
    const rules = { groups: [{ conditions: [{ field: "platform", operator: "is", value: "android" }] }] };
    expect(await est({ audience_rules: rules, enrollment_percent: 50, variant_count: 4 })).toMatchObject({ matching_customers: 4, enrolled_customers: 2, customers_per_variant: 0 });
    h.setNow(new Date(h.now().getTime() + 8 * 86_400_000));
    expect((await est({})).matching_customers).toBe(0);
    await newCustomer("e1");
    expect((await est({ enrollment: "new_and_existing" })).matching_customers).toBe(1);
  });
});
