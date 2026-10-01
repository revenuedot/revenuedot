import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { conditionMatches, emptyContext } from "@revenuedot/server/services/targeting.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const AUD = "/v2/projects/{project_id}/audiences";
const RULES = "/v2/projects/{project_id}/targeting_rules";
const EXP = "/v2/projects/{project_id}/experiments";
const gold = { groups: [{ conditions: [{ field: "customAttribute:plan", operator: "is", value: "gold" }] }] };
const sdk = async (user: string, headers: Record<string, string> = {}) => (await (await h.fetch(`/v1/subscribers/${encodeURIComponent(user)}/offerings`, { key: h.ids.testKey, headers })).json()) as any;
async function customer(id: string, attrs: Record<string, string> = {}) {
  await h.fetch(`/v1/subscribers/${id}`, { key: h.ids.testKey });
  if (Object.keys(attrs).length) await call("POST", "/v2/projects/{project_id}/customers/{customer_id}/attributes", { customer_id: id }, { json: { attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) } });
}
async function offering(key: string) {
  const r = await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: key, display_name: key } });
  return r.body.id as string;
}

describe("conditions", () => {
  const now = Date.UTC(2026, 8, 30);
  const ctx = { ...emptyContext(), country: "US", appVersion: "2.10.0", platform: "ios", totalSpent: 42, activeEntitlements: ["pro"], firstSeenAt: now - 3 * 86400_000, attributes: { plan: "gold", $email: "a@b.io" } };
  const m = (field: string, operator: string, value = "") => conditionMatches(ctx, { field, operator, value }, now);
  it("compares text, lists, numbers, versions, dates and attributes", () => {
    expect(m("country", "is", "us")).toBe(true);
    expect(m("country", "isAnyOf", "GB, US")).toBe(true);
    expect(m("country", "isNotAnyOf", "GB,DE")).toBe(true);
    expect(m("appVersion", "greaterThan", "2.9.5")).toBe(true);
    expect(m("appVersion", "lessThan", "2.10.0")).toBe(false);
    expect(m("totalSpent", "greaterThanOrEqual", "42")).toBe(true);
    expect(m("totalSpent", "between", "10,20")).toBe(false);
    expect(m("activeEntitlements", "is", "pro")).toBe(true);
    expect(m("hasActiveEntitlement", "is", "true")).toBe(true);
    expect(m("firstSeenAt", "within", "7d")).toBe(true);
    expect(m("firstSeenAt", "within", "1d")).toBe(false);
    expect(m("firstSeenAt", "before", new Date(now).toISOString())).toBe(true);
    expect(m("customAttribute:plan", "contains", "ol")).toBe(true);
    expect(m("customAttribute:missing", "isEmpty")).toBe(true);
    expect(m("customAttribute:missing", "is", "x")).toBe(false);
    expect(m("email", "isNotEmpty")).toBe(true);
    expect(m("platform", "is", "android")).toBe(false);
  });
});

describe("audiences", () => {
  it("creates, lists, gets with expansions, updates, previews and refuses unknown fields", async () => {
    await customer("g1", { plan: "gold" });
    await customer("s1", { plan: "silver" });
    await buy(h, "g1", "pro_monthly", new Date());
    const made = await call("POST", AUD, {}, { json: { name: "Gold plan", rules: gold } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ object: "audience", name: "Gold plan", project_id: "proj1", updated_at: null });
    const id = made.body.id;
    expect((await call("POST", AUD, {}, { json: { name: "Bad", rules: { groups: [{ conditions: [{ field: "favoriteColor", operator: "is", value: "x" }] }] } } })).status).toBe(400);
    expect((await call("POST", AUD, {}, { json: { name: "Bad", rules: { groups: [{ conditions: [{ field: "country", operator: "likes", value: "x" }] }] } } })).status).toBe(400);
    expect((await call("GET", AUD)).body.items.map((a: any) => a.id)).toEqual([id]);

    const full = await call("GET", `${AUD}/{audience_id}`, { audience_id: id }, { query: "expand=stats&expand=customer_sample&expand=used_by" });
    expect(full.body.stats).toMatchObject({ total_customers: 1, active_subscriptions: 1, currency: "USD", is_approximate: false });
    expect(full.body.customer_sample.map((x: any) => x.app_user_id)).toEqual(["g1"]);
    expect(full.body.used_by).toEqual({ object: "audience_used_by", targeting_rules: [], experiments: [] });

    const pv = await call("POST", `${AUD}/actions/preview`, {}, { json: { rules: { groups: [{ conditions: [{ field: "customAttribute:plan", operator: "isAnyOf", value: "gold,silver" }] }] } } });
    expect(pv.body).toMatchObject({ object: "audience_preview", stats: { total_customers: 2 } });
    expect((await call("POST", `${AUD}/actions/preview`, {}, { json: { audience_uuid: id } })).body.stats.total_customers).toBe(1);

    const upd = await call("POST", `${AUD}/{audience_id}`, { audience_id: id }, { json: { name: "Gold" } });
    expect(upd.body.name).toBe("Gold");
    expect(upd.body.updated_at).toBeGreaterThan(0);
    expect((await call("POST", `${AUD}/{audience_id}`, { audience_id: id }, { json: {} })).status).toBe(400);
    expect((await call("GET", `${AUD}/{audience_id}`, { audience_id: "aud_nope" })).status).toBe(404);

    const opts = await call("GET", `${AUD}/filter_options`, {}, { query: "fields=customAttribute:plan,latestProduct" });
    expect(opts.body.items[0]).toMatchObject({ field: "customAttribute:plan", cardinality_exceeded: false });
    expect(opts.body.items[0].options.map((o: any) => o.id).sort()).toEqual(["gold", "silver"]);
    expect(opts.body.items[1].options.length).toBeGreaterThan(0);
  });
});

describe("targeting rules", () => {
  it("serves the first live matching rule's offering and placements to the SDK, with the rule in `targeting`", async () => {
    const promo = await offering("promo");
    const onboarding = await offering("onboarding");
    const aud = (await call("POST", AUD, {}, { json: { name: "Gold", rules: gold } })).body.id;
    await customer("g1", { plan: "gold" });
    await customer("s1", { plan: "silver" });
    expect((await sdk("g1")).current_offering_id).toBe("default");

    const rule = await call("POST", RULES, {}, { ext: true, json: { name: "Gold gets promo", audience_id: aud, offering_id: promo, placements: { onboarding_end: onboarding, settings: null }, state: "active" } });
    expect(rule.status).toBe(201);
    const g = await sdk("g1");
    expect(g.current_offering_id).toBe("promo");
    expect(g.placements).toEqual({ fallback_offering_id: "promo", offering_ids_by_placement: { onboarding_end: "onboarding", settings: null } });
    expect(g.targeting).toEqual({ revision: 1, rule_id: rule.body.id });
    const s = await sdk("s1");
    expect(s.current_offering_id).toBe("default");
    expect(s.targeting).toBeUndefined();

    // Inactive and not-yet-started rules are skipped; an everyone rule below catches the rest; order decides.
    const everyone = await call("POST", RULES, {}, { ext: true, json: { name: "Everyone", offering_id: onboarding, state: "active" } });
    expect((await sdk("s1")).current_offering_id).toBe("onboarding");
    await call("POST", `${RULES}/actions/reorder`, {}, { ext: true, json: { rule_ids: [everyone.body.id, rule.body.id] } });
    expect((await sdk("g1")).current_offering_id).toBe("onboarding");
    await call("POST", `${RULES}/{rule_id}`, { rule_id: everyone.body.id }, { ext: true, json: { starts_at: Date.now() + 86400_000 } });
    expect((await sdk("g1")).current_offering_id).toBe("promo");
    const off = await call("POST", `${RULES}/{rule_id}`, { rule_id: rule.body.id }, { ext: true, json: { state: "inactive" } });
    expect(off.body.revision).toBe(2);
    expect((await sdk("g1")).current_offering_id).toBe("default");

    // An offering override for one customer beats targeting.
    await call("POST", `${RULES}/{rule_id}`, { rule_id: rule.body.id }, { ext: true, json: { state: "active" } });
    await call("POST", "/v2/projects/{project_id}/customers/{customer_id}/actions/assign_offering", { customer_id: "g1" }, { json: { offering_id: "ofr_default" } });
    expect((await sdk("g1")).current_offering_id).toBe("default");

    expect((await call("GET", `${AUD}/{audience_id}`, { audience_id: aud }, { query: "expand=used_by" })).body.used_by.targeting_rules).toHaveLength(1);
    expect((await call("DELETE", `${AUD}/{audience_id}`, { audience_id: aud }, { ext: true })).status).toBe(409);
    expect((await call("POST", RULES, {}, { ext: true, json: { name: "x", offering_id: "ofrng_nope" } })).status).toBe(400);
    expect((await call("POST", `${RULES}/actions/reorder`, {}, { ext: true, json: { rule_ids: [rule.body.id] } })).status).toBe(400);
    expect((await call("DELETE", `${RULES}/{rule_id}`, { rule_id: rule.body.id }, { ext: true })).body.id).toBe(rule.body.id);
  });
});

describe("experiments", () => {
  it("enrolls customers into two variants for good, sends EXPERIMENT_ENROLLMENT once, tags their webhooks, and reports results", async () => {
    const promo = await offering("promo");
    const exp = await call("POST", EXP, {}, { ext: true, json: { name: "Promo vs default", offering_a: "ofr_default", offering_b: promo } });
    expect(exp.status).toBe(201);
    expect(exp.body).toMatchObject({ status: "draft", enrollment_percent: 100, variants: [{ id: "a", offering_id: "ofr_default" }, { id: "b", offering_id: promo }] });
    const id = exp.body.id;
    // A draft enrolls nobody.
    await customer("early");
    expect((await sdk("early")).current_offering_id).toBe("default");
    expect((await call("POST", `${EXP}/{experiment_id}/actions/start`, { experiment_id: id }, { ext: true })).body.status).toBe("running");

    const seen: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      await customer(`u${i}`);
      seen[`u${i}`] = (await sdk(`u${i}`)).current_offering_id;
    }
    const counts = Object.values(seen).reduce((m: Record<string, number>, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
    expect(Object.keys(counts).sort()).toEqual(["default", "promo"]);
    for (let i = 0; i < 40; i++) expect((await sdk(`u${i}`)).current_offering_id).toBe(seen[`u${i}`]);
    const enrolled = await h.db.select().from(schema.experimentEnrollments).where(eq(schema.experimentEnrollments.experimentId, id));
    expect(enrolled.length).toBe(40); // "early" asked while the experiment was a draft and has not asked since
    const evs = await h.db.select().from(schema.events).where(eq(schema.events.type, "EXPERIMENT_ENROLLMENT"));
    expect(evs.length).toBe(40);
    const e = (evs[0]!.payload as any).event;
    expect(Object.keys(e).sort()).toEqual(["aliases", "app_user_id", "event_timestamp_ms", "experiment_enrolled_at_ms", "experiment_id", "experiment_variant", "id", "offering_id", "original_app_user_id", "type"]);

    // A purchase by an enrolled customer carries `experiments` in its webhook event.
    const buyer = Object.keys(seen).find((u) => seen[u] === "promo")!;
    await buy(h, buyer, "pro_monthly", new Date(Date.now() + 1000), 10);
    const ip = await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE"));
    expect((ip[0]!.payload as any).event.experiments).toEqual([{ experiment_id: id, experiment_variant: "b", enrolled_at_ms: expect.any(Number) }]);

    expect((await call("GET", `${EXP}/{experiment_id}/results`, { experiment_id: id }, { ext: true })).body.variants.items.every((v: any) => v.conversions === 0)).toBe(true);
    const res = await call("GET", `${EXP}/{experiment_id}/results`, { experiment_id: id }, { ext: true, query: "environment=sandbox" });
    const b = res.body.variants.items.find((v: any) => v.id === "b");
    expect(b).toMatchObject({ offering_id: promo, conversions: 1 });
    expect(res.body.variants.items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(40);
    expect(res.body.chance_b_beats_a).toBeGreaterThan(0.5);
    expect(res.body.enough_data).toBe(false);

    // Paused: enrolled customers keep their variant, new ones are not enrolled.
    await call("POST", `${EXP}/{experiment_id}/actions/pause`, { experiment_id: id }, { ext: true });
    expect((await sdk(buyer)).current_offering_id).toBe("promo");
    await customer("late");
    expect((await sdk("late")).current_offering_id).toBe("default");
    expect((await call("POST", `${EXP}/{experiment_id}`, { experiment_id: id }, { ext: true, json: { offering_b: "ofr_default" } })).status).toBe(422);
    expect((await call("DELETE", `${EXP}/{experiment_id}`, { experiment_id: id }, { ext: true })).status).toBe(200);
  });

  it("validates variants and transitions, and honours the enrollment percentage", async () => {
    const promo = await offering("promo");
    expect((await call("POST", EXP, {}, { ext: true, json: { name: "x", offering_a: promo, offering_b: promo } })).status).toBe(400);
    const id = (await call("POST", EXP, {}, { ext: true, json: { name: "Half", offering_a: "ofr_default", offering_b: promo, enrollment_percent: 1 } })).body.id;
    expect((await call("POST", `${EXP}/{experiment_id}/actions/pause`, { experiment_id: id }, { ext: true })).status).toBe(422);
    await call("POST", `${EXP}/{experiment_id}/actions/start`, { experiment_id: id }, { ext: true });
    for (let i = 0; i < 30; i++) { await customer(`p${i}`); await sdk(`p${i}`); }
    const n = (await h.db.select().from(schema.experimentEnrollments)).length;
    expect(n).toBeLessThan(5);
    expect((await call("POST", `${EXP}/{experiment_id}/actions/stop`, { experiment_id: id }, { ext: true })).body.status).toBe("stopped");
    expect((await call("POST", `${EXP}/{experiment_id}/actions/start`, { experiment_id: id }, { ext: true })).status).toBe(422);
  });
});
