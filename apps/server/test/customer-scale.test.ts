import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, defaultStores } from "../src/index.js";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { countAll, exactCount, runCountJobs } from "../src/services/customer-counts.js";
import { expected, hasEmail, isDE, kindOf, seedMany } from "./many-customers.js";

/**
 * Lists, previews and policy counts over a project larger than the old 10,000-customer scan (prd/lifecycle/PRD.md
 * "Scale"): exact counts, every page reachable, customers beyond the 10,000 most recently seen found, and the background
 * count for projects above the in-request limit.
 */
const N = 12_000;
const NOW = new Date("2026-09-01T12:00:00Z");
let h: Harness;
beforeAll(async () => {
  // Counted in the request here; the last describe block runs the background count with a lower limit.
  h = await harness({ countInlineLimit: 50_000 });
  h.setNow(NOW);
  await seedMany(h.db, "proj1", N, NOW);
}, 120_000);
afterAll(async () => { await h.close(); });

const get = async (path: string, init: Parameters<Harness["fetch"]>[1] = {}) => {
  const res = await h.fetch(path, { key: h.ids.secretKey, ...init });
  return { status: res.status, body: await res.json() as any };
};
const list = (q: string) => get(`/v2/projects/proj1/customer_lists?${q}`);
const enc = (r: unknown) => encodeURIComponent(JSON.stringify(r));
const DE_WITH_EMAIL = { groups: [{ conditions: [{ field: "country", operator: "is", value: "DE" }, { field: "email", operator: "isNotEmpty" }] }] };

describe("customer lists at scale", () => {
  it("counts every customer exactly and reaches the ones beyond the 10,000 most recently seen", async () => {
    const all = await list("list=all&limit=5");
    const e = expected(N);
    expect(all.body.summary).toMatchObject({ customers: N, trialing_subscribers: e.trialing, paid_subscribers: e.paid, total_revenue_in_usd: e.revenue, is_approximate: false, is_counting: false });
    // The least recently seen customers come first in ascending order: the old scan never looked at them.
    const oldest = await list("list=all&limit=3&sort=last_seen_at&direction=asc");
    expect(oldest.body.items.map((r: any) => r.id)).toEqual([`user${N}`, expect.stringMatching(/^\$RCAnonymousID:/), `user${N - 2}`]);
    expect((await list(`list=all&search=user${N - 2}%40`)).body.items.map((r: any) => r.id)).toEqual([`user${N - 2}`]);
    for (const [name, pick] of [["active", (k: number) => [0, 2, 5].includes(kindOf(k))], ["expired", (k: number) => kindOf(k) === 1], ["sandbox", (k: number) => kindOf(k) === 3], ["non_subscription", (k: number) => k % 10 === 0]] as const) {
      const x = expected(N, pick);
      expect((await list(`list=${name}&limit=1`)).body.summary, name).toMatchObject({ customers: x.customers, trialing_subscribers: x.trialing, paid_subscribers: x.paid, total_revenue_in_usd: x.revenue });
    }
  });

  it("built-in lists in SQL count the same customers as the JavaScript conditions", async () => {
    // A condition every customer meets moves the cards to the page-by-page count, which re-checks each built-in list in JavaScript.
    const everyone = { groups: [{ conditions: [{ field: "status", operator: "isNotEmpty" }] }] };
    for (const name of ["all", "active", "expired", "sandbox", "non_subscription"]) {
      const sqlCards = (await list(`list=${name}&limit=1`)).body.summary;
      const jsCards = (await list(`list=${name}&limit=1&rules=${enc(everyone)}`)).body.summary;
      expect({ ...jsCards, counted_at: 0 }, name).toEqual({ ...sqlCards, counted_at: 0 });
    }
  }, 120_000);

  it("pages through a condition-filtered list to its last customer", async () => {
    const pick = (k: number) => isDE(k) && hasEmail(k);
    const want: string[] = [];
    for (let k = 1; k <= N; k++) if (pick(k)) want.push(k % 13 === 0 ? "" : `user${k}`);
    const seen: string[] = [];
    let q = `list=all&limit=100&rules=${enc(DE_WITH_EMAIL)}`;
    let first: any = null;
    for (;;) {
      const p = await list(q);
      first ??= p.body.summary;
      seen.push(...p.body.items.map((r: any) => (r.id.startsWith("$RCAnonymousID:") ? "" : r.id)));
      if (!p.body.next_page) break;
      q = `list=all&limit=100&rules=${enc(DE_WITH_EMAIL)}&starting_after=${new URL(p.body.next_page, "http://x").searchParams.get("starting_after")}`;
    }
    expect(seen).toEqual(want);
    expect(first).toMatchObject({ customers: want.length, total_revenue_in_usd: expected(N, pick).revenue, is_counting: false });
  }, 120_000);

  it("finds a rare audience member among the least recently seen customers", async () => {
    const only = { groups: [{ conditions: [{ field: "customerId", operator: "is", value: `user${N}` }] }] };
    const p = await list(`list=all&limit=20&rules=${enc(only)}`);
    expect(p.body.items.map((r: any) => r.id)).toEqual([`user${N}`]);
    expect(p.body.next_page).toBeNull();
    expect(p.body.summary.customers).toBe(1);
  });

  it("exports every row", async () => {
    const res = await h.fetch("/v2/projects/proj1/customer_lists/export?list=expired", { key: h.ids.secretKey });
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines.length - 1).toBe(expected(N, (k) => kindOf(k) === 1).customers);
  });
});

describe("previews and policy counts at scale", () => {
  it("audience previews count the whole project", async () => {
    const e = expected(N, (k) => isDE(k) && hasEmail(k));
    const pv = await get("/v2/projects/proj1/audiences/actions/preview", { method: "POST", json: { rules: DE_WITH_EMAIL } });
    expect(pv.body.stats).toEqual({ total_customers: e.customers, active_subscriptions: e.active, active_trials: e.trials, total_revenue: e.revenue, currency: "USD", is_approximate: false });
    expect(pv.body.customer_sample.map((m: any) => m.app_user_id)).toEqual(["user4", "user8", "user12", "user16", "user24", "user28", "user32", "user36", "user44", "user48"]);
  });

  it("Refund Control policy counts cover every customer", async () => {
    const save = await get("/v2/projects/proj1/refund_control", { method: "POST", json: { policies: [
      { name: "Germany", rules: { groups: [{ conditions: [{ field: "country", operator: "is", value: "DE" }] }] }, preference: "prefer_no_refund" },
      { name: "Active", rules: { groups: [{ conditions: [{ field: "status", operator: "is", value: "active" }] }] }, preference: "prefer_refund" },
    ] } });
    expect(save.status).toBe(200);
    const rc = await get("/v2/projects/proj1/refund_control");
    const de = expected(N, isDE).customers;
    const active = expected(N, (k) => !isDE(k) && [0, 3, 5].includes(kindOf(k))).customers;
    expect(rc.body.policies.map((p: any) => p.customer_count)).toEqual([de, active]);
    expect(rc.body.default_policy.customer_count).toBe(N - de - active);
    expect(rc.body).toMatchObject({ counts_are_approximate: false, counts_are_counting: false, counts_counted_at: NOW.getTime() });
  });

  it("win-back previews count every churned subscriber with an email", async () => {
    const made = await get("/v2/projects/proj1/winback_campaigns", { method: "POST", json: { name: "Come back", email: { subject: "We miss you", heading: "Come back", body: "Your plan is waiting.", button_label: "Resubscribe" }, offer: { type: "url", url: "https://example.com/back" } } });
    expect(made.status).toBe(201);
    const pv = await get(`/v2/projects/proj1/winback_campaigns/${made.body.id}/actions/preview`, { method: "POST", json: {} });
    expect(pv.body).toMatchObject({ eligible: expected(N, (k) => kindOf(k) === 1 && hasEmail(k)).customers, is_approximate: false, is_counting: false });
    expect(pv.body.sample).toHaveLength(10);
    await get(`/v2/projects/proj1/winback_campaigns/${made.body.id}`, { method: "DELETE" });
  });
});

describe("background counts above the in-request limit", () => {
  it("answers 'counting', the tick counts in resumable pages, then the exact count is served", async () => {
    const small = createApp({ db: h.db, now: () => NOW, stores: defaultStores(), countInlineLimit: 1_000 });
    const call = async (path: string) => (await small.request(path, { headers: { authorization: `Bearer ${h.ids.secretKey}` } })).json() as Promise<any>;
    const q = `/v2/projects/proj1/customer_lists?list=active&limit=2&rules=${enc(DE_WITH_EMAIL)}`;
    const before = await call(q);
    expect(before.summary).toMatchObject({ customers: 0, is_counting: true, counted_at: null });
    // Rows do not wait for the count.
    expect(before.items).toHaveLength(2);
    // A tiny budget: each run counts one page of 1,000 and saves its place.
    let runs = 0;
    for (;;) {
      runs++;
      let ticks = 0;
      const r = await runCountJobs(h.db, NOW, { pageSize: 1_000, budgetMs: 1, clock: () => ticks++ });
      expect(r.pages).toBe(1);
      if (r.finished) break;
    }
    // The "active" list is half the project in SQL, so six pages of 1,000.
    expect(runs).toBe(expected(N, (k) => [0, 2, 5].includes(kindOf(k))).customers / 1_000);
    const after = await call(q);
    const e = expected(N, (k) => isDE(k) && hasEmail(k) && [0, 2, 5].includes(kindOf(k)));
    expect(after.summary).toMatchObject({ customers: e.customers, trialing_subscribers: e.trialing, paid_subscribers: e.paid, total_revenue_in_usd: e.revenue, is_counting: false, counted_at: NOW.getTime() });
    expect(after.summary.customers).toBe((await countAll(h.db, "proj1", "customer_list", { list: "active", audience_rules: null, rules: DE_WITH_EMAIL, search: null }, NOW)).customers);
    // Ten minutes later the stored count is still served while the tick refreshes it.
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const stale = await exactCount(h.db, "proj1", "customer_list", { list: "active", audience_rules: null, rules: DE_WITH_EMAIL, search: null }, later, 1_000);
    expect(stale).toMatchObject({ counting: false, countedAt: NOW.getTime(), result: { customers: e.customers } });
    expect((await runCountJobs(h.db, later, { budgetMs: 60_000 })).finished).toBe(1);
    expect((await exactCount(h.db, "proj1", "customer_list", { list: "active", audience_rules: null, rules: DE_WITH_EMAIL, search: null }, later, 1_000)).countedAt).toBe(later.getTime());

    const pv = await (await small.request("/v2/projects/proj1/audiences/actions/preview", { method: "POST", headers: { authorization: `Bearer ${h.ids.secretKey}`, "content-type": "application/json" }, body: JSON.stringify({ rules: DE_WITH_EMAIL }) })).json() as any;
    expect(pv.stats).toMatchObject({ total_customers: 0, is_approximate: true });
    const rc = await call("/v2/projects/proj1/refund_control");
    expect(rc).toMatchObject({ counts_are_counting: true, counts_counted_at: null });
    await runCountJobs(h.db, NOW, { budgetMs: 60_000 });
    expect((await call("/v2/projects/proj1/refund_control")).counts_are_counting).toBe(false);
  }, 180_000);
});
