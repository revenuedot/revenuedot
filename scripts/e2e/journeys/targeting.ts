// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (e), targeting and experiments. The developer makes an audience from an attribute the app sets
// through the SDK, a targeting rule with placements, and an offering experiment with two offerings. Customers fetch
// offerings with the SDK's call; enrolled customers buy from their variant. Checks: the offering and placements each
// customer's SDK gets, sticky enrollment, EXPERIMENT_ENROLLMENT delivered once per customer to a webhook that asked for
// it, `experiments` on the purchase webhook, and the experiment results (customers, conversions, revenue).
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, signUp, standardCatalog } from "./lib/context.ts";

const journey: Journey = {
  name: "targeting",
  title: "Targeting: audience from SDK attributes, rule with placements, two-offering experiment, enrollment, results",
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "growth", "Targeting app");
    const cat = await standardCatalog(dev);
    const sdk = sdkClient(ctx, cat.testKey);
    const hookPath = `/hooks/targeting-${ctx.stamp}`;
    await dev.v2("POST", "/integrations/webhooks", { name: "Experiments", url: ctx.capture.base + hookPath, event_types: ["experiment_enrollment", "initial_purchase"] });
    const mkOffering = async (key: string, product: any) => {
      const o = await dev.v2("POST", "/offerings", { lookup_key: key, display_name: key });
      const pkg = await dev.v2("POST", `/offerings/${o.id}/packages`, { lookup_key: "$rc_monthly", display_name: "Monthly", position: 0 });
      await dev.v2("POST", `/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: product.id, eligibility_criteria: "all" }] });
      return o;
    };
    const promo = await mkOffering("promo", cat.products.annual);
    const onboarding = await mkOffering("onboarding", cat.products.monthly);
    const variantB = await mkOffering("variant_b", cat.products.annual);
    const offeringsFor = async (u: string) => (await sdk.offerings(u)).body;

    c.begin("audience from an attribute the app sets");
    const gold = `gold_${ctx.stamp}`, silver = `silver_${ctx.stamp}`;
    for (const [u, plan] of [[gold, "gold"], [silver, "silver"]] as const) {
      await sdk.customerInfo(u);
      const a = await sdk.attributes(u, { plan, $email: `${u}@example.com` });
      c.check(`SDK attributes saved for ${plan}`, a.status === 200, a.body);
    }
    const aud = await dev.v2("POST", "/audiences", { name: "Gold plan", rules: { groups: [{ conditions: [{ field: "customAttribute:plan", operator: "is", value: "gold" }] }] } });
    const audFull = await dev.v2("GET", `/audiences/${aud.id}?expand=stats&expand=customer_sample`);
    c.check("audience stats count the gold customer only", audFull.stats?.total_customers === 1 && audFull.customer_sample?.[0]?.app_user_id === gold, audFull);

    c.begin("targeting rule with placements");
    const rule = await dev.v2("POST", "/targeting_rules", { name: "Gold gets promo", audience_id: aud.id, offering_id: promo.id, placements: { onboarding_end: onboarding.id, settings: null }, state: "active" });
    const g = await offeringsFor(gold);
    c.check("gold customer: current offering promo, placements and targeting in the SDK response", g.current_offering_id === "promo" && g.placements?.offering_ids_by_placement?.onboarding_end === "onboarding" && g.targeting?.rule_id === rule.id, { current: g.current_offering_id, placements: g.placements, targeting: g.targeting });
    const s = await offeringsFor(silver);
    c.check("silver customer: the project's current offering, no targeting", s.current_offering_id === "default" && !s.targeting, { current: s.current_offering_id, targeting: s.targeting });
    await dev.v2("POST", `/targeting_rules/${rule.id}`, { state: "inactive" });
    c.eq("an inactive rule stops applying", (await offeringsFor(gold)).current_offering_id, "default");
    await dev.v2("POST", `/targeting_rules/${rule.id}`, { state: "active" });
    const purchaseFromPlacement = await sdk.purchase(gold, "pro_annual", { price: 59.99, presented_offering_identifier: "onboarding", presented_placement_identifier: "onboarding_end", applied_targeting_rule: { rule_id: rule.id, revision: 3 } });
    c.check("gold buys from the placement's offering", purchaseFromPlacement.status === 200);
    const ip = (await eventsOf(ctx, dev.projectId, { type: "INITIAL_PURCHASE", appUserId: gold }))[0];
    c.has("the purchase event names the presented offering", ip, { presented_offering_id: "onboarding" });
    await dev.v2("POST", `/targeting_rules/${rule.id}`, { state: "inactive" });

    c.begin("experiment with two offerings");
    const exp = await dev.v2("POST", "/experiments", { name: "Default vs variant B", offering_a: cat.offering.id, offering_b: variantB.id });
    c.has("experiment created as a draft at 100%", exp, { status: "draft", enrollment_percent: 100 });
    const started = await dev.v2("POST", `/experiments/${exp.id}/actions/start`);
    c.eq("experiment started", started.status, "running");
    const seen: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      const u = `exp_${i}_${ctx.stamp}`;
      await sdk.customerInfo(u);
      seen[u] = (await offeringsFor(u)).current_offering_id;
    }
    const counts = Object.values(seen).reduce((m: Record<string, number>, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
    c.check("customers are split between the two offerings", counts.default > 0 && counts.variant_b > 0 && counts.default + counts.variant_b === 30, counts);
    let sticky = true;
    for (const [u, off] of Object.entries(seen)) if ((await offeringsFor(u)).current_offering_id !== off) sticky = false;
    c.check("every customer keeps their variant on the next fetch", sticky);
    const enrolled = await ctx.sql`SELECT count(*)::int AS n FROM experiment_enrollments WHERE experiment_id = ${exp.id}`;
    c.eq("30 enrollments stored", enrolled[0]!.n, 30);

    // Two customers in each variant buy what their variant shows.
    const buyers = { a: Object.keys(seen).filter((u) => seen[u] === "default").slice(0, 2), b: Object.keys(seen).filter((u) => seen[u] === "variant_b").slice(0, 3) };
    for (const u of buyers.a) await sdk.purchase(u, "pro_monthly", { price: 9.99, presented_offering_identifier: "default" });
    for (const u of buyers.b) await sdk.purchase(u, "pro_annual", { price: 59.99, presented_offering_identifier: "variant_b" });

    c.begin("enrollment and purchase webhooks");
    const enrollments = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.path === hookPath).map((r) => JSON.parse(r.body).event).filter((e) => e.type === "EXPERIMENT_ENROLLMENT");
      return got.length >= 30 ? got : null;
    }, { timeoutMs: 60_000, everyMs: 1000 });
    c.eq("EXPERIMENT_ENROLLMENT delivered once per customer (30)", enrollments?.length, 30);
    c.check("enrollment events carry the experiment, the variant and the offering", (enrollments ?? []).every((e: any) => e.experiment_id === exp.id && ["a", "b"].includes(e.experiment_variant) && e.offering_id), enrollments?.[0]);
    const purchases = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.path === hookPath).map((r) => JSON.parse(r.body).event).filter((e) => e.type === "INITIAL_PURCHASE" && Object.keys(seen).includes(e.app_user_id));
      return got.length >= 5 ? got : null;
    }, { timeoutMs: 60_000, everyMs: 1000 });
    c.check("each enrolled buyer's INITIAL_PURCHASE webhook carries `experiments` with its variant", (purchases ?? []).length === 5 && purchases!.every((e: any) => e.experiments?.[0]?.experiment_id === exp.id && e.experiments[0].experiment_variant === (seen[e.app_user_id] === "default" ? "a" : "b")), purchases?.map((e: any) => [e.app_user_id, e.experiments]));

    c.begin("results");
    const res = await dev.v2("GET", `/experiments/${exp.id}/results?environment=sandbox`);
    const va = res.variants.items.find((v: any) => v.id === "a"), vb = res.variants.items.find((v: any) => v.id === "b");
    c.check("customers per variant match the enrollments", va.customers === counts.default && vb.customers === counts.variant_b, { va, vb, counts });
    c.check("conversions: 2 in A, 3 in B", va.conversions === 2 && vb.conversions === 3, { a: va.conversions, b: vb.conversions });
    c.check("revenue: A 19.98, B 179.97", Math.abs(Number(va.revenue ?? va.revenue_in_usd ?? 0) - 19.98) < 0.01 && Math.abs(Number(vb.revenue ?? vb.revenue_in_usd ?? 0) - 179.97) < 0.01, { a: va, b: vb });
    c.check("chance that B beats A is a probability", typeof res.chance_b_beats_a === "number" && res.chance_b_beats_a >= 0 && res.chance_b_beats_a <= 1, res.chance_b_beats_a);
    await dev.v2("POST", `/experiments/${exp.id}/actions/pause`);
    const late = `late_${ctx.stamp}`;
    await sdk.customerInfo(late);
    c.eq("a paused experiment enrolls nobody new", (await offeringsFor(late)).current_offering_id, "default");
    c.eq("enrolled customers keep their variant while paused", (await offeringsFor(buyers.b[0]!)).current_offering_id, "variant_b");
    const stopped = await dev.v2("POST", `/experiments/${exp.id}/actions/stop`);
    c.eq("experiment stopped", stopped.status, "stopped");
  },
};
export default journey;
