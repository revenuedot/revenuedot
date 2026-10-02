// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (experiments), Experiments v2 (prd/experiments/PRD.md) on the real Node server and a fresh Railway
// development database. A growth developer makes treatment offerings with the duplicate action (reordered packages,
// a swapped product), runs a four-variant experiment for new US customers with a placement and a two-variant one for new
// and existing customers, and reorders them. Hundreds of customers come through the SDK's own calls (customer info,
// offerings) from iOS and Android; some buy, start trials, lapse or get refunded through the Test Store pipeline.
// Checks: who joins which experiment (mode, audience, priority), an even and sticky split, placements in the SDK
// answer, EXPERIMENT_ENROLLMENT once per customer to a webhook and `experiments` on purchases, every result metric
// against the database, the CSV exports, the 409 on deleting a live experiment's offering, and in Chromium the list in
// priority order, the results page and Create with RevenueDot AI saving a draft after approval (scripted Anthropic API).
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, sdkClient, signUp, standardCatalog } from "./lib/context.ts";
import { chromium } from "./onboarding.ts";
import { join } from "node:path";

const parseCsv = (text: string) => text.trim().split("\r\n").map((l) => l.split(","));
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

const journey: Journey = {
  name: "experiments",
  title: "Experiments v2: 4 and 2 variants, modes, audience, priority, placements, 400 SDK customers, results against SQL, CSV, AI draft",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "growth", "Experiments app");
    const cat = await standardCatalog(dev);
    const ios = sdkClient(ctx, cat.testKey, "iOS");
    const android = sdkClient(ctx, cat.testKey, "Android");
    const hookPath = `/hooks/experiments-${ctx.stamp}`;
    await dev.v2("POST", "/integrations/webhooks", { name: "Experiments", url: ctx.capture.base + hookPath, event_types: ["experiment_enrollment", "initial_purchase"] });

    c.begin("treatment offerings from the duplicate action");
    const pk = cat.packages;
    const annualFirst = await dev.v2("POST", `/offerings/${cat.offering.id}/actions/duplicate`, { lookup_key: "annual_first", display_name: "Annual first", packages: [{ source_package_id: pk.$rc_annual.id }, { source_package_id: pk.$rc_monthly.id }, { source_package_id: pk.$rc_lifetime.id }] });
    c.eq("annual_first: packages reordered", annualFirst.packages.items.map((p: any) => p.lookup_key), ["$rc_annual", "$rc_monthly", "$rc_lifetime"]);
    const allAnnual = await dev.v2("POST", `/offerings/${cat.offering.id}/actions/duplicate`, { lookup_key: "all_annual", display_name: "Annual only", packages: [{ source_package_id: pk.$rc_monthly.id, products: [{ product_id: cat.products.annual.id, eligibility_criteria: "all" }] }] });
    c.eq("all_annual: the monthly package now sells the annual product", allAnnual.packages.items.map((p: any) => [p.lookup_key, p.products.items.map((x: any) => x.product.store_identifier)]), [["$rc_monthly", ["pro_annual"]]]);
    const copy = await dev.v2("POST", `/offerings/${cat.offering.id}/actions/duplicate`, { lookup_key: "default_copy", display_name: "Copy" });
    c.eq("an exact copy keeps every package and product", copy.packages.items.map((p: any) => p.lookup_key), ["$rc_monthly", "$rc_annual", "$rc_lifetime"]);
    const onboarding = await dev.v2("POST", "/offerings", { lookup_key: "onboarding", display_name: "Onboarding" });

    c.begin("two experiments with modes, an inline audience, a placement and priorities");
    // Customers seen before anything starts: 30 on iOS in the US.
    const old = Array.from({ length: 30 }, (_, i) => `old_${i}_${ctx.stamp}`);
    for (const u of old) await ios.customerInfo(u);
    const four = await dev.v2("POST", "/experiments", {
      name: "Plans for new US customers", type: "subscription_ordering", enrollment: "new", notes: "Annual first should lift realized LTV per customer.",
      audience_rules: { groups: [{ conditions: [{ field: "country", operator: "is", value: "US" }, { field: "platform", operator: "is", value: "ios" }] }] },
      variants: [{ offering_id: cat.offering.id }, { offering_id: annualFirst.id, placements: { onboarding_end: onboarding.id } }, { offering_id: allAnnual.id }, { offering_id: copy.id, placements: { onboarding_end: null } }],
    });
    const two = await dev.v2("POST", "/experiments", { name: "Everyone: annual only", enrollment: "new_and_existing", variants: [{ offering_id: cat.offering.id }, { offering_id: allAnnual.id }] });
    c.has("four variants a to d, new customers, priority 1", four, { status: "draft", enrollment: "new", priority: 1, track_paywall_views: false, type: "subscription_ordering", primary_metric: "initial_conversion_rate" });
    c.eq("variant ids", four.variants.map((v: any) => v.id), ["a", "b", "c", "d"]);
    c.has("two variants, new and existing customers, paywall tracking forced on, priority 2", two, { enrollment: "new_and_existing", track_paywall_views: true, priority: 2 });
    const del = await dev.v2r("DELETE", `/offerings/${annualFirst.id}`);
    c.check("an offering a draft experiment uses cannot be deleted (409)", del.status === 409 && /Plans for new US customers/.test(del.body.message), del);
    for (const x of [four, two]) await dev.v2("POST", `/experiments/${x.id}/actions/start`);

    c.begin("enrollment through the SDK's calls");
    const seen: Record<string, { exp: string | null; offering: string; body: any }> = {};
    const open = async (sdk: typeof ios, u: string) => {
      await sdk.customerInfo(u);
      const body = (await sdk.offerings(u)).body;
      seen[u] = { exp: null, offering: body.current_offering_id, body };
      return body;
    };
    const newIos = Array.from({ length: 320 }, (_, i) => `ios_${i}_${ctx.stamp}`);
    const newAndroid = Array.from({ length: 60 }, (_, i) => `and_${i}_${ctx.stamp}`);
    for (const u of newIos) await open(ios, u);
    for (const u of newAndroid) await open(android, u);
    for (const u of old) await open(ios, u);
    const rows = await ctx.sql<{ experiment_id: string; variant: string; app_user_id: string; enrolled_at: Date }[]>`
      SELECT e.experiment_id, e.variant, c.original_app_user_id AS app_user_id, e.enrolled_at FROM experiment_enrollments e JOIN customers c ON c.id = e.customer_id WHERE c.project_id = ${dev.projectId}`;
    const expOf = new Map(rows.map((r) => [r.app_user_id, r]));
    c.check("every new iOS customer in the US joined the four-variant experiment", newIos.every((u) => expOf.get(u)?.experiment_id === four.id), newIos.filter((u) => expOf.get(u)?.experiment_id !== four.id).slice(0, 5));
    c.check("Android customers fall through to the second experiment", newAndroid.every((u) => expOf.get(u)?.experiment_id === two.id), newAndroid.filter((u) => expOf.get(u)?.experiment_id !== two.id).slice(0, 5));
    c.check("customers seen before the start skip the new-customers experiment and join the new-and-existing one", old.every((u) => expOf.get(u)?.experiment_id === two.id), old.filter((u) => expOf.get(u)?.experiment_id !== two.id).slice(0, 5));
    const split: Record<string, number> = {};
    for (const u of newIos) split[expOf.get(u)!.variant] = (split[expOf.get(u)!.variant] ?? 0) + 1;
    c.check("four variants split evenly (each 80 ± 30)", ["a", "b", "c", "d"].every((v) => Math.abs((split[v] ?? 0) - 80) <= 30), split);
    const offeringOf: Record<string, string> = { a: "default", b: "annual_first", c: "all_annual", d: "default_copy" };
    c.check("each customer's SDK answer is their variant's offering", newIos.every((u) => seen[u]!.offering === offeringOf[expOf.get(u)!.variant]), newIos.filter((u) => seen[u]!.offering !== offeringOf[expOf.get(u)!.variant]).slice(0, 3));
    const bUser = newIos.find((u) => expOf.get(u)!.variant === "b")!, dUser = newIos.find((u) => expOf.get(u)!.variant === "d")!, aUser = newIos.find((u) => expOf.get(u)!.variant === "a")!;
    c.eq("variant b serves its placement", seen[bUser]!.body.placements, { fallback_offering_id: "annual_first", offering_ids_by_placement: { onboarding_end: "onboarding" } });
    c.eq("variant d shows no paywall at the placement", seen[dUser]!.body.placements.offering_ids_by_placement, { onboarding_end: null });
    c.eq("the control has no placements", seen[aUser]!.body.placements.offering_ids_by_placement, {});
    let sticky = true;
    for (const u of [...newIos.slice(0, 60), ...newAndroid.slice(0, 20), ...old.slice(0, 10)]) if ((await ios.offerings(u)).body.current_offering_id !== seen[u]!.offering && (await android.offerings(u)).body.current_offering_id !== seen[u]!.offering) sticky = false;
    c.check("every customer keeps their offering on later requests", sticky);
    c.eq("one enrollment row per customer", rows.length, newIos.length + newAndroid.length + old.length);

    c.begin("priority");
    const re = await dev.v2("POST", "/experiments/actions/reorder", { experiment_ids: [two.id, four.id] });
    c.eq("reorder puts the second experiment first", re.items.map((x: any) => [x.name, x.priority]), [["Everyone: annual only", 1], ["Plans for new US customers", 2]]);
    const late = Array.from({ length: 20 }, (_, i) => `late_${i}_${ctx.stamp}`);
    for (const u of late) await open(ios, u);
    const lateRows = await ctx.sql<{ experiment_id: string }[]>`SELECT e.experiment_id FROM experiment_enrollments e JOIN customers c ON c.id = e.customer_id WHERE c.original_app_user_id = ANY(${late})`;
    c.check("new US iOS customers now join the experiment ranked first", lateRows.length === 20 && lateRows.every((r) => r.experiment_id === two.id), lateRows);
    c.check("customers already in the four-variant experiment stay there", (await ios.offerings(newIos[0]!)).body.current_offering_id === seen[newIos[0]!]!.offering);
    const audit = await ctx.sql`SELECT action_type FROM audit_logs WHERE project_id = ${dev.projectId} AND action_type = 'experiment_reorder'`;
    c.eq("the reorder is in the audit log", audit.length, 1);

    c.begin("purchases, trials, lapses and refunds after joining");
    const byVariant = (v: string) => newIos.filter((u) => expOf.get(u)!.variant === v);
    const plan: [string, string, string][] = [];
    for (const v of ["a", "b", "c", "d"]) {
      const us = byVariant(v);
      us.slice(0, 6 + ["a", "b", "c", "d"].indexOf(v) * 3).forEach((u, i) => plan.push([u, i % 2 ? "pro_annual" : "pro_monthly", "purchase"]));
      us.slice(20, 24).forEach((u) => plan.push([u, "pro_monthly", "trial"]));
      us.slice(24, 26).forEach((u) => plan.push([u, "pro_monthly", "expire"]));
      us.slice(26, 27).forEach((u) => plan.push([u, "pro_annual", "refund"]));
    }
    // "expire" starts a period ago by default; these lapses start now (after joining) and end at once.
    for (const [u, product, scenario] of plan) await dev.v2("POST", "/test_purchases", { app_user_id: u, product_id: product, scenario, ...(scenario === "expire" ? { purchased_at: Date.now() - 2000 } : {}) });
    // Two customers buy through the SDK's own receipt post too.
    for (const u of byVariant("b").slice(30, 32)) await ios.purchase(u, "pro_annual", { price: 59.99, presented_offering_identifier: "annual_first" });

    c.begin("webhooks");
    const enrolledIds = new Set([...newIos, ...newAndroid, ...old, ...late]);
    const hooks = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.path === hookPath).map((r) => JSON.parse(r.body).event);
      return got.filter((e) => e.type === "EXPERIMENT_ENROLLMENT").length >= enrolledIds.size ? got : null;
    }, { timeoutMs: 300_000, everyMs: 3000 });
    const enrollEvents = (hooks ?? []).filter((e: any) => e.type === "EXPERIMENT_ENROLLMENT");
    c.eq("EXPERIMENT_ENROLLMENT delivered once per enrolled customer", enrollEvents.length, enrolledIds.size);
    c.check("each enrollment event names the customer's experiment and variant", enrollEvents.every((e: any) => { const r = expOf.get(e.app_user_id); return !r || (r.experiment_id === e.experiment_id && r.variant === e.experiment_variant); }), enrollEvents[0]);
    const purchaseEvents = await until(async () => {
      const got = ctx.capture.requests.filter((r) => r.path === hookPath).map((r) => JSON.parse(r.body).event).filter((e) => e.type === "INITIAL_PURCHASE" && e.app_user_id?.startsWith("ios_"));
      return got.length >= 10 ? got : null;
    }, { timeoutMs: 60_000, everyMs: 2000 });
    c.check("INITIAL_PURCHASE webhooks carry `experiments` with the buyer's variant", (purchaseEvents ?? []).every((e: any) => e.experiments?.[0]?.experiment_id === four.id && e.experiments[0].experiment_variant === expOf.get(e.app_user_id)!.variant), purchaseEvents?.slice(0, 2));

    c.begin("results against the database");
    const res = await dev.v2("GET", `/experiments/${four.id}/results?environment=sandbox`);
    const db = await ctx.sql<{ variant: string; customers: number; converted: number; paid: number; refunded: number; trials: number; revenue: number }[]>`
      WITH e AS (SELECT en.customer_id, en.variant, en.enrolled_at FROM experiment_enrollments en WHERE en.experiment_id = ${four.id}),
      t AS (SELECT e.variant, e.customer_id, tx.kind, tx.revenue_usd FROM e JOIN transactions tx ON tx.customer_id = e.customer_id AND tx.is_sandbox AND tx.purchased_at >= e.enrolled_at - interval '1 minute')
      SELECT e.variant, count(DISTINCT e.customer_id)::int AS customers,
        (SELECT count(DISTINCT customer_id) FROM t WHERE t.variant = e.variant AND kind IN ('trial', 'purchase', 'one_time'))::int AS converted,
        (SELECT count(DISTINCT customer_id) FROM t WHERE t.variant = e.variant AND kind IN ('purchase', 'renewal', 'one_time') AND revenue_usd > 0)::int AS paid,
        (SELECT count(DISTINCT customer_id) FROM t WHERE t.variant = e.variant AND kind = 'refund')::int AS refunded,
        (SELECT count(*) FROM t WHERE t.variant = e.variant AND kind = 'trial')::int AS trials,
        (SELECT coalesce(sum(revenue_usd), 0) FROM t WHERE t.variant = e.variant)::float AS revenue
      FROM e GROUP BY e.variant ORDER BY e.variant`;
    for (const row of db) {
      const v = res.variants.items.find((x: any) => x.id === row.variant);
      const m = v.metrics;
      c.check(`variant ${row.variant}: customers, conversions, payers, refunds, trials and revenue match SQL`,
        v.customers === row.customers && m.initial_conversions.value === row.converted && m.paid_customers.value === row.paid && m.refunded_customers.value === row.refunded
        && m.trials_started.value === row.trials && near(m.realized_ltv.value, row.revenue) && near(m.realized_ltv_per_customer.value, row.revenue / row.customers, 0.0001)
        && near(m.initial_conversion_rate.value, row.converted / row.customers, 0.000001),
        { api: { customers: v.customers, conv: m.initial_conversions.value, paid: m.paid_customers.value, refunded: m.refunded_customers.value, trials: m.trials_started.value, ltv: m.realized_ltv.value }, sql: row });
      c.check(`variant ${row.variant}: rate intervals hold the value`, m.initial_conversion_rate.lower <= m.initial_conversion_rate.value && m.initial_conversion_rate.value <= m.initial_conversion_rate.upper, m.initial_conversion_rate);
    }
    const lapsed = await ctx.sql<{ variant: string; n: number }[]>`SELECT e.variant, count(DISTINCT e.customer_id)::int AS n FROM experiment_enrollments e JOIN subscriptions s ON s.customer_id = e.customer_id
      WHERE e.experiment_id = ${four.id} AND s.is_sandbox AND s.period_type = 'normal' AND s.refunded_at IS NULL AND s.expires_date <= now() AND s.original_purchase_date >= e.enrolled_at - interval '1 minute' GROUP BY e.variant`;
    c.check("churned subscribers: every variant counts the subscriptions bought after joining that lapsed", lapsed.length === 4 && lapsed.every((l) => res.variants.items.find((x: any) => x.id === l.variant).metrics.churned_subscribers.value === l.n), { sql: lapsed, api: res.variants.items.map((x: any) => [x.id, x.metrics.churned_subscribers.value]) });
    c.check("treatments carry a lift and a chance to beat the control; the control none", res.variants.items.slice(1).every((v: any) => typeof v.metrics.conversion_to_paying.chance_to_beat_control === "number") && res.variants.items[0].metrics.conversion_to_paying.chance_to_beat_control === undefined, res.variants.items.map((v: any) => v.metrics.conversion_to_paying));
    c.check("guidance says it is too early (under 100 customers per variant)", res.guidance.enough_data === false && /Too early to call/.test(res.guidance.message), res.guidance);
    c.check("the series has one value per day and variant", res.series.days.length >= 1 && res.series.values.realized_ltv.a.length === res.series.days.length, res.series.days);
    const prod = await dev.v2("GET", `/experiments/${four.id}/results`);
    c.check("production results count no sandbox purchases", prod.variants.items.every((v: any) => v.metrics.initial_conversions.value === 0), prod.variants.items.map((v: any) => v.metrics.initial_conversions.value));

    c.begin("CSV exports");
    const csv = await dev.call("GET", `/v2/projects/${dev.projectId}/experiments/${four.id}/results/export?kind=summary&environment=sandbox`);
    c.check("summary CSV is a download", csv.status === 200 && /text\/csv/.test(csv.headers.get("content-type") ?? "") && /attachment; filename="experiment-/.test(csv.headers.get("content-disposition") ?? ""), [csv.status, csv.headers.get("content-type")]);
    const sum = parseCsv(csv.body as string);
    const ltvRows = sum.filter((r) => r[4] === "realized_ltv");
    c.check("summary CSV: realized LTV per variant equals the API", ltvRows.length === 4 && ltvRows.every((r) => near(Number(r[6]), res.variants.items.find((v: any) => v.id === r[0]).metrics.realized_ltv.value)), ltvRows);
    const daily = parseCsv((await dev.call("GET", `/v2/projects/${dev.projectId}/experiments/${four.id}/results/export?kind=daily&environment=sandbox`)).body as string);
    c.eq("daily CSV: a row per day and variant", daily.length - 1, res.series.days.length * 4);

    c.begin("in the browser: list order, results, Create with RevenueDot AI");
    const browser = await chromium().launch();
    const errors: string[] = [];
    try {
      const context = await browser.newContext({ acceptDownloads: true });
      await context.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
      const page = await context.newPage();
      page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${ctx.base}/projects/${dev.projectId}/experiments`);
      await page.locator(".xp-item").first().waitFor();
      c.eq("the list shows the enrollment order", await page.locator(".xp-item .xp-item-main b").allTextContents(), ["Everyone: annual only", "Plans for new US customers"]);
      await page.getByText("Plans for new US customers").click();
      await page.getByLabel("Environment").selectOption("sandbox");
      await page.locator('tr[data-metric="initial_conversion_rate"]').waitFor();
      const kpis = (await page.locator(".xp-kpis .kpi .v").allTextContents()).map((x) => Number(x.replace(/,/g, "")));
      c.eq("the page shows each variant's customers", kpis, res.variants.items.map((v: any) => v.customers));
      const guidance = await page.getByTestId("xp-guidance").innerText();
      c.check("the page shows the guidance", /Too early to call/.test(guidance), guidance);
      await page.getByRole("button", { name: "Export CSV" }).click();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Summary per variant (CSV)" }).click()]);
      c.check("the CSV downloads from the page", /^experiment-.*-summary-sandbox-/.test(dl.suggestedFilename()), dl.suggestedFilename());
      await page.screenshot({ path: join(ctx.out, "results.png"), fullPage: true });

      await page.goto(`${ctx.base}/projects/${dev.projectId}/experiments`);
      await page.getByRole("button", { name: "New experiment" }).click();
      await page.getByRole("menuitem", { name: "Create with RevenueDot AI" }).click();
      await page.getByLabel("What do you want to test?").fill("Test the onboarding offering against the default one, with a price change");
      await page.getByRole("button", { name: "Draft it" }).click();
      await page.waitForURL(/\/ai\/aic\w+$/);
      const card = page.getByTestId("approval-card").last();
      await card.waitFor({ timeout: 30_000 });
      c.check("the approval card says a draft experiment will be saved", /Save the draft experiment "default vs onboarding"/.test(await card.innerText()), await card.innerText());
      const before = (await dev.v2("GET", "/experiments?limit=100")).items.length;
      c.eq("nothing is saved before the approval", before, 2);
      await card.getByRole("button", { name: "Approve" }).click();
      await page.getByText(/is saved as a draft with 2 variants/).waitFor({ timeout: 30_000 });
      const drafted = (await dev.v2("GET", "/experiments?limit=100")).items.find((x: any) => x.name === "default vs onboarding");
      c.has("RevenueDot AI saved a draft (real Anthropic provider path, scripted model)", drafted, { status: "draft", type: "price_point", priority: 3 });
      const [log] = await ctx.sql`SELECT actor_type, additional_data FROM audit_logs WHERE project_id = ${dev.projectId} AND action_type = 'experiment_created' AND target_identifier = ${drafted?.id ?? ""}`;
      c.check("the draft is audited as RevenueDot AI on behalf of the developer", log?.actor_type === "assistant" && String(log?.additional_data?.actor_display ?? "").startsWith("assistant on behalf of"), log);
      c.eq("no console errors in the browser", errors, []);
    } finally { await browser.close(); }

    c.begin("pause, stop, and what customers see after");
    await dev.v2("POST", `/experiments/${four.id}/actions/pause`);
    c.eq("paused: an enrolled customer keeps their variant", (await ios.offerings(bUser)).body.current_offering_id, "annual_first");
    await dev.v2("POST", `/experiments/${two.id}/actions/stop`);
    await dev.v2("POST", `/experiments/${four.id}/actions/stop`);
    c.eq("stopped: they get the current offering again", (await ios.offerings(bUser)).body.current_offering_id, "default");
    c.eq("stopped experiments keep their results", (await dev.v2("GET", `/experiments/${four.id}/results?environment=sandbox`)).variants.items.reduce((s: number, v: any) => s + v.customers, 0), newIos.length);
    c.eq("the offering of a stopped experiment can be deleted", (await dev.v2r("DELETE", `/offerings/${copy.id}`)).status, 200);
  },
};
export default journey;
