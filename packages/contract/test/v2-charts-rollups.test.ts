import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CHARTS, ROLLUP_CHARTS, runChart, type ChartRequest } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { chartFromRollups, refreshRollups, runRollupJob } from "@revenuedot/server/services/charts/rollups.js";
import { loadChartInput } from "@revenuedot/server/services/charts/load.js";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import type { VerifiedPurchase } from "@revenuedot/server/stores/types.js";
import { harness, type Harness } from "../src/harness.js";
import { seedChartsHistory, NOW } from "./charts-fixture.js";

/**
 * Daily chart rollups (prd/charts/PRD.md "Daily rollups") on the chart history of charts-fixture.ts. Each build is a
 * new generation computed from scratch as of one moment; a realtime=false request is answered from the newest complete
 * generation, and that answer equals the live computation at the generation's build time, for every rollup chart, both
 * environments, after the first build and after refunds, imports, merges, transfers, deletions, late ad events, a
 * multi-run build and midnight.
 */
let h: Harness;
const DAY = 86_400_000;
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY) * DAY;
beforeAll(async () => { h = await harness(); await seedChartsHistory(h); h.setNow(NOW); });
afterAll(async () => { await h.close(); });

const get = async (chart: string, query: string, realtime: boolean) => {
  const res = await h.fetch(`/v2/projects/${h.ids.project}/charts/${chart}?${query}&realtime=${realtime}`, { key: h.ids.secretKey });
  return { status: res.status, source: res.headers.get("x-revenuedot-chart-source"), body: await res.json() as any };
};
const today = () => new Date(h.now().getTime()).toISOString().slice(0, 10);
const PROD = () => `resolution=2&start_date=2026-05-01&end_date=${today()}`;
const SANDBOX = () => `${PROD()}&environment=sandbox`;
const state = async (sandbox = false) => (await h.db.select().from(schema.chartRollupState).where(and(eq(schema.chartRollupState.projectId, h.ids.project), eq(schema.chartRollupState.isSandbox, sandbox))))[0];
/** The dashboard opens a chart (realtime=false) in each environment, which keeps them built; then the job runs. */
const job = async () => {
  for (const q of [PROD(), SANDBOX()]) await get("revenue", q, false);
  return runRollupJob({ db: h.db }, h.now(), { budgetMs: 600_000 });
};
const AD = ["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load", "rc_ads_ad_revenue"];
const reqs = (end: number) => [
  { resolution: "month", rangeStart: Date.parse("2026-05-01"), rangeEnd: end, expand: false, selectors: {} },
  { resolution: "day", rangeStart: Date.parse("2026-07-20"), rangeEnd: end, expand: false, selectors: {} },
  { resolution: "week", rangeStart: Date.parse("2026-06-01"), rangeEnd: end, expand: true, selectors: {}, weekStart: 0 },
  { resolution: "quarter", rangeStart: Date.parse("2025-10-01"), rangeEnd: Date.parse("2026-08-16"), expand: false, selectors: {} },
] as ChartRequest[];

/**
 * Every rollup chart (and each selector value) for several ranges, in both environments: the served generation equals
 * the live computation at its build time. In process, so it stays fast on a real Postgres server.
 */
async function expectSameAsLive() {
  let compared = 0;
  for (const sandbox of [false, true]) {
    const st = await state(sandbox);
    expect(st?.computedAt, "a complete generation").toBeTruthy();
    const asOf = st!.computedAt!;
    const input = await loadChartInput(h.db, { projectId: h.ids.project, sandbox, now: asOf, asOf, currency: "USD", fetch: null, sources: { sdkTypes: AD, activity: null, refundRequests: false } });
    for (const name of ROLLUP_CHARTS) {
      const def = CHARTS.find((c) => c.name === name)!;
      const sels = def.selectors.length ? def.selectors[0]!.options.map((o) => ({ [def.selectors[0]!.id]: o.id })) : [{}];
      for (const r of reqs(dayOf(h.now()) + DAY)) for (const sel of sels) {
        const req = { ...r, selectors: sel };
        const what = `${sandbox ? "sandbox" : "production"} ${name} ${JSON.stringify(sel)} ${r.resolution}`;
        const rolled = await chartFromRollups(h.db, { projectId: h.ids.project, sandbox, def, req, now: h.now(), currency: "USD", filtered: false, segmented: false });
        expect(rolled, `${what}: answered live`).not.toBeNull();
        const live = runChart(def, input, req).output;
        const a = live.kind === "series" ? live.points : [], b = rolled!.output.kind === "series" ? rolled!.output.points : [];
        expect(b.length, what).toBe(a.length);
        a.forEach((p, k) => {
          const q = b[k]!;
          expect([q.start, q.incomplete], what).toEqual([p.start, p.incomplete]);
          p.values.forEach((v, m) => {
            const w = q.values[m];
            if (v === null || w === null || w === undefined) expect(w, `${what} ${new Date(p.start).toISOString()} #${m}`).toBe(v);
            else expect(w, `${what} ${new Date(p.start).toISOString()} #${m}`).toBeCloseTo(v, 6);
          });
        });
        compared++;
      }
    }
  }
  return compared;
}
/** Advances past the rebuild interval, lets the job build, and checks the new generation. */
const rebuildAndCompare = async () => {
  h.setNow(new Date(h.now().getTime() + 16 * 60_000));
  const r = await job();
  expect(r.builds, "both environments rebuilt").toBe(2);
  expect(await expectSameAsLive()).toBeGreaterThan(200);
};

// On a real Postgres server every query crosses the network.
describe("daily rollups", { timeout: 1_800_000 }, () => {
  it("are kept only for charts people look at, and answer live until built", async () => {
    expect((await runRollupJob({ db: h.db }, h.now())).builds).toBe(0);
    // realtime=true (RevenueCat's default) is always live and does not ask for rollups.
    expect((await get("revenue", PROD(), true)).source).toBe("live");
    expect(await state()).toBeUndefined();
    expect((await get("revenue", PROD(), false)).source).toBe("live");
    expect((await state())?.viewedAt).toBeTruthy();
  });

  it("build a generation, then answer every rollup chart exactly as the live computation, also through the API", async () => {
    const r = await job();
    expect(r).toMatchObject({ builds: 2, pending: 0 });
    expect(await state()).toMatchObject({ generation: 1, buildGeneration: null });
    // Through the API, right after the build: realtime=false from the rollups equals realtime=true.
    for (const q of [PROD(), SANDBOX()]) for (const name of ROLLUP_CHARTS) {
      const rolled = await get(name, q, false), live = await get(name, q, true);
      expect(rolled.source, `${name} ${q}`).toBe("rollups");
      expect({ ...rolled.body, last_computed_at: 0 }, `${name} ${q}`).toEqual({ ...live.body, last_computed_at: 0 });
    }
    expect(await expectSameAsLive()).toBeGreaterThan(200);
  });

  it("rebuild at most every 15 minutes, one run at a time", async () => {
    for (let k = 0; k < 5; k++) { h.setNow(new Date(h.now().getTime() + 2 * 60_000)); expect((await job()).builds).toBe(0); }
    await h.db.update(schema.chartRollupState).set({ leaseToken: "other", leaseUntil: new Date(Date.now() + 60_000) });
    expect(await refreshRollups(h.db, h.ids.project, false, h.now(), Date.now() + 60_000, { force: true })).toMatchObject({ busy: true });
    await h.db.update(schema.chartRollupState).set({ leaseToken: null, leaseUntil: null });
    await rebuildAndCompare();
    expect(await state()).toMatchObject({ generation: 2 });
    // The replaced generation stays until the next build starts; older ones are gone.
    const gens = await h.db.selectDistinct({ g: schema.chartRollups.generation }).from(schema.chartRollups).where(and(eq(schema.chartRollups.projectId, h.ids.project), eq(schema.chartRollups.isSandbox, false)));
    expect(gens.map((g) => g.g).sort()).toEqual([1, 2]);
  });

  it("rebuild only after someone looked at the charts since the last build", async () => {
    h.setNow(new Date(h.now().getTime() + 16 * 60_000));
    expect((await runRollupJob({ db: h.db }, h.now())).builds).toBe(0);
    await get("revenue", PROD(), false);
    expect((await runRollupJob({ db: h.db }, h.now())).builds).toBe(1);
  });

  it("a paused build of new code leaves the served generation and its version alone", async () => {
    // The served generation was built by other code: answered live.
    await h.db.update(schema.chartRollupState).set({ version: "older-code" }).where(eq(schema.chartRollupState.isSandbox, false));
    expect((await get("mrr", PROD(), false)).source).toBe("live");
    // A build of this code pauses after its first slice: still the old generation's version, so still live.
    await getOrCreateCustomer(h.db, h.ids.project, "old_timer", new Date("2023-09-01T00:00:00Z"));
    const r = await refreshRollups(h.db, h.ids.project, false, h.now(), 0, { force: true });
    expect(r.done).toBe(false);
    expect(await state()).toMatchObject({ version: "older-code" });
    expect((await get("mrr", PROD(), false)).source).toBe("live");
    while (!(await refreshRollups(h.db, h.ids.project, false, h.now(), 0)).done) { /* next slice */ }
    expect((await get("mrr", PROD(), false)).source).toBe("rollups");
  });

  it("keep the replaced generation until the next build starts, so a read during the switch finds its days", async () => {
    const before = (await state())!.generation!;
    await refreshRollups(h.db, h.ids.project, false, h.now(), Date.now() + 600_000, { force: true });
    expect((await state())!.generation).toBe(before + 1);
    // A reader that read the state just before the switch still finds the replaced generation's days.
    const old = await h.db.select({ d: schema.chartRollups.dayMs }).from(schema.chartRollups)
      .where(and(eq(schema.chartRollups.projectId, h.ids.project), eq(schema.chartRollups.isSandbox, false), eq(schema.chartRollups.generation, before)));
    expect(old.length).toBeGreaterThan(10);
    await refreshRollups(h.db, h.ids.project, false, h.now(), Date.now() + 600_000, { force: true });
    const gens = await h.db.selectDistinct({ g: schema.chartRollups.generation }).from(schema.chartRollups).where(and(eq(schema.chartRollups.projectId, h.ids.project), eq(schema.chartRollups.isSandbox, false)));
    expect(gens.map((g) => g.g).sort()).toEqual([before + 1, before + 2]);
  });

  it("a build over several runs reads only rows recorded by its start", async () => {
    h.setNow(new Date(h.now().getTime() + 16 * 60_000));
    expect((await refreshRollups(h.db, h.ids.project, false, h.now(), 0, { force: true })).done).toBe(false);
    // A refund recorded after the build started, for a purchase made before it.
    const [ua] = await h.db.select().from(schema.transactions).where(and(eq(schema.transactions.projectId, h.ids.project), eq(schema.transactions.storeTransactionId, "u_a_key_3")));
    await h.db.insert(schema.transactions).values({ ...ua!, id: "txn_refund_late", kind: "refund", purchasedAt: new Date(h.now().getTime() - 60_000), revenueUsd: -10, createdAt: new Date(Date.now() + 60_000) });
    while (!(await refreshRollups(h.db, h.ids.project, false, h.now(), 0)).done) { /* next slice */ }
    await refreshRollups(h.db, h.ids.project, true, h.now(), Date.now() + 600_000, { force: true });
    expect(await expectSameAsLive()).toBeGreaterThan(200);
  });

  it("compute live for realtime, filters, segments, other currencies, the charts they do not keep and old builds", async () => {
    const q = PROD();
    expect((await get("revenue", `${q}&filters=${encodeURIComponent('[{"name":"store","values":["app_store"]}]')}`, false)).source).toBe("live");
    expect((await get("revenue", `${q}&segment=country`, false)).source).toBe("live");
    expect((await get("revenue", `${q}&currency=EUR`, false)).source).toBe("live");
    expect((await get("trial_conversion_rate", q, false)).source).toBe("live");
    expect((await get("revenue", q, true)).source).toBe("live");
    h.setNow(new Date(h.now().getTime() + 21 * 60_000));
    expect((await get("mrr", q, false)).source).toBe("live");
  });

  it("stay equal after a purchase, a refund, an import with past dates, a merge, a transfer, a deletion and a late ad event", async () => {
    const steps: [string, () => Promise<unknown>][] = [
      ["purchase", async () => {
        const { customer } = await getOrCreateCustomer(h.db, h.ids.project, "u_new", h.now());
        const p = { kind: "subscription", store: "app_store", storeKey: "u_new_key", productIdentifier: "pro_monthly", isSandbox: false, purchaseDate: h.now(), originalPurchaseDate: h.now(),
          expiresDate: new Date(h.now().getTime() + 30 * DAY), periodType: "normal", storeTransactionId: "u_new_1", originalTransactionId: "u_new_key", price: { amount: 10, currency: "USD" }, countryCode: "US" } as unknown as VerifiedPurchase;
        await applyPurchases(h.db, customer, [p], { projectId: h.ids.project, appId: "app_ios", appUserId: "u_new", now: h.now(), fromDevice: false });
      }],
      ["refund", async () => {
        const [ua] = await h.db.select().from(schema.transactions).where(and(eq(schema.transactions.projectId, h.ids.project), eq(schema.transactions.storeTransactionId, "u_a_key_2")));
        await h.db.insert(schema.transactions).values({ ...ua!, id: "txn_refund_ua", kind: "refund", purchasedAt: h.now(), revenueUsd: -10 });
      }],
      ["import", async () => {
        const res = await h.fetch(`/v2/projects/${h.ids.project}/import/customers`, { method: "POST", key: h.ids.secretKey, json: { resolve_store_ids: false, customers: [{
          id: "imported_1", first_seen_at: Date.parse("2026-04-02T00:00:00Z"),
          subscriptions: [{ store: "app_store", product_identifier: "pro_monthly", starts_at: Date.parse("2026-04-02T00:00:00Z"), current_period_starts_at: Date.parse("2026-05-02T00:00:00Z"), current_period_ends_at: Date.parse("2026-06-02T00:00:00Z"),
            status: "expired", store_subscription_identifier: "imp_2", original_transaction_id: "imp_1",
            transactions: [{ id: "imp_1", purchased_at: Date.parse("2026-04-02T00:00:00Z"), expires_at: Date.parse("2026-05-02T00:00:00Z"), revenue_usd: 8 }, { id: "imp_2", purchased_at: Date.parse("2026-05-02T00:00:00Z"), expires_at: Date.parse("2026-06-02T00:00:00Z"), revenue_usd: 8 }] }],
        }] } });
        expect(res.status).toBe(200);
      }],
      ["merge", async () => {
        const { customer } = await getOrCreateCustomer(h.db, h.ids.project, "$RCAnonymousID:merge1", new Date("2026-06-20T00:00:00Z"));
        await applyPurchases(h.db, customer, [{ kind: "non_subscription", store: "app_store", productIdentifier: "coins", storeTransactionId: "merge_coins", isSandbox: false, isConsumable: true, purchaseDate: new Date("2026-06-21T00:00:00Z"), price: { amount: 3, currency: "USD" }, countryCode: "US" }],
          { projectId: h.ids.project, appId: "app_ios", appUserId: "$RCAnonymousID:merge1", now: h.now(), fromDevice: false });
        const res = await h.fetch("/v1/subscribers/identify", { method: "POST", key: h.ids.iosKey, json: { app_user_id: "$RCAnonymousID:merge1", new_app_user_id: "u_c" } });
        expect(res.ok).toBe(true);
        expect(await h.db.select().from(schema.customers).where(eq(schema.customers.id, customer.id))).toHaveLength(0);
      }],
      ["transfer", async () => {
        const res = await h.fetch(`/v2/projects/${h.ids.project}/customers/u_e/actions/transfer`, { method: "POST", key: h.ids.secretKey, json: { target_customer_id: "u_transfer" } });
        expect(res.status).toBe(200);
      }],
      ["deletion", async () => {
        const res = await h.fetch(`/v2/projects/${h.ids.project}/customers/u_d`, { method: "DELETE", key: h.ids.secretKey });
        expect(res.status).toBe(200);
      }],
      ["late ad event", async () => {
        const res = await h.fetch("/v1/events", { method: "POST", key: h.ids.iosKey, json: { events: [{ id: crypto.randomUUID(), type: "rc_ads_ad_revenue", app_user_id: "u_a", timestamp: Date.parse("2026-07-03T10:00:00Z"), revenue_micros: 2_500_000, currency: "USD", precision: "exact" }] } });
        expect(res.status).toBe(200);
      }],
    ];
    for (const [what, step] of steps) {
      await step();
      try { await rebuildAndCompare(); } catch (e) { throw new Error(`after the ${what}: ${(e as Error).message}`); }
    }
  });

  it("keep the served generation while a new one is built over several runs, then flip to it", async () => {
    // A customer first seen three years ago adds days; every run stops after one slice.
    await getOrCreateCustomer(h.db, h.ids.project, "old_timer", new Date("2023-09-01T00:00:00Z"));
    h.setNow(new Date(h.now().getTime() + 16 * 60_000));
    await get("revenue", PROD(), false);
    const before = (await state())!.generation;
    let runs = 0, done = false;
    while (!done && runs < 100) {
      runs++;
      done = (await refreshRollups(h.db, h.ids.project, false, h.now(), 0)).done;
      if (!done) {
        // Still serving the previous generation.
        expect((await state())!.generation).toBe(before);
        expect((await get("revenue", PROD(), false)).source).toBe("rollups");
      }
    }
    expect(done).toBe(true);
    expect(runs).toBeGreaterThan(1);
    expect(await state()).toMatchObject({ generation: before! + 1, buildGeneration: null, buildFromMs: null });
    await refreshRollups(h.db, h.ids.project, true, h.now(), Date.now() + 600_000, { force: true });
    expect(await expectSameAsLive()).toBeGreaterThan(200);
  });

  it("around midnight: answer live until the day's first build, then equal again", async () => {
    h.setNow(new Date("2026-09-01T23:50:00Z"));
    await job();
    expect((await get("mrr", PROD(), false)).source).toBe("rollups");
    h.setNow(new Date("2026-09-02T00:05:00Z"));
    // Built yesterday: today is not in it.
    expect((await get("mrr", PROD(), false)).source).toBe("live");
    await job();
    expect(await expectSameAsLive()).toBeGreaterThan(200);
  });

  it("are deleted for projects nobody looked at for a week", async () => {
    h.setNow(new Date(h.now().getTime() + 8 * DAY));
    const r = await runRollupJob({ db: h.db }, h.now());
    expect(r.forgotten).toBe(2);
    expect(await state()).toBeUndefined();
    expect(await h.db.select().from(schema.chartRollups).where(eq(schema.chartRollups.projectId, h.ids.project))).toHaveLength(0);
  });
});
