import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { seedLedger } from "./ledger-helpers.js";
import { computeProjectBenchmarks, runBenchmarkJob, START_HOUR } from "../src/services/benchmarks.js";
import { runScheduledJobs } from "../src/services/scheduled.js";

/**
 * Benchmarks (prd/attribution-benchmarks-insights §2) on 13 projects in one database: 11 share (8 Health & Fitness,
 * 3 Travel), 1 shares nothing, 1 is ours to look from (Health & Fitness, sharing). Default k = 10, smaller minimum samples.
 */
const NOW = new Date("2026-10-02T03:00:00Z");
type S = Awaited<ReturnType<typeof accountServer>>;
let s: S;
let ada: Awaited<ReturnType<S["signup"]>>;
const minSample = { initial_conversion: 30, trial_conversion: 5, conversion_to_paying: 30, churn: 5, refund_rate: 10, ltv_per_customer: 30, ltv_per_paying_customer: 5, arpu: 30, price_monthly: 5, price_annual: 5 };
const projects: string[] = [];

beforeAll(async () => {
  s = await accountServer({ benchmarks: true, benchmarkOptions: { minSample } });
  s.setNow(NOW);
  // The account server's clock moves with s.setNow; the nightly test sets its own time.
  ada = await s.signup("ada@example.com");
  await seedLedger(s.db, { projectId: ada.projectId!, perMonth: 10, now: NOW, trialEvery: 3, convertEvery: 2, annualEvery: 4, refundEvery: 5, platform: (i) => (i % 2 ? "iOS" : "Android") });
  // Twelve other projects with different conversion and prices, each through its own account.
  for (let n = 0; n < 12; n++) {
    const u = await s.signup(`owner${n}@example.com`);
    projects.push(u.projectId!);
    await seedLedger(s.db, { projectId: u.projectId!, perMonth: 8 + n, now: NOW, trialEvery: 2 + (n % 3), convertEvery: 1 + (n % 2), monthlyPrice: 8 + n, annualEvery: 3, annualPrice: 40 + 5 * n, refundEvery: 4 });
    const share = n < 11;
    if (share) await u.browser.call("POST", `/v2/projects/${u.projectId}/benchmarks/settings`, { share: true, category: n < 8 ? "health_fitness" : "travel" });
  }
  await s.settle();
}, 120_000);
afterAll(async () => { await s.close(); });

const P = () => `/v2/projects/${ada.projectId}`;

describe("sharing settings", () => {
  it("is off by default and needs a category", async () => {
    const g = await ada.browser.call("GET", `${P()}/benchmarks/settings`);
    expect(g.body).toMatchObject({ available: true, share: false, category: null });
    const bad = await ada.browser.call("POST", `${P()}/benchmarks/settings`, { share: true });
    expect(bad.status).toBe(400);
    const wrong = await ada.browser.call("POST", `${P()}/benchmarks/settings`, { share: true, category: "crypto" });
    expect(wrong.status).toBe(400);
  });

  it("shows nothing about peers to a project that does not share", async () => {
    const r = await ada.browser.call("GET", `${P()}/benchmarks`);
    expect(r.body).toMatchObject({ available: true, settings: { share: false }, metrics: [], peer_group: null });
  });

  it("lets only admins change it, and audits the change", async () => {
    const viewer = await s.signup("viewer@example.com");
    await s.db.insert(schema.memberships).values({ userId: viewer.userId, projectId: ada.projectId!, role: "viewer" });
    const v = await viewer.browser.call("POST", `${P()}/benchmarks/settings`, { share: true, category: "health_fitness" });
    expect(v.status).toBe(403);
    const ok = await ada.browser.call("POST", `${P()}/benchmarks/settings`, { share: true, category: "health_fitness" });
    expect(ok.body).toMatchObject({ share: true, category: "health_fitness" });
    await s.settle();
    const audit = await ada.browser.call("GET", `${P()}/audit_logs`);
    expect(audit.body.items.map((x: any) => x.action_type)).toContain("benchmarks_settings_updated");
  });
});

describe("the nightly job", () => {
  // Turning sharing on computed each project's own values right away (today); the night after recomputes them all.
  const NIGHT = new Date("2026-10-03T03:00:00Z");
  it("waits until 02:00 UTC, then computes every sharing project and builds the groups", async () => {
    expect(await runBenchmarkJob({ db: s.db, benchmarks: true }, new Date("2026-10-03T01:59:00Z"), { minSample })).toEqual({ computed: 0, aggregated: false, groups: 0 });
    expect(await runBenchmarkJob({ db: s.db, benchmarks: false }, NIGHT, { minSample })).toEqual({ computed: 0, aggregated: false, groups: 0 });
    // A tight budget: one project per call until all are done.
    let calls = 0, computed = 0, done = false;
    while (!done && calls < 30) {
      const r = await runBenchmarkJob({ db: s.db, benchmarks: true }, NIGHT, { minSample, budgetMs: 0 });
      computed += r.computed; done = r.aggregated; calls++;
    }
    expect(done).toBe(true);
    expect(computed).toBe(12); // 11 others + Ada's project
    const values = await s.db.select({ p: schema.benchmarkProjectValues.projectId }).from(schema.benchmarkProjectValues);
    expect(new Set(values.map((v) => v.p)).size).toBe(12);
    expect(values.some((v) => v.p === projects[11])).toBe(false); // the one that does not share
    // A second call today does nothing.
    expect(await runBenchmarkJob({ db: s.db, benchmarks: true }, new Date(NIGHT.getTime() + 60_000), { minSample })).toEqual({ computed: 0, aggregated: false, groups: 0 });
    const [run] = await s.db.select().from(schema.benchmarkRuns);
    expect(run).toMatchObject({ day: "2026-10-03", projects: 12 });
    expect(START_HOUR).toBe(2);
  });

  it("publishes no project ids and no group under 10 projects", async () => {
    const groups = await s.db.select().from(schema.benchmarkAggregates);
    expect(groups.length).toBeGreaterThan(0);
    expect(Object.keys(groups[0]!)).not.toContain("projectId");
    for (const g of groups) expect(g.projects).toBeGreaterThanOrEqual(10);
    // 9 Health & Fitness projects (8 + Ada) and 3 Travel: below 10 each, so only "all categories" is published.
    expect(new Set(groups.map((g) => g.category))).toEqual(new Set(["all"]));
    const all = groups.find((g) => g.category === "all" && g.platform === "all" && g.country === "all" && g.metric === "price_monthly")!;
    expect(all.projects).toBe(10); // 12 projects, rounded down to a multiple of 5
    expect(all.p10).toBeNull(); // deciles need 20
  });

  it("compares the project with all categories when its own has too few apps", async () => {
    const own = await ada.browser.call("GET", `${P()}/benchmarks`);
    expect(own.body.peer_group).toMatchObject({ category: "health_fitness", platform: "all", country: "all", projects: null });
    expect(own.body.metrics.every((m: any) => m.peers === null)).toBe(true);
    const all = await ada.browser.call("GET", `${P()}/benchmarks?category=all`);
    expect(all.body.peer_group).toMatchObject({ category: "all", projects: 10 });
    const monthly = all.body.metrics.find((m: any) => m.metric === "price_monthly");
    expect(monthly.value).toBe(10);
    expect(monthly.peers).toMatchObject({ projects: 10, p10: null, p90: null });
    expect(monthly.peers.p25).toBeLessThanOrEqual(monthly.peers.p50);
    expect(typeof monthly.percentile).toBe("number");
    expect(monthly.standing).toBeTruthy();
    const ios = await ada.browser.call("GET", `${P()}/benchmarks?category=all&platform=ios`);
    expect(ios.body.peer_group.platform).toBe("ios");
    // Ada's own iOS slice: half her customers.
    const adaAll = all.body.metrics.find((m: any) => m.metric === "initial_conversion").sample;
    expect(ios.body.metrics.find((m: any) => m.metric === "initial_conversion").sample).toBe(adaAll / 2);
  });

  it("never shows a stored group under k", async () => {
    await s.db.insert(schema.benchmarkAggregates).values({ category: "travel", platform: "all", country: "all", metric: "churn", projects: 5, p25: 1, p50: 2, p75: 3, computedOn: "2026-10-02" });
    const r = await ada.browser.call("GET", `${P()}/benchmarks?category=travel`);
    expect(r.body.metrics.find((m: any) => m.metric === "churn").peers).toBeNull();
    await s.db.delete(schema.benchmarkAggregates).where(eq(schema.benchmarkAggregates.category, "travel"));
  });

  it("removes a project at once when it stops sharing", async () => {
    const owner = await s.client();
    await owner.call("POST", "/auth/login", { email: "owner0@example.com", password: "correct horse battery" });
    const before = await s.db.select().from(schema.benchmarkAggregates).where(eq(schema.benchmarkAggregates.metric, "price_monthly"));
    const off = await owner.call("POST", `/v2/projects/${projects[0]}/benchmarks/settings`, { share: false, category: "health_fitness" });
    expect(off.body).toMatchObject({ share: false });
    expect(await s.db.select().from(schema.benchmarkProjectValues).where(eq(schema.benchmarkProjectValues.projectId, projects[0]!))).toHaveLength(0);
    // 11 projects left: still a group of 10+, rebuilt without it.
    const after = await s.db.select().from(schema.benchmarkAggregates).where(eq(schema.benchmarkAggregates.metric, "price_monthly"));
    expect(after.find((g) => g.category === "all" && g.platform === "all")!.p25).not.toBe(before.find((g) => g.category === "all" && g.platform === "all")!.p25);
    const peers = await owner.call("GET", `/v2/projects/${projects[0]}/benchmarks?category=all`);
    expect(peers.body.metrics).toEqual([]);
  });

  it("keeps no values from a computation that ends after the project stopped sharing", async () => {
    // Project 0 stopped sharing above; its opt-in computation (or a nightly one) finishing now stores nothing.
    expect(await computeProjectBenchmarks(s.db, projects[0]!, "health_fitness", new Date("2026-10-03T04:00:00Z"), { minSample })).toBe(0);
    expect(await s.db.select().from(schema.benchmarkProjectValues).where(eq(schema.benchmarkProjectValues.projectId, projects[0]!))).toHaveLength(0);
  });

  it("runs from the scheduled jobs only where benchmarks are on", async () => {
    const r = await runScheduledJobs({ ...s.deps, benchmarks: false }, new Date("2026-10-03T03:00:00Z"));
    expect(r.benchmarks).toBeUndefined();
  });
});

describe("self-hosted servers", () => {
  it("answer available: false and refuse to share", async () => {
    const self = await accountServer({});
    const u = await self.signup("lena@example.com");
    const g = await u.browser.call("GET", `/v2/projects/${u.projectId}/benchmarks`);
    expect(g.body).toEqual({ object: "benchmarks", available: false, reason: expect.stringContaining("Cloud") });
    const p = await u.browser.call("POST", `/v2/projects/${u.projectId}/benchmarks/settings`, { share: true, category: "travel" });
    expect(p.status).toBe(404);
    const me = await u.browser.call("GET", "/auth/me");
    expect(me.body.account.features).toEqual({ benchmarks: false, insights_digest: false });
    await self.close();
  });
});
