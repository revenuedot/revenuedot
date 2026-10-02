// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: account notification emails from the tick (prd/account-settings/PRD.md §4): the weekly summary (numbers
// from the chart engine, the reader's week start and currency), experiment results, revenue anomaly alerts, idempotency
// and the per-tick bounds.
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { NOTIFY_LIMITS, change, digestRows, runAccountNotifications, weekLabel } from "../src/services/account-notifications.js";
import { tick } from "../src/services/tick.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const DAY = 86_400_000;
const T = (x: string) => new Date(x.length === 10 ? `${x}T00:00:00Z` : x);
const noNetwork = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
let n = 0;

async function project(id: string, name = id) {
  await s!.db.insert(schema.projects).values({ id, name });
  await s!.db.insert(schema.apps).values({ id: `app_${id}`, projectId: id, name: `${name} iOS`, type: "app_store", publicKey: `appl_${id}` });
  await s!.db.insert(schema.products).values({ id: `prod_${id}`, projectId: id, appId: `app_${id}`, storeIdentifier: "monthly", type: "subscription", duration: "P1M" });
  await s!.db.insert(schema.products).values({ id: `coin_${id}`, projectId: id, appId: `app_${id}`, storeIdentifier: "coins", type: "consumable" });
}
async function purchase(projectId: string, at: string, o: { usd?: number; kind?: string; product?: string; months?: number; customer?: string } = {}) {
  const id = `t${++n}`;
  const customer = o.customer ?? `c_${id}`;
  if (!o.customer) await s!.db.insert(schema.customers).values({ id: customer, projectId, originalAppUserId: `u_${id}`, firstSeen: T(at), lastSeen: T(at) });
  const product = o.product ?? "monthly";
  const expires = product === "coins" ? null : o.kind === "trial" ? new Date(T(at).getTime() + 7 * DAY) : new Date(new Date(T(at)).setUTCMonth(T(at).getUTCMonth() + (o.months ?? 1)));
  await s!.db.insert(schema.transactions).values({ id, projectId, customerId: customer, appId: `app_${projectId}`, store: "app_store", storeTransactionId: id, productIdentifier: product, kind: o.kind ?? "purchase", purchasedAt: T(at), expiresAt: expires, revenueUsd: o.usd ?? 10, isSandbox: false });
  return customer;
}
async function member(email: string, projectId: string, prefs: Partial<typeof schema.notificationPrefs.$inferInsert>, user: Partial<typeof schema.users.$inferInsert> = {}) {
  const id = `usr_${email.split("@")[0]}`;
  await s!.db.insert(schema.users).values({ id, email, name: email.split("@")[0], ...user }).onConflictDoNothing();
  await s!.db.insert(schema.memberships).values({ userId: id, projectId, role: "admin" }).onConflictDoNothing();
  await s!.db.insert(schema.notificationPrefs).values({ userId: id, projectId, ...prefs });
  return id;
}
const run = (limits = NOTIFY_LIMITS) => runAccountNotifications({ db: s!.db, mailer: s!.mail, publicUrl: "https://dash.example.com", fetch: null }, s!.now(), limits);
const mails = (to: string) => s!.mail.sent.filter((m) => m.to === to);

/**
 * Project "scan": four monthly $10 subscriptions in the week of Sep 14 (Mon) and three more plus a trial in the week of
 * Sep 21.
 */
async function weekData() {
  await project("scan", "Scanner");
  for (const d of ["2026-09-15", "2026-09-15", "2026-09-16", "2026-09-17"]) await purchase("scan", d);
  for (const d of ["2026-09-22", "2026-09-23", "2026-09-24"]) await purchase("scan", d);
  await purchase("scan", "2026-09-25", { kind: "trial", usd: 0 });
}

describe("weekly summary", () => {
  it("goes out once on the first day of the reader's week with the chart engine's numbers", async () => {
    s = await accountServer({ fetch: noNetwork });
    await weekData();
    await member("mona@example.com", "scan", { weeklySummary: true });
    // Monday Sep 28, 05:00 UTC: too early. 06:00: due.
    s.setNow(T("2026-09-28T05:00:00Z"));
    expect((await run()).weekly).toBe(0);
    s.setNow(T("2026-09-28T07:00:00Z"));
    expect((await run()).weekly).toBe(1);
    const [m] = mails("mona@example.com");
    expect(m!.subject).toBe("Scanner: your week, Sep 21 – Sep 27, 2026");
    expect(m!.text).toContain("MRR grew 75.0% to $70.00, with $30.00 of revenue this week.");
    expect(m!.text).toContain("MRR: $70.00 (+$30.00 (+75.0%))");
    expect(m!.text).toContain("Revenue: $30.00 (−$10.00 (−25.0%))");
    expect(m!.text).toContain("New customers: 4 (±0 (±0.0%))");
    expect(m!.text).toContain("New trials: 1 (+1)");
    expect(m!.text).toContain("Churned subscriptions: 0 (±0)");
    expect(m!.text).toContain("Open the charts: https://dash.example.com/projects/scan/charts/mrr");
    expect(m!.text).toContain("https://dash.example.com/account/notifications");
    expect(m!.html).toContain("Vs last week");
    // Idempotent: again the same day, the next day, two ticks at once.
    await Promise.all([run(), run()]);
    s.advance(DAY);
    await run();
    expect(mails("mona@example.com")).toHaveLength(1);
    expect(await s.db.select().from(schema.notificationSends)).toEqual([expect.objectContaining({ userId: "usr_mona", projectId: "scan", kind: "weekly_summary", key: "2026-09-21" })]);
    // After the third day of the week nothing more goes out for it.
    s.setNow(T("2026-10-01T07:00:00Z"));
    await s.db.delete(schema.notificationSends);
    expect((await run()).weekly).toBe(0);
  });

  it("follows the reader's week start and display currency", async () => {
    s = await accountServer({ fetch: noNetwork });
    await weekData();
    await s.db.insert(schema.fxRates).values({ source: "ecb", date: "2026-09-01", rates: { EUR: 1, USD: 1.25 } });
    await member("sol@example.com", "scan", { weeklySummary: true }, { weekStart: 0, displayCurrency: "EUR" });
    await member("ted@example.com", "scan", { weeklySummary: true });
    // Sunday Sep 27: Sol's week starts, Ted's (Monday) does not.
    s.setNow(T("2026-09-27T09:00:00Z"));
    expect((await run()).weekly).toBe(1);
    const [m] = mails("sol@example.com");
    expect(m!.subject).toBe("Scanner: your week, Sep 20 – Sep 26, 2026");
    // $10 at 1.25 USD per EUR is €8.00; Sol's week (Sun Sep 20 – Sat Sep 26) has the three monthly purchases.
    expect(m!.text).toContain("Revenue: €24.00");
    expect(mails("ted@example.com")).toHaveLength(0);
  });

  it("skips projects with nothing in either week, members who left, and people who turned it off", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("empty");
    await weekData();
    await member("una@example.com", "empty", { weeklySummary: true });
    const gone = await member("vin@example.com", "scan", { weeklySummary: true });
    await s.db.delete(schema.memberships).where(eq(schema.memberships.userId, gone));
    await member("wim@example.com", "scan", { weeklySummary: false, experimentResults: true });
    s.setNow(T("2026-09-28T07:00:00Z"));
    expect(await run()).toMatchObject({ weekly: 0 });
    expect(s.mail.sent).toHaveLength(0);
    // The empty week was handled once (no email), so it is not computed again.
    expect((await run()).analysed).toBe(0);
  });

  it("shows churned subscriptions and the churn rate", async () => {
    s = await accountServer({ fetch: noNetwork });
    await weekData();
    // Two monthly subscriptions from August that end in the week of Sep 21 without renewing.
    await purchase("scan", "2026-08-22");
    await purchase("scan", "2026-08-23");
    await member("uma@example.com", "scan", { weeklySummary: true });
    s.setNow(T("2026-09-28T07:00:00Z"));
    expect((await run()).weekly).toBe(1);
    const [m] = mails("uma@example.com");
    expect(m!.text).toContain("Churned subscriptions: 2 (+2)");
    expect(m!.text).toMatch(/Churn rate: 33\.3% \(\+33\.3 pts\)/);
  });

  it("formats changes", () => {
    expect(change(70, 40, "money")).toBe("+$30.00 (+75.0%)");
    expect(change(5, 0, "count")).toBe("+5");
    expect(change(2.5, 4, "points")).toBe("−1.5 pts");
    expect(weekLabel(T("2026-12-28").getTime())).toBe("Dec 28 – Jan 3, 2027");
    const z = { mrr: 0, revenue: 0, newCustomers: 0, newTrials: 0, churned: 0, churnRate: null };
    expect(digestRows({ weekStart: 0, currency: "USD", current: z, previous: z, empty: true }).headline).toBe("MRR ended the week at $0.00, with $0.00 of revenue.");
  });
});

describe("experiment results", () => {
  async function experiment(status: string, perVariant: number, stoppedAt?: Date) {
    await s!.db.insert(schema.offerings).values([{ id: "ofrA", projectId: "scan", lookupKey: "a", displayName: "A" }, { id: "ofrB", projectId: "scan", lookupKey: "b", displayName: "B" }]).onConflictDoNothing();
    const id = `exp_${++n}`;
    await s!.db.insert(schema.experiments).values({ id, projectId: "scan", name: "Annual first", status, offeringA: "ofrA", offeringB: "ofrB", startedAt: T("2026-09-01"), stoppedAt: stoppedAt ?? null });
    for (const v of ["a", "b"] as const) for (let i = 0; i < perVariant; i++) {
      const cid = `${id}_${v}${i}`;
      await s!.db.insert(schema.customers).values({ id: cid, projectId: "scan", originalAppUserId: cid, firstSeen: T("2026-09-02") });
      await s!.db.insert(schema.experimentEnrollments).values({ experimentId: id, customerId: cid, variant: v, enrolledAt: T("2026-09-02") });
      // B converts twice as often as A.
      if (i % (v === "a" ? 10 : 5) === 0) await purchase("scan", "2026-09-03", { customer: cid, usd: 30 });
    }
    return id;
  }

  it("emails once when an experiment has enough data and once when it ends", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("scan", "Scanner");
    await member("xen@example.com", "scan", { experimentResults: true });
    s.setNow(T("2026-09-30T12:00:00Z"));
    const small = await experiment("running", 40);
    expect((await run()).experiments).toBe(0);
    const big = await experiment("running", 100);
    expect((await run()).experiments).toBe(1);
    expect((await run()).experiments).toBe(0);
    const [m] = mails("xen@example.com");
    expect(m!.subject).toBe("Annual first has enough data to read");
    expect(m!.text).toContain("A (100 customers): 10.0% ($3.00)");
    expect(m!.text).toContain("B (100 customers): 20.0% ($6.00)");
    expect(m!.text).toContain("B beats A on conversion with a 98% chance.");
    expect(m!.text).toContain(`https://dash.example.com/projects/scan/experiments/${big}`);
    // Stopping both: one "ended" email each, and the small one never gets an "enough data" email afterwards.
    await s.db.update(schema.experiments).set({ status: "stopped", stoppedAt: s.now() });
    expect((await run()).experiments).toBe(2);
    expect(mails("xen@example.com").map((x) => x.subject)).toEqual(["Annual first has enough data to read", "Annual first ended", "Annual first ended"]);
    expect((await run()).experiments).toBe(0);
    const sends = await s.db.select().from(schema.notificationSends).where(eq(schema.notificationSends.key, small));
    expect(sends.map((x) => x.kind).sort()).toEqual(["experiment_ended", "experiment_enough_data"]);
    // Experiments that ended more than 7 days ago are left alone.
    await experiment("stopped", 10, T("2026-09-01"));
    expect((await run()).experiments).toBe(0);
  });
});

describe("revenue anomaly alerts", () => {
  async function dailyRevenue(projectId: string, from: string, days: number, usd: number) {
    const customer = await purchase(projectId, from, { product: "coins", usd });
    for (let i = 1; i < days; i++) await purchase(projectId, new Date(T(from).getTime() + i * DAY).toISOString(), { product: "coins", usd, customer });
  }

  it("checks yesterday once a day and emails each watcher once, at their sensitivity", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("scan", "Scanner");
    // $100 a day from Aug 30 to Sep 26, nothing on Sep 27.
    await dailyRevenue("scan", "2026-08-30", 28, 100);
    await member("yara@example.com", "scan", { anomalyAlerts: true, anomalySensitivity: "medium" }, { displayCurrency: "GBP" });
    await member("zoe@example.com", "scan", { anomalyAlerts: true, anomalySensitivity: "low" });
    s.setNow(T("2026-09-28T05:00:00Z"));
    expect((await run()).anomalies).toBe(0);
    s.setNow(T("2026-09-28T06:30:00Z"));
    expect((await run()).anomalies).toBe(2);
    const [m] = mails("yara@example.com");
    expect(m!.subject).toBe("Scanner: revenue dropped on 2026-09-27");
    expect(m!.text).toMatch(/Revenue dropped\. £0\.00 on 2026-09-27, against a usual £\d+\.\d\d a day \(−100%\)\./);
    expect(m!.text).toContain("at medium sensitivity");
    expect(m!.text).toContain("https://dash.example.com/projects/scan/charts/revenue");
    const [check] = await s.db.select().from(schema.anomalyChecks);
    expect(check).toMatchObject({ projectId: "scan", day: "2026-09-27" });
    expect((check!.result as any).revenue.value).toBe(0);
    expect((check!.result as any).revenue.history).toHaveLength(28);
    // Later the same day: nothing new, nothing recomputed.
    s.advance(3_600_000);
    expect(await run()).toMatchObject({ anomalies: 0, analysed: 0 });
    expect(s.mail.sent).toHaveLength(2);
  });

  it("does not alert on normal days, small changes at low sensitivity, or without history", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("scan");
    await project("young");
    await dailyRevenue("scan", "2026-08-31", 28, 100); // Sep 27 is a normal $100 day
    await dailyRevenue("young", "2026-09-21", 7, 100); // six days of history, and a normal $100 on the day checked
    await member("abe@example.com", "scan", { anomalyAlerts: true, anomalySensitivity: "high" });
    await member("bo@example.com", "young", { anomalyAlerts: true });
    s.setNow(T("2026-09-28T07:00:00Z"));
    expect(await run()).toMatchObject({ anomalies: 0, analysed: 2 });
    expect(s.mail.sent).toHaveLength(0);
  });

  it("runs from the tick, bounded per tick: the rest waits for the next one", async () => {
    s = await accountServer({ fetch: noNetwork });
    for (let i = 0; i < 7; i++) {
      await project(`p${i}`);
      await dailyRevenue(`p${i}`, "2026-08-30", 28, 100);
      await member(`ann${i}@example.com`, `p${i}`, { anomalyAlerts: true });
    }
    s.setNow(T("2026-09-28T07:00:00Z"));
    const first = await tick(s.db, s.now(), noNetwork, { mailer: s.mail, publicUrl: "https://dash.example.com" });
    expect(first.notifications).toBe(5);
    expect(await s.db.select().from(schema.anomalyChecks)).toHaveLength(5);
    const second = await tick(s.db, s.now(), noNetwork, { mailer: s.mail, publicUrl: "https://dash.example.com" });
    expect(second.notifications).toBe(2);
    expect((await tick(s.db, s.now(), noNetwork, { mailer: s.mail, publicUrl: "https://dash.example.com" })).notifications).toBe(0);
    expect(s.mail.sent).toHaveLength(7);
    // A limit on emails holds too.
    await s.db.delete(schema.notificationSends);
    const r = await run({ projects: 10, emails: 3, budgetMs: 15_000 });
    expect(r.anomalies).toBe(3);
    const left = await s.db.select().from(schema.notificationSends).where(and(eq(schema.notificationSends.kind, "revenue_anomaly")));
    expect(left).toHaveLength(3);
  });
});

describe("review fixes", () => {
  it("re-checks a running experiment without enough data at most once an hour, so it never starves the others", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("scan", "Scanner");
    await member("gil@example.com", "scan", { experimentResults: true });
    s.setNow(T("2026-09-30T12:00:00Z"));
    // Six small experiments come before the one that is ready, more than one tick may analyse.
    const X = schema.experiments;
    await s.db.insert(schema.offerings).values([{ id: "ofrA", projectId: "scan", lookupKey: "a", displayName: "A" }, { id: "ofrB", projectId: "scan", lookupKey: "b", displayName: "B" }]);
    for (let i = 0; i < 6; i++) await s.db.insert(X).values({ id: `exp_small${i}`, projectId: "scan", name: `Small ${i}`, status: "running", offeringA: "ofrA", offeringB: "ofrB", startedAt: T("2026-09-01") });
    await s.db.insert(X).values({ id: "exp_ready", projectId: "scan", name: "Ready", status: "running", offeringA: "ofrA", offeringB: "ofrB", startedAt: T("2026-09-01") });
    for (const v of ["a", "b"] as const) for (let i = 0; i < 100; i++) {
      const cid = `r_${v}${i}`;
      await s.db.insert(schema.customers).values({ id: cid, projectId: "scan", originalAppUserId: cid, firstSeen: T("2026-09-02") });
      await s.db.insert(schema.experimentEnrollments).values({ experimentId: "exp_ready", customerId: cid, variant: v, enrolledAt: T("2026-09-02") });
    }
    const limits = { projects: 5, emails: 20, budgetMs: 15_000 };
    await run(limits);
    s.advance(60_000);
    await run(limits);
    expect(mails("gil@example.com").map((m) => m.subject)).toEqual(["Ready has enough data to read"]);
    // The small ones are looked at again an hour later, not every minute.
    s.advance(60_000);
    expect((await run(limits)).analysed).toBe(0);
    s.advance(3_600_000);
    expect((await run(limits)).analysed).toBe(5);
  });

  it("shows amounts in USD, labelled USD, when the reader's currency has no rate", async () => {
    s = await accountServer({ fetch: noNetwork });
    await project("scan", "Scanner");
    const customer = await purchase("scan", "2026-08-30", { product: "coins", usd: 100 });
    for (let i = 1; i < 28; i++) await purchase("scan", new Date(T("2026-08-30").getTime() + i * DAY).toISOString(), { product: "coins", usd: 100, customer });
    // Cached rates of both sources, neither with GBP.
    await s.db.insert(schema.fxRates).values([{ source: "ecb", date: "2026-09-01", rates: { EUR: 1, USD: 1.25 } }, { source: "usd", date: "2026-09-01", rates: { EUR: 0.8 } }]);
    await member("hal@example.com", "scan", { anomalyAlerts: true }, { displayCurrency: "GBP" });
    s.setNow(T("2026-09-28T07:00:00Z"));
    expect((await run()).anomalies).toBe(1);
    const [m] = mails("hal@example.com");
    expect(m!.text).toContain("$0.00 on 2026-09-27, against a usual $100.00 a day");
    expect(m!.text).not.toContain("£");
  });

  it("every notification email has a one-click unsubscribe that turns off that email for that project only", async () => {
    s = await accountServer({ fetch: noNetwork });
    await weekData();
    await project("other", "Other");
    await member("ida@example.com", "scan", { weeklySummary: true, anomalyAlerts: true });
    await s.db.insert(schema.memberships).values({ userId: "usr_ida", projectId: "other", role: "admin" });
    await s.db.insert(schema.notificationPrefs).values({ userId: "usr_ida", projectId: "other", weeklySummary: true });
    s.setNow(T("2026-09-28T07:00:00Z"));
    await run();
    const [m] = mails("ida@example.com");
    const header = m!.headers?.["List-Unsubscribe"] ?? "";
    expect(m!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = /^<(https:\/\/dash\.example\.com\/auth\/notifications\/unsubscribe\/[A-Za-z0-9_-]+)>$/.exec(header)?.[1];
    expect(url).toBeTruthy();
    expect(m!.text).toContain(`Unsubscribe: ${url}`);
    expect(m!.html).toContain(url);
    const path = new URL(url!).pathname;
    // A GET (a mail scanner following the link) changes nothing; it shows a button.
    const page = await s.app.fetch(new Request(`http://localhost${path}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<form method=\"post\"");
    expect((await s.db.select().from(schema.notificationPrefs).where(and(eq(schema.notificationPrefs.userId, "usr_ida"), eq(schema.notificationPrefs.projectId, "scan"))))[0]!.weeklySummary).toBe(true);
    // RFC 8058 one-click: a POST without a session.
    const done = await s.app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    expect(done.status).toBe(200);
    const prefs = await s.db.select().from(schema.notificationPrefs).where(eq(schema.notificationPrefs.userId, "usr_ida"));
    expect(prefs.find((p) => p.projectId === "scan")).toMatchObject({ weeklySummary: false, anomalyAlerts: true });
    expect(prefs.find((p) => p.projectId === "other")).toMatchObject({ weeklySummary: true });
    expect((await s.app.fetch(new Request("http://localhost/auth/notifications/unsubscribe/not-a-token", { method: "POST" }))).status).toBe(404);
  });
});
