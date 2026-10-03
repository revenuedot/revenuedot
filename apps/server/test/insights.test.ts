import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { seedLedger } from "./ledger-helpers.js";
import { TEST_ENCRYPTION_KEY } from "./assistant-helpers.js";
import { defaultScript, fakeAssistantModel, type FakeScript } from "../src/services/assistant/fake-model.js";
import { inProcessClient, RevenueDotApiError } from "../src/services/assistant/client.js";
import { buildInsightPack } from "../src/services/insights/pack.js";
import { extractJson, generateInsights, INSIGHTS_MAX_OUTPUT_TOKENS, validateInsights, weekOf } from "../src/services/insights/generate.js";
import { digestOpen, digestToken, numberLine, runInsightsDigest, verifyDigestToken } from "../src/services/insights/digest.js";
import { DEFAULT_CAPS } from "../src/services/assistant/limits.js";
import { createSecretKey } from "../src/services/auth.js";

/**
 * AI growth insights (prd/attribution-benchmarks-insights §3) with the scripted fake model: the numbers pack, read tools
 * only, validation and one repair, the weekly cache, Refresh, and the digest email with its opt-out.
 */
const NOW = new Date("2026-10-05T07:00:00Z"); // a Monday, after 06:00 UTC
let script: FakeScript = defaultScript;
const model = fakeAssistantModel((ctx) => script(ctx));
type S = Awaited<ReturnType<typeof accountServer>>;
let s: S;
let ada: Awaited<ReturnType<S["signup"]>>;
let P = "";

beforeAll(async () => {
  s = await accountServer({ assistant: model, assistantRuntime: "sse", insightsDigest: true, encryptionKey: TEST_ENCRYPTION_KEY, publicUrl: "https://dash.example.com" });
  s.setNow(NOW);
  ada = await s.signup("ada@example.com");
  P = `/v2/projects/${ada.projectId}`;
  await seedLedger(s.db, {
    projectId: ada.projectId!, perMonth: 30, now: NOW, trialEvery: 3, convertEvery: 2, annualEvery: 4, refundEvery: 5,
    attribution: (i) => (i % 5 === 0 ? { $mediaSource: "Meta", $campaign: i % 10 === 0 ? "Spring" : "Summer" } : i % 7 === 0 ? { $mediaSource: "Apple Search Ads", $campaign: "Brand" } : null),
  });
}, 120_000);
afterAll(async () => { await s.close(); });

describe("the numbers pack", () => {
  it("holds the project's own numbers with ids, windows and links", async () => {
    const pack = await buildInsightPack(s.db, ada.projectId!, NOW);
    const ids = pack.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["mrr", "active_subscriptions", "revenue", "new_customers", "new_trials", "trial_conversion", "initial_conversion", "conversion_to_paying", "churn", "refund_rate", "campaign_1"]));
    expect(pack.has_revenue).toBe(true);
    for (const i of pack.items) expect(i.link.startsWith(`/projects/${ada.projectId}/`)).toBe(true);
    // The pack's revenue is the Revenue chart's total for the same 28 days.
    const rev = pack.items.find((i) => i.id === "revenue")!;
    const today = new Date(Math.floor(NOW.getTime() / 86_400_000) * 86_400_000);
    const from = new Date(today.getTime() - 28 * 86_400_000).toISOString().slice(0, 10), to = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
    const chart = await ada.browser.call("GET", `${P}/charts/revenue?resolution=day&start_date=${from}&end_date=${to}&aggregate=total`);
    expect(rev.value).toBeCloseTo(chart.body.summary.total.Revenue, 2);
    expect(pack.items.find((i) => i.id === "campaign_1")!.label).toMatch(/^Campaign "(Spring|Summer|Brand)"/);
  });
});

describe("validation", () => {
  const pack = { project: "x", computed_at: 0, currency: "USD" as const, has_revenue: true, items: ["a", "b", "c", "d"].map((id) => ({ id, label: id.toUpperCase(), unit: "$" as const, value: 1, previous: 2, change_pct: -50, window: "w", link: `/projects/p/charts/${id}` })) };
  const one = (ids: string[], t = "A title") => ({ title: t, finding: "Something changed a lot here.", recommendation: "Do one concrete thing now.", metric_ids: ids });
  it("keeps cited insights, attaches the pack's numbers and drops unknown ids", () => {
    const r = validateInsights("Sure!\n```json\n" + JSON.stringify({ insights: [one(["a", "zzz"]), one(["b"]), one(["c"]), one(["nope"]), one(["d"]), one(["a"]), one(["b"])] }) + "\n```", pack);
    expect("insights" in r && r.insights.length).toBe(5);
    if (!("insights" in r)) return;
    expect(r.insights[0]).toMatchObject({ metric_ids: ["a"], link: "/projects/p/charts/a", numbers: [{ id: "a", value: 1, previous: 2, change_pct: -50 }] });
    expect(r.insights.map((i) => i.metric_ids[0])).toEqual(["a", "b", "c", "d", "a"]);
  });
  it("keeps the text plain: markdown links become their text, emphasis marks go", () => {
    const md = { title: "**Churn** is up", finding: "See the [churn chart](/projects/p/charts/churn) for `details`.", recommendation: "Launch a [win-back campaign](https://x.example).", metric_ids: ["a"] };
    const r = validateInsights(JSON.stringify({ insights: [md, one(["b"]), one(["c"])] }), pack);
    expect("insights" in r && r.insights[0]).toMatchObject({ title: "Churn is up", finding: "See the churn chart for details.", recommendation: "Launch a win-back campaign." });
  });
  it("keeps web addresses out of the text it emails (campaign names come from app users)", () => {
    const bad = { title: "Visit https://evil.example/login now", finding: "Your account at www.evil.example is locked, see http://evil.example?x=1.", recommendation: "Do one concrete thing now.", metric_ids: ["a"] };
    const r = validateInsights(JSON.stringify({ insights: [bad, one(["b"]), one(["c"])] }), pack);
    expect("insights" in r && r.insights[0]).toMatchObject({ title: "Visit now", finding: "Your account at is locked, see" });
    expect(numberLine({ id: "campaign_1", label: 'Campaign "go to https://evil.example": revenue per new customer (3 customers)', unit: "$", value: 2, previous: 1, change_pct: 100, window: "w" }))
      .toBe('Campaign "go to ": revenue per new customer $2.00 (+100.0%)');
  });
  it("refuses fewer than 3 cited insights, no JSON, or the wrong shape", () => {
    expect(validateInsights(JSON.stringify({ insights: [one(["a"]), one(["x"])] }), pack)).toMatchObject({ error: expect.stringContaining("Only 1") });
    expect(validateInsights("no json here", pack)).toMatchObject({ error: expect.stringContaining("no JSON") });
    expect(validateInsights(JSON.stringify({ insights: [{ title: "x" }] }), pack)).toMatchObject({ error: expect.stringContaining("format") });
    expect(extractJson('text {"a": 1} more')).toEqual({ a: 1 });
  });
  it("weeks start on Monday, UTC", () => {
    expect(weekOf(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-05");
    expect(weekOf(new Date("2026-10-11T23:59:00Z"))).toBe("2026-10-05");
    expect(weekOf(new Date("2026-10-04T23:59:00Z"))).toBe("2026-09-28");
    expect(digestOpen(new Date("2026-10-05T05:59:00Z"))).toBe(false);
    expect(digestOpen(new Date("2026-10-05T06:00:00Z"))).toBe(true);
    expect(digestOpen(new Date("2026-10-08T01:00:00Z"))).toBe(true);
  });
});

describe("Overview insights and Refresh", () => {
  it("has nothing before the first run", async () => {
    const r = await ada.browser.call("GET", `${P}/ai/insights`);
    expect(r.body).toMatchObject({ object: "ai_insights", available: true, status: "none", insights: [], can_refresh: true, week: "2026-10-05", digest: { available: true, subscribed: true } });
  });

  it("writes 3 to 5 numbers-backed insights with read tools only", async () => {
    const calls0 = model.fake.calls.length;
    const r = await ada.browser.call("POST", `${P}/ai/insights/refresh`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ready", insights_week: "2026-10-05", stale: false, provider: "Fake" });
    expect(r.body.insights.length).toBeGreaterThanOrEqual(3);
    expect(r.body.insights.length).toBeLessThanOrEqual(5);
    const pack = await buildInsightPack(s.db, ada.projectId!, NOW);
    for (const i of r.body.insights) {
      expect(i.numbers.length).toBeGreaterThan(0);
      for (const n of i.numbers) expect(n.value).toBe(pack.items.find((x) => x.id === n.id)!.value);
      expect(i.link).toMatch(new RegExp(`^/projects/${ada.projectId}/`));
      expect(i.ask).toContain(i.title);
    }
    const calls = model.fake.calls.slice(calls0);
    // A tool call (get-chart), then the answer.
    expect(calls).toHaveLength(2);
    const offered = (calls[0]!.tools ?? []).map((t) => t.name);
    expect(offered).toContain("get-chart");
    expect(offered).toContain("get-benchmarks");
    expect(offered).toContain("get-attribution-report");
    // Only read tools: every offered tool is a get- or list- tool.
    expect(offered.filter((n) => !/^(get|list)-/.test(n))).toEqual([]);
    const sys = calls[0]!.prompt.find((m) => m.role === "system")!;
    expect(String(sys.content)).toContain("this week's growth insights");
  });

  it("is cached for the week and refreshes at most once an hour", async () => {
    const n = model.fake.calls.length;
    const g = await ada.browser.call("GET", `${P}/ai/insights`);
    expect(g.body.status).toBe("ready");
    expect(model.fake.calls.length).toBe(n);
    const again = await ada.browser.call("POST", `${P}/ai/insights/refresh`);
    expect(again.status).toBe(429);
    s.advance(3_600_001);
    const later = await ada.browser.call("POST", `${P}/ai/insights/refresh`);
    expect(later.status).toBe(200);
    const rows = await s.db.select().from(schema.aiInsights).where(eq(schema.aiInsights.projectId, ada.projectId!));
    expect(rows).toHaveLength(1);
    s.setNow(NOW);
  });

  it("repairs one bad answer and reports one that stays bad", async () => {
    // The first answer is empty, as when a reasoning model spends its output budget on reasoning (SuperScan, 2026-10-02).
    let n = 0;
    script = (ctx) => (++n === 1 ? { text: "" } : defaultScript(ctx));
    s.setNow(new Date("2026-10-12T07:00:00Z"));
    const calls0 = model.fake.calls.length;
    const ok = await ada.browser.call("POST", `${P}/ai/insights/refresh`);
    expect(ok.body).toMatchObject({ status: "ready", insights_week: "2026-10-12" });
    const calls = model.fake.calls.slice(calls0);
    expect(calls).toHaveLength(2);
    // Every step has room to reason and still write the answer; the repair has no tools and reasons briefly.
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([INSIGHTS_MAX_OUTPUT_TOKENS, INSIGHTS_MAX_OUTPUT_TOKENS]);
    expect(calls.map((c) => c.abortSignal)).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);
    expect(calls[0]!.providerOptions?.openai?.reasoningEffort).toBeUndefined();
    expect(calls[1]!.tools ?? []).toEqual([]);
    expect(calls[1]!.providerOptions).toMatchObject({ openai: { reasoningEffort: "low" } });
    expect(JSON.stringify(calls[1]!.prompt)).toContain("The model gave no answer.");
    script = () => ({ text: '{"insights": []}' });
    s.setNow(new Date("2026-10-19T07:00:00Z"));
    const bad = await ada.browser.call("POST", `${P}/ai/insights/refresh`);
    expect(bad.status).toBe(503);
    const g = await ada.browser.call("GET", `${P}/ai/insights`);
    // The failed week shows its error, and last week's insights stay visible.
    expect(g.body).toMatchObject({ status: "error", insights_week: "2026-10-12", stale: true });
    expect(g.body.error).toMatch(/format|Only 0/);
    script = defaultScript;
    s.setNow(NOW);
  });

  it("is refused to viewers, secret keys, and projects with RevenueDot AI off", async () => {
    const viewer = await s.signup("vera@example.com");
    await s.db.insert(schema.memberships).values({ userId: viewer.userId, projectId: ada.projectId!, role: "viewer" });
    expect((await viewer.browser.call("POST", `${P}/ai/insights/refresh`)).status).toBe(403);
    expect((await viewer.browser.call("GET", `${P}/ai/insights`)).body).toMatchObject({ can_refresh: false, available: true });
    await ada.browser.call("POST", `${P}/ai/settings`, { access: "disabled" });
    const off = await ada.browser.call("GET", `${P}/ai/insights`);
    expect(off.body).toMatchObject({ available: false, can_refresh: false });
    s.advance(3 * 3_600_000);
    expect((await ada.browser.call("POST", `${P}/ai/insights/refresh`)).status).toBe(403);
    await ada.browser.call("POST", `${P}/ai/settings`, { access: "read_write" });
    s.setNow(NOW);
  });

  it("needs the Charts permission: a secret key or custom role without it reads nothing", async () => {
    const narrow = await createSecretKey(s.db, ada.projectId!, "customers only", ["customer_information:customers:read"]);
    const charts = await createSecretKey(s.db, ada.projectId!, "charts", ["charts_metrics:charts:read"]);
    const get = (key: string) => s.app.fetch(new Request(`http://localhost${P}/ai/insights`, { headers: { authorization: `Bearer ${key}` } }));
    expect((await get(narrow.key)).status).toBe(403);
    const ok = await get(charts.key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ object: "ai_insights", can_refresh: false });
  });

  it("refuses any write from the insights actor at the API, whatever the project allows", async () => {
    const client = inProcessClient((req) => Promise.resolve(s.app.fetch(req)), { userId: ada.userId, email: "ada@example.com", projectId: ada.projectId!, conversationId: "insights:x", readOnly: true });
    await expect(client.request("GET", `${P}/apps`)).resolves.toBeTruthy();
    await expect(client.request("POST", `${P}/products`, { body: { store_identifier: "x", type: "subscription" } })).rejects.toThrow(RevenueDotApiError);
    await expect(client.request("POST", `${P}/products`, { body: { store_identifier: "x", type: "subscription" } })).rejects.toThrow(/only read/);
    // Outside a project too (creating a project): the client stays in the project, and the API refuses the write.
    await expect(client.request("POST", "/v2/projects", { body: { name: "Not by insights" } })).rejects.toThrow(/can only/);
  });
});

describe("the weekly digest", () => {
  it("emails admins with the digest on, once, without customer ids", async () => {
    const dev = await s.signup("dev@example.com");
    await s.db.insert(schema.memberships).values({ userId: dev.userId, projectId: ada.projectId!, role: "developer" });
    const grace = await s.signup("grace@example.com");
    await s.db.insert(schema.memberships).values({ userId: grace.userId, projectId: ada.projectId!, role: "admin" });
    await grace.browser.call("POST", "/auth/me", { insights_emails: false });
    // This week's row was written by Refresh and never emailed: the digest sends it.
    const sent0 = s.mail.sent.length;
    const r = await runInsightsDigest(s.app.deps, NOW);
    expect(r).toMatchObject({ emailed: 1, project: ada.projectId });
    const mails = s.mail.sent.slice(sent0);
    expect(mails.map((m) => m.to)).toEqual(["ada@example.com"]);
    const m = mails[0]!;
    expect(m.subject).toMatch(/growth ideas for the week of October 5/);
    expect(m.text).toContain("Open the chart: https://dash.example.com/projects/");
    expect(m.text).not.toMatch(/user_\d+|cus_/);
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/dash\.example\.com\/auth\/insights\/unsubscribe\?token=/);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Not again.
    expect((await runInsightsDigest(s.app.deps, new Date(NOW.getTime() + 60_000))).emailed).toBe(0);
    expect(s.mail.sent.length).toBe(sent0 + 1);
  });

  it("writes and emails the insights of projects that have revenue, from Monday 06:00 UTC", async () => {
    const tom = await s.signup("tom@example.com");
    await seedLedger(s.db, { projectId: tom.projectId!, perMonth: 20, now: NOW, trialEvery: 2, convertEvery: 1, annualEvery: 3 });
    const empty = await s.signup("empty@example.com");
    const next = new Date("2026-10-12T05:00:00Z");
    expect(await runInsightsDigest(s.app.deps, next)).toMatchObject({ generated: 0, emailed: 0, project: null });
    const open = new Date("2026-10-12T06:30:00Z");
    const done: string[] = [];
    for (let i = 0; i < 5; i++) { const r = await runInsightsDigest(s.app.deps, open); if (r.project) done.push(r.project); }
    expect(done).toContain(tom.projectId);
    expect(done).not.toContain(empty.projectId);
    const tomMail = s.mail.sent.filter((m) => m.to === "tom@example.com");
    expect(tomMail).toHaveLength(1);
    const [row] = await s.db.select().from(schema.aiInsights).where(and(eq(schema.aiInsights.projectId, tom.projectId!), eq(schema.aiInsights.week, "2026-10-12")));
    expect(row).toMatchObject({ status: "ready", generatedBy: "schedule" });
    expect(row!.emailedAt).not.toBeNull();
  });

  it("waits for tomorrow when the server's daily AI allowance is used up, without skipping the week", async () => {
    const week = new Date("2026-10-26T06:30:00Z");
    const capped = { ...s.app.deps, assistantCaps: { ...DEFAULT_CAPS, serverTokensPerDay: 0 } };
    const r = await runInsightsDigest(capped, week);
    expect(r).toMatchObject({ generated: 0, failed: 0 });
    expect(await s.db.select().from(schema.aiInsights).where(eq(schema.aiInsights.week, "2026-10-26"))).toEqual([]);
    // With the allowance back, the same project is written and emailed.
    const next = await runInsightsDigest(s.app.deps, new Date(week.getTime() + 86_400_000));
    expect(next).toMatchObject({ generated: 1, project: r.project });
  });

  it("is off where the deployment does not run it", async () => {
    expect(await runInsightsDigest({ ...s.app.deps, insightsDigest: false }, NOW)).toMatchObject({ project: null });
    expect(await runInsightsDigest({ ...s.app.deps, assistant: undefined }, NOW)).toMatchObject({ project: null });
  });

  it("turns off with the signed one-click link (GET asks, POST does it)", async () => {
    const token = (await digestToken(ada.userId, TEST_ENCRYPTION_KEY))!;
    expect(await verifyDigestToken(token, TEST_ENCRYPTION_KEY)).toBe(ada.userId);
    expect(await verifyDigestToken(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), TEST_ENCRYPTION_KEY)).toBeNull();
    expect(await verifyDigestToken(token, "another-key")).toBeNull();
    const url = `/auth/insights/unsubscribe?token=${encodeURIComponent(token)}`;
    const page = await s.app.fetch(new Request(`http://localhost${url}`));
    expect(await page.text()).toContain("Stop the weekly digest?");
    expect((await s.db.select({ on: schema.users.insightsEmails }).from(schema.users).where(eq(schema.users.id, ada.userId)))[0]!.on).toBe(true);
    const post = await s.app.fetch(new Request(`http://localhost${url}`, { method: "POST" }));
    expect(post.status).toBe(200);
    expect((await s.db.select({ on: schema.users.insightsEmails }).from(schema.users).where(eq(schema.users.id, ada.userId)))[0]!.on).toBe(false);
    const bad = await s.app.fetch(new Request("http://localhost/auth/insights/unsubscribe?token=nope.nope", { method: "POST" }));
    expect(bad.status).toBe(404);
    const me = await ada.browser.call("POST", "/auth/me", { insights_emails: true });
    expect(me.body.user.insights_emails).toBe(true);
  });

  it("formats the numbers line", () => {
    expect(numberLine({ id: "mrr", label: "MRR", unit: "$", value: 4210.5, previous: 4586, change_pct: -8.19, window: "w" })).toBe("MRR $4,211 (−8.2%)");
    expect(numberLine({ id: "t", label: "Trial conversion", unit: "%", value: 41.25, previous: null, change_pct: null, window: "w" })).toBe("Trial conversion 41.3%");
  });
});

describe("generateInsights directly", () => {
  it("needs a model and an admin", async () => {
    await expect(generateInsights({ ...s.app.deps, assistant: undefined }, ada.projectId!, { by: "schedule", now: NOW })).rejects.toThrow(/No model/);
  });
});
