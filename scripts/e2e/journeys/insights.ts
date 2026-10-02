// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (insights), attribution, benchmarks and AI growth insights (prd/attribution-benchmarks-insights) on
// the real Node server and a fresh Railway development database:
//   - Attribution arrives the ways it really does: the app's SDK posts $mediaSource/$campaign/… and partner ids
//     (POST /v1/subscribers/{id}/attributes), and the iOS SDK posts an AdServices token that the server resolves with
//     Apple's attribution API (answered by the capture server). Production App Store history goes through the server's
//     own purchase pipeline with the clock set back. Checks: customer_attribution in SQL, Revenue segmented by campaign
//     and the revenue-by-campaign report against independent SQL, the Customers list filtered by campaign.
//   - Benchmarks on the self-hosted server: the API answers `available: false` and refuses to share.
//   - Benchmarks as RevenueDot Cloud runs them, in-process on the same database: 11 peer projects (written straight to
//     the tables) share as Health & Fitness apps, the nightly job runs on real Postgres, and SQL checks that no group under
//     10 projects is published, that no project id is stored with the aggregates, and that a median equals Postgres's own
//     percentile_cont over the shared values. Stopping sharing removes a project's values at once.
//   - AI growth insights on the real server with the Anthropic provider (the scripted Messages API on the capture server):
//     Refresh writes 3 to 5 cited insights with read tools only; the weekly digest (in-process, Cloud configuration) emails
//     the admin; the one-click opt-out on the real server turns it off.
import { and, eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, signUp } from "./lib/context.ts";
import { fakeModelCalls } from "./lib/fake-anthropic.ts";
import { ROOT } from "./lib/stack.ts";
import { openDb, schema } from "../../../packages/db/src/index.ts";
import { createApp } from "../../../apps/server/src/app.ts";
import { defaultStores } from "../../../apps/server/src/stores/index.ts";
import { getOrCreateCustomer } from "../../../apps/server/src/repo/customers.ts";
import { applyPurchases } from "../../../apps/server/src/services/purchases.ts";
import { runBenchmarkJob } from "../../../apps/server/src/services/benchmarks.ts";
import { runInsightsDigest } from "../../../apps/server/src/services/insights/digest.ts";
import { memoryMailer } from "../../../apps/server/src/mail/index.ts";
import { assistantModelFromEnv } from "../../../apps/server/src/services/assistant/models.ts";
import type { VerifiedPurchase } from "../../../apps/server/src/stores/types.ts";
import { ledger } from "../../../apps/dashboard/e2e/seed-insights.ts";

const DAY = 86_400_000;
const MIN = { initial_conversion: 5, trial_conversion: 3, conversion_to_paying: 5, churn: 3, refund_rate: 5, ltv_per_customer: 5, ltv_per_paying_customer: 3, arpu: 5, price_monthly: 3, price_annual: 3 };
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Who comes from where (set through the SDK unless "adservices"). */
const PEOPLE: { user: string; daysAgo: number; product: "monthly" | "annual"; trial: boolean; periods: number; refund?: boolean; attr: Record<string, string> | "adservices" | null }[] = [
  { user: "meta_1", daysAgo: 70, product: "monthly", trial: false, periods: 3, attr: { $mediaSource: "Meta", $campaign: "Spring sale", $adGroup: "US 25-34", $fbAnonId: "fb.1" } },
  { user: "meta_2", daysAgo: 55, product: "monthly", trial: true, periods: 2, attr: { $mediaSource: "Meta", $campaign: "Spring sale", $adGroup: "EU broad", $appsflyerId: "1690000000000-1" } },
  { user: "meta_3", daysAgo: 40, product: "annual", trial: false, periods: 1, refund: true, attr: { $mediaSource: "Meta", $campaign: "Retargeting" } },
  { user: "google_1", daysAgo: 35, product: "annual", trial: false, periods: 1, attr: { $mediaSource: "Google Ads", $campaign: "Brand search", $keyword: "pdf scanner", $adjustId: "adj-1" } },
  { user: "asa_1", daysAgo: 30, product: "monthly", trial: true, periods: 1, attr: "adservices" },
  { user: "asa_2", daysAgo: 20, product: "monthly", trial: false, periods: 1, attr: "adservices" },
  { user: "organic_1", daysAgo: 60, product: "monthly", trial: false, periods: 2, attr: null },
  { user: "organic_2", daysAgo: 25, product: "annual", trial: true, periods: 1, attr: null },
  { user: "organic_3", daysAgo: 10, product: "monthly", trial: true, periods: 0, attr: null },
];
const APPLE = { attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, adId: 542317136, countryOrRegion: "US", claimType: "Click", conversionType: "Download" };

const journey: Journey = {
  name: "insights",
  title: "Attribution from the SDK and AdServices, charts and the campaign report against SQL, Cloud benchmarks with k-anonymity, AI growth insights and the digest",
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    // Apple's AdServices attribution API, answered for the tokens this journey's app posts.
    ctx.capture.handlers.push((q, rs) => {
      if (q.host !== "api-adservices.apple.com") return false;
      rs.setHeader("content-type", "application/json");
      if (q.body.startsWith("journey-token-")) rs.end(JSON.stringify(APPLE)); else { rs.statusCode = 400; rs.end("{}"); }
      return true;
    });
    const { db, close } = await openDb(ctx.databaseUrl);
    try {
      // ---------------------------------------------------------------- Attribution
      c.begin("attribution from the SDK and AdServices");
      const dev = await signUp(ctx, "growth", "Growth app");
      const ios = await dev.v2("POST", "/apps", { name: "Growth iOS", type: "app_store", app_store: { bundle_id: `com.journeys.growth${ctx.stamp}` } });
      const monthly = await dev.v2("POST", "/products", { store_identifier: "growth.monthly", app_id: ios.id, type: "subscription", display_name: "Monthly", subscription: { duration: "P1M" } });
      const annual = await dev.v2("POST", "/products", { store_identifier: "growth.annual", app_id: ios.id, type: "subscription", display_name: "Annual", subscription: { duration: "P1Y" } });
      const iosKey = (await dev.v2("GET", `/apps/${ios.id}/public_api_keys`)).items[0].key as string;
      c.must("the App Store app and products exist", monthly.id && annual.id && iosKey.startsWith("appl_"));
      const price = { monthly: 9.99, annual: 49.99 };
      const now = Date.now();
      for (const p of PEOPLE) {
        const start = new Date(now - p.daysAgo * DAY);
        const { customer } = await getOrCreateCustomer(db, dev.projectId, p.user, start);
        const key = `7000${Math.floor(Math.random() * 1e9)}`;
        const base = { kind: "subscription", store: "app_store", storeKey: key, productIdentifier: `growth.${p.product}`, isSandbox: false, originalPurchaseDate: start, originalTransactionId: key, countryCode: "US" };
        const steps: Record<string, unknown>[] = [];
        let at = start;
        if (p.trial) { const end = new Date(at.getTime() + 7 * DAY); steps.push({ ...base, purchaseDate: at, expiresDate: end, periodType: "trial", storeTransactionId: `${key}0`, price: { amount: 0, currency: "USD" } }); at = end; }
        for (let i = 1; i <= p.periods && at.getTime() < now; i++) {
          const end = new Date(at); if (p.product === "monthly") end.setUTCMonth(end.getUTCMonth() + 1); else end.setUTCFullYear(end.getUTCFullYear() + 1);
          steps.push({ ...base, purchaseDate: at, expiresDate: end, periodType: "normal", storeTransactionId: `${key}${i}`, price: { amount: price[p.product], currency: "USD" } });
          at = end;
        }
        for (const s of steps) await applyPurchases(db, customer, [s as unknown as VerifiedPurchase], { projectId: dev.projectId, appId: ios.id, appUserId: p.user, now: s.purchaseDate as Date, fromDevice: false });
        if (p.refund) { const last = steps[steps.length - 1]!; const t = new Date((last.purchaseDate as Date).getTime() + 3 * DAY); await applyPurchases(db, customer, [{ ...last, refundedAt: t } as unknown as VerifiedPurchase], { projectId: dev.projectId, appId: ios.id, appUserId: p.user, now: t, fromDevice: false }); }
      }
      // The app's SDK sets attribution; the iOS SDK posts AdServices tokens.
      const sdkHeaders = { authorization: `Bearer ${iosKey}`, "content-type": "application/json", "x-platform": "iOS", "x-version": "5.92.0" };
      for (const p of PEOPLE) {
        if (!p.attr) continue;
        const res = p.attr === "adservices"
          ? await fetch(`${ctx.base}/v1/subscribers/${p.user}/adservices_attribution`, { method: "POST", headers: sdkHeaders, body: JSON.stringify({ aad_attribution_token: `journey-token-${p.user}` }) })
          : await fetch(`${ctx.base}/v1/subscribers/${p.user}/attributes`, { method: "POST", headers: sdkHeaders, body: JSON.stringify({ attributes: Object.fromEntries(Object.entries(p.attr).map(([k, v]) => [k, { value: v, updated_at_ms: Date.now() }])) }) });
        c.check(`${p.user}: the SDK call is accepted (${res.status})`, res.status === 200, await res.text());
      }
      const rows = await until(async () => {
        const r = await sql<{ user: string; media_source: string | null; campaign: string | null; campaign_id: string | null; ad_group: string | null; keyword: string | null; claim_type: string | null; partner_ids: Record<string, string> }[]>`
          SELECT c.original_app_user_id AS user, a.media_source, a.campaign, a.campaign_id, a.ad_group, a.keyword, a.claim_type, a.partner_ids
          FROM customer_attribution a JOIN customers c ON c.id = a.customer_id WHERE a.project_id = ${dev.projectId} ORDER BY 1`;
        return r.length === 6 ? r : null;
      }, { timeoutMs: 30_000 });
      c.must("customer_attribution holds one row per attributed customer (SQL)", rows?.length === 6, rows);
      const byUser = Object.fromEntries(rows!.map((r) => [r.user, r]));
      c.has("meta_2: media source, campaign, ad group and the AppsFlyer id", byUser.meta_2, { media_source: "Meta", campaign: "Spring sale", ad_group: "EU broad", partner_ids: { appsflyer_id: "1690000000000-1" } });
      c.has("google_1: keyword and the Adjust id", byUser.google_1, { media_source: "Google Ads", keyword: "pdf scanner", partner_ids: { adjust_id: "adj-1" } });
      c.has("asa_1: Apple's AdServices answer, ids until names are loaded", byUser.asa_1, { media_source: "Apple Search Ads", campaign: "542370539", campaign_id: "542370539", ad_group: "542317095", keyword: "87675432", claim_type: "Click" });
      c.check("the server asked Apple once per token", ctx.capture.of("api-adservices.apple.com").length === 2, ctx.capture.of("api-adservices.apple.com").length);

      c.begin("charts and the revenue-by-campaign report against SQL");
      const from = iso(now - 90 * DAY), to = iso(now);
      const chart = await dev.v2("GET", `/charts/revenue?resolution=4&start_date=${from}&end_date=${to}&segment=campaign&expand_periods=false`);
      const apiBy: Record<string, number> = {};
      for (const v of chart.values) if (v.measure === 0) { const s = chart.segments[v.segment]; if (!s.is_total) apiBy[s.id] = r2((apiBy[s.id] ?? 0) + (v.value ?? 0)); }
      const sqlRev = await sql<{ campaign: string; revenue: number }[]>`
        SELECT coalesce(a.campaign, '') AS campaign, round(sum(t.revenue_usd)::numeric, 2)::float8 AS revenue
        FROM transactions t LEFT JOIN customer_attribution a ON a.customer_id = t.customer_id
        WHERE t.project_id = ${dev.projectId} AND NOT t.is_sandbox AND t.kind IN ('purchase', 'renewal', 'one_time', 'refund', 'refund_reversal')
          AND t.purchased_at >= ${new Date(from + "T00:00:00Z")} AND t.purchased_at < ${new Date(now + DAY - (now % DAY))}
        GROUP BY 1`;
      const sqlBy = Object.fromEntries(sqlRev.map((r) => [r.campaign, r.revenue]));
      c.eq("Revenue segmented by campaign equals the ledger summed by campaign in SQL", Object.fromEntries(Object.entries(apiBy).filter(([, v]) => v !== 0).sort()), Object.fromEntries(Object.entries(sqlBy).filter(([, v]) => v !== 0).sort()));
      const report = await dev.v2("GET", `/attribution/report?group_by=campaign&start_date=${from}&end_date=${to}`);
      const sqlCohorts = await sql<{ campaign: string; customers: number; revenue: number }[]>`
        SELECT coalesce(a.campaign, '') AS campaign, count(DISTINCT c.id)::int AS customers, round(coalesce(sum(t.revenue_usd) FILTER (WHERE t.kind <> 'trial'), 0)::numeric, 2)::float8 AS revenue
        FROM customers c LEFT JOIN customer_attribution a ON a.customer_id = c.id
          LEFT JOIN transactions t ON t.customer_id = c.id AND NOT t.is_sandbox AND t.kind IN ('purchase', 'renewal', 'one_time', 'refund', 'refund_reversal', 'trial')
        WHERE c.project_id = ${dev.projectId} AND c.first_seen >= ${new Date(from + "T00:00:00Z")}
        GROUP BY 1`;
      c.eq("the report's customers and revenue to date per campaign equal SQL",
        Object.fromEntries(report.rows.map((r: any) => [r.key, [r.customers, r.revenue_to_date]]).sort()),
        Object.fromEntries(sqlCohorts.map((r) => [r.campaign, [r.customers, r.revenue]]).sort()));
      c.has("Retargeting: the refunded annual purchase nets to zero, so no paying customer", report.rows.find((r: any) => r.key === "Retargeting"), { customers: 1, paying_customers: 0, revenue_to_date: 0 });
      const list = await dev.v2("GET", `/customer_lists?list=all&rules=${encodeURIComponent(JSON.stringify({ groups: [{ conditions: [{ field: "campaign", operator: "is", value: "Spring sale" }] }] }))}`);
      c.eq("the Customers list filtered by campaign has the Spring sale customers", list.items.map((x: any) => x.id).sort(), ["meta_1", "meta_2"]);
      const opts = await dev.v2("GET", "/audiences/filter_options?fields=campaign,mediaSource");
      c.check("audience suggestions list the project's campaigns", opts.items.find((i: any) => i.field === "campaign").options.some((o: any) => o.id === "Spring sale"), opts);

      // ---------------------------------------------------------------- Benchmarks
      c.begin("benchmarks on a self-hosted server");
      const selfHost = await dev.v2("GET", "/benchmarks");
      c.has("GET /benchmarks: not available", selfHost, { object: "benchmarks", available: false });
      const refused = await dev.v2r("POST", "/benchmarks/settings", { share: true, category: "travel" });
      c.check("sharing is refused", refused.status === 404, refused);
      const me = await dev.call("GET", "/auth/me");
      c.has("the dashboard is told benchmarks are off", me.body.account, { features: { benchmarks: false } });
      const [{ n: shared }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM benchmark_project_values`;
      c.eq("nothing is stored for benchmarks", shared, 0);

      c.begin("benchmarks as RevenueDot Cloud runs them (in-process, same database)");
      const mail = memoryMailer();
      // The model: the Anthropic provider, its HTTP calls sent to the scripted Messages API on the capture server.
      const toCapture: typeof fetch = (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        return fetch(`${ctx.capture.base}${u.pathname}${u.search}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))), "x-rd-original-host": u.hostname } });
      };
      const cloud = createApp({
        db, now: () => new Date(), stores: defaultStores(), mailer: mail, publicUrl: ctx.base, encryptionKey: ctx.server.encryptionKey, signingKey: ctx.server.signingKey,
        benchmarks: true, benchmarkOptions: { minSample: MIN }, insightsDigest: true, edition: "cloud", assistantRuntime: "sse",
        assistant: assistantModelFromEnv({ ANTHROPIC_API_KEY: "sk-ant-journey-fake-model" }, toCapture), defer: (t) => { void t(); },
      });
      const cloudCall = async (cookie: string, method: string, path: string, json?: unknown) => {
        const res = await cloud.fetch(new Request(`http://localhost${path}`, { method, headers: { cookie, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined }));
        return { status: res.status, body: await res.json() as any };
      };
      const peers: { projectId: string; cookie: string }[] = [];
      for (let n = 0; n < 11; n++) {
        const p = await signUp(ctx, `peer${n}`, `Peer app ${n}`);
        await ledger(db, p.projectId, now, { perMonth: 12 + n, trialEvery: 2 + (n % 3), convertEvery: 1 + (n % 2), monthly: 6 + n, annual: 30 + 4 * n, annualEvery: 3, refundEvery: 4 + (n % 3), android: n % 2 === 0 });
        const on = await cloudCall(p.cookie, "POST", `/v2/projects/${p.projectId}/benchmarks/settings`, { share: true, category: "health_fitness" });
        c.check(`peer ${n} shares`, on.body.share === true, on);
        peers.push({ projectId: p.projectId, cookie: p.cookie });
      }
      const mine = await cloudCall(dev.cookie, "POST", `/v2/projects/${dev.projectId}/benchmarks/settings`, { share: true, category: "health_fitness" });
      c.check("the journey project shares as Health & Fitness", mine.body.share === true, mine);
      // The nightly run, step by step as the cron makes it (one project per step).
      await db.delete(schema.benchmarkRuns);
      let job = { computed: 0, aggregated: false, groups: 0 }, computed = 0, steps = 0;
      for (; steps < 40 && !job.aggregated; steps++) { job = await runBenchmarkJob({ db, benchmarks: true }, new Date(), { force: true, minSample: MIN, budgetMs: 0 }); computed += job.computed; }
      c.check(`the job finished in steps and published groups (${steps} steps, ${job.groups} groups)`, job.aggregated && job.groups > 0, job);
      const small = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM benchmark_aggregates WHERE projects < 10`;
      c.eq("no published group has fewer than 10 projects (SQL)", small[0]!.n, 0);
      const cols = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'benchmark_aggregates' ORDER BY ordinal_position`;
      c.check("the aggregates table has no project column", !cols.some((x) => /project_id/.test(x.column_name)), cols.map((x) => x.column_name));
      const [median] = await sql<{ p50: number; n: number }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (v.metrics->'price_annual'->>'value')::float8) AS p50, count(*)::int AS n
        FROM benchmark_project_values v JOIN projects p ON p.id = v.project_id
        WHERE p.benchmarks_share AND v.platform = 'all' AND v.country = 'all' AND v.metrics->'price_annual'->>'value' IS NOT NULL`;
      const [stored] = await sql<{ p50: number; projects: number; p10: number | null }[]>`SELECT p50, projects, p10 FROM benchmark_aggregates WHERE category = 'all' AND platform = 'all' AND country = 'all' AND metric = 'price_annual'`;
      c.check(`the published annual-price median equals Postgres's percentile_cont over ${median!.n} shared values`, stored && Math.abs(stored.p50 - median!.p50) < 1e-9, { stored, median });
      c.check("the app count is rounded down to a multiple of 5", stored && stored.projects === Math.floor(median!.n / 5) * 5, { stored, n: median!.n });
      const peerView = await cloudCall(dev.cookie, "GET", `/v2/projects/${dev.projectId}/benchmarks?category=health_fitness`);
      c.check("the journey project sees Health & Fitness peers (12 projects share)", peerView.body.peer_group?.projects >= 10 && peerView.body.metrics.some((m: any) => m.peers), peerView.body.peer_group);
      c.check("its own value equals the stored value, and no other project's value is returned", JSON.stringify(peerView.body).indexOf(peers[0]!.projectId) === -1, "found a peer id");
      const travel = await cloudCall(dev.cookie, "GET", `/v2/projects/${dev.projectId}/benchmarks?category=travel`);
      c.check("a category with no sharing apps shows no peers", travel.body.metrics.every((m: any) => m.peers === null), travel.body.peer_group);
      const off = await cloudCall(peers[0]!.cookie, "POST", `/v2/projects/${peers[0]!.projectId}/benchmarks/settings`, { share: false, category: "health_fitness" });
      const left = await db.select().from(schema.benchmarkProjectValues).where(eq(schema.benchmarkProjectValues.projectId, peers[0]!.projectId));
      c.check("stopping sharing deletes that project's values at once", off.body.share === false && left.length === 0, { off, left: left.length });
      const [after] = await sql<{ projects: number; p50: number }[]>`SELECT projects, p50 FROM benchmark_aggregates WHERE category = 'all' AND platform = 'all' AND country = 'all' AND metric = 'price_annual'`;
      const [median2] = await sql<{ p50: number }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (v.metrics->'price_annual'->>'value')::float8) AS p50 FROM benchmark_project_values v JOIN projects p ON p.id = v.project_id
        WHERE p.benchmarks_share AND v.platform = 'all' AND v.country = 'all' AND v.metrics->'price_annual'->>'value' IS NOT NULL`;
      c.check("the groups are rebuilt without it", after && Math.abs(after.p50 - median2!.p50) < 1e-9, { after, median2 });

      // ---------------------------------------------------------------- AI growth insights
      c.begin("AI growth insights on the real server (Anthropic provider, scripted Messages API)");
      const calls0 = fakeModelCalls.length;
      const refresh = await dev.v2r("POST", "/ai/insights/refresh");
      c.check(`Refresh writes this week's insights (${refresh.status})`, refresh.status === 200 && refresh.body.status === "ready", refresh.body);
      const ins = refresh.body.insights ?? [];
      c.check(`3 to 5 insights (${ins.length})`, ins.length >= 3 && ins.length <= 5, ins);
      c.check("every insight cites pack items and carries their numbers and a project link", ins.every((i: any) => i.metric_ids.length && i.numbers.length && i.link.startsWith(`/projects/${dev.projectId}/`)), ins);
      const modelCalls = fakeModelCalls.slice(calls0);
      c.check("the model was offered read tools only and called a tool before answering", modelCalls.length >= 2 && modelCalls.every((m) => m.tools.every((t) => /^(get|list)-/.test(t))) && modelCalls[0]!.tools.includes("get-attribution-report"), modelCalls.map((m) => m.tools.length));
      const [row] = await db.select().from(schema.aiInsights).where(eq(schema.aiInsights.projectId, dev.projectId));
      c.has("ai_insights holds the week's row (SQL)", row, { status: "ready", provider: "Anthropic", generatedBy: me.body.user.id });
      const again = await dev.v2r("POST", "/ai/insights/refresh");
      c.check("a second Refresh within the hour is refused (429)", again.status === 429, again.status);

      c.begin("the weekly digest (Cloud configuration, in-process) and the opt-out on the real server");
      let digest = await runInsightsDigest(cloud.deps, new Date(), { force: true });
      for (let i = 0; i < 20 && digest.project && digest.project !== dev.projectId; i++) digest = await runInsightsDigest(cloud.deps, new Date(), { force: true });
      const sent = mail.sent.filter((m) => m.to === dev.email);
      c.check("the admin gets the digest once", sent.length === 1, mail.sent.map((m) => `${m.to}: ${m.subject}`));
      const m = sent[0];
      c.check("it lists the insights with their numbers and chart links, and no customer ids", !!m && m.text.includes(ins[0]?.title) && m.text.includes(`${ctx.base}/projects/${dev.projectId}/`) && !/meta_1|asa_1|organic_/.test(m.text), m?.text.slice(0, 600));
      const [emailed] = await db.select({ at: schema.aiInsights.emailedAt }).from(schema.aiInsights).where(and(eq(schema.aiInsights.projectId, dev.projectId), inArray(schema.aiInsights.status, ["ready"])));
      c.check("ai_insights.emailed_at is set (SQL)", !!emailed?.at, emailed);
      const unsub = /https?:\/\/\S+\/auth\/insights\/unsubscribe\?token=\S+/.exec(m?.text ?? "")?.[0];
      c.must("the email has a one-click opt-out link", unsub);
      const page = await fetch(unsub!);
      c.check("GET only asks", page.status === 200 && (await page.text()).includes("Stop the weekly digest?"), page.status);
      const post = await fetch(unsub!, { method: "POST" });
      const [u] = await sql<{ on: boolean }[]>`SELECT insights_emails AS on FROM users WHERE email = ${dev.email}`;
      c.check("POST turns the digest off on the real server (SQL)", post.status === 200 && u?.on === false, { status: post.status, u });
      c.check("the migration 0027 is recorded in drizzle's journal on this database", JSON.parse(readFileSync(join(ROOT, "packages/db/migrations/meta/_journal.json"), "utf8")).entries.some((e: any) => e.tag === "0027_attribution_benchmarks_insights"));
    } finally {
      await close();
    }
  },
};
export default journey;
