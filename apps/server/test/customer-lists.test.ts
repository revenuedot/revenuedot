import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { getOrCreateCustomer, setAttributes, touch } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { toCsv } from "../src/services/customer-lists.js";
import type { VerifiedPurchase } from "../src/stores/types.js";

/** Customers lists (prd/lifecycle/PRD.md): built-in lists, saved audiences, filters, search, cards and CSV. */
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
let h: Harness;
beforeEach(async () => { h = await harness(); h.setNow(new Date(NOW)); });
afterEach(async () => { await h.close(); });

const get = async (query: string) => {
  const res = await h.fetch(`/v2/projects/proj1/customer_lists?${query}`, { key: h.ids.secretKey });
  return { status: res.status, body: await res.json() as any };
};

async function person(user: string, o: { sub?: { endsInDays: number; trial?: boolean; sandbox?: boolean; cancelled?: boolean; store?: string }; oneTime?: boolean; email?: string; seenDaysAgo: number; platform?: string; country?: string }) {
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, new Date(NOW - 90 * DAY));
  const ctx = { projectId: "proj1", appId: "app_ios", appUserId: user, now: new Date(NOW - 20 * DAY), fromDevice: false };
  if (o.sub) {
    const end = new Date(NOW + o.sub.endsInDays * DAY);
    await applyPurchases(h.db, customer, [{
      kind: "subscription", store: o.sub.store ?? "app_store", storeKey: `k_${user}`, productIdentifier: "pro_monthly", isSandbox: !!o.sub.sandbox,
      purchaseDate: new Date(end.getTime() - 30 * DAY), originalPurchaseDate: new Date(end.getTime() - 30 * DAY), expiresDate: end,
      periodType: o.sub.trial ? "trial" : "normal", ownershipType: "PURCHASED", storeTransactionId: `t_${user}`, originalTransactionId: `k_${user}`,
      unsubscribeDetectedAt: o.sub.cancelled ? new Date(NOW - DAY) : null, price: { amount: o.sub.trial ? 0 : 9.99, currency: "USD" },
    } as unknown as VerifiedPurchase], ctx);
  }
  if (o.oneTime) {
    await applyPurchases(h.db, customer, [{ kind: "non_subscription", store: "app_store", productIdentifier: "lifetime", storeTransactionId: `nt_${user}`, isSandbox: false, isConsumable: false, purchaseDate: new Date(NOW - 3 * DAY), price: { amount: 49.99, currency: "USD" } } as unknown as VerifiedPurchase], ctx);
  }
  if (o.email) await setAttributes(h.db, customer.id, { $email: { value: o.email } }, new Date(NOW));
  await touch(h.db, customer.id, new Date(NOW - o.seenDaysAgo * DAY), { platform: o.platform ?? "iOS", country: o.country ?? "US" });
}

async function seed() {
  await person("paying", { sub: { endsInDays: 10 }, email: "pay@example.com", seenDaysAgo: 1 });
  await person("trialing", { sub: { endsInDays: 5, trial: true }, seenDaysAgo: 2, country: "DE" });
  await person("cancelled", { sub: { endsInDays: 3, cancelled: true }, seenDaysAgo: 3 });
  await person("lapsed", { sub: { endsInDays: -10 }, email: "lapsed@example.com", seenDaysAgo: 4 });
  await person("tester", { sub: { endsInDays: 10, sandbox: true }, seenDaysAgo: 5, platform: "Android" });
  await person("buyer", { oneTime: true, seenDaysAgo: 6 });
  await person("browser", { seenDaysAgo: 7 });
}

describe("customer lists", () => {
  it("built-in lists, columns and the four summary cards", async () => {
    await seed();
    const all = await get("list=all");
    expect(all.status).toBe(200);
    expect(all.body.items.map((r: any) => r.id)).toEqual(["paying", "trialing", "cancelled", "lapsed", "tester", "buyer", "browser"]);
    expect(all.body.summary).toEqual({ object: "customer_list_summary", customers: 7, trialing_subscribers: 1, paid_subscribers: 2, total_revenue_in_usd: 79.96, is_approximate: false, is_counting: false, counted_at: NOW });
    const row = (id: string) => all.body.items.find((r: any) => r.id === id);
    expect(row("paying")).toMatchObject({ subscription_status: "active", auto_renewal_status: "on", email: "pay@example.com", spent_in_usd: 9.99, latest_purchase: { product_id: "pro_monthly", store: "app_store", environment: "production" }, country: "US", platform: "iOS" });
    expect(row("trialing")).toMatchObject({ subscription_status: "trialing", auto_renewal_status: "on" });
    expect(row("cancelled")).toMatchObject({ subscription_status: "active", auto_renewal_status: "off" });
    expect(row("lapsed")).toMatchObject({ subscription_status: "expired", auto_renewal_status: null });
    expect(row("browser")).toMatchObject({ subscription_status: "none", latest_purchase: null, spent_in_usd: 0 });
    expect(row("paying").last_seen_at).toBe(NOW - DAY);

    const ids = async (list: string) => (await get(`list=${list}`)).body.items.map((r: any) => r.id);
    expect(await ids("active")).toEqual(["paying", "trialing", "cancelled"]);
    expect(await ids("sandbox")).toEqual(["tester"]);
    expect(await ids("non_subscription")).toEqual(["buyer"]);
    expect(await ids("expired")).toEqual(["lapsed"]);
  });

  it("filters with the condition builder, searches, saves an audience and pages", async () => {
    await seed();
    const rules = encodeURIComponent(JSON.stringify({ groups: [{ conditions: [{ field: "country", operator: "is", value: "DE" }] }, { conditions: [{ field: "email", operator: "isNotEmpty" }] }] }));
    expect((await get(`list=all&rules=${rules}`)).body.items.map((r: any) => r.id)).toEqual(["paying", "trialing", "lapsed"]);
    expect((await get("list=all&search=LAPS")).body.items.map((r: any) => r.id)).toEqual(["lapsed"]);
    expect((await get("list=all&search=pay%40example")).body.items.map((r: any) => r.id)).toEqual(["paying"]);
    expect((await get(`list=all&rules=${encodeURIComponent('{"groups":[{"conditions":[{"field":"shoeSize","operator":"is","value":"9"}]}]}')}`)).status).toBe(400);
    expect((await get("list=all&rules=nope")).status).toBe(400);

    const aud = await (await h.fetch("/v2/projects/proj1/audiences", { method: "POST", key: h.ids.secretKey, json: { name: "Has email", rules: { groups: [{ conditions: [{ field: "email", operator: "isNotEmpty" }] }] } } })).json() as any;
    expect((await get(`list=${aud.id}`)).body.items.map((r: any) => r.id)).toEqual(["paying", "lapsed"]);
    expect((await get("list=aud_missing")).status).toBe(404);

    const p1 = await get("list=all&limit=3");
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.next_page).toContain("starting_after=");
    const after = new URL(p1.body.next_page, "http://x").searchParams.get("starting_after");
    const p2 = await get(`list=all&limit=3&starting_after=${after}`);
    expect(p2.body.items.map((r: any) => r.id)).toEqual(["lapsed", "tester", "buyer"]);
  });

  it("sorts by any column, pages in that order and exports in that order", async () => {
    await seed();
    const ids = async (query: string) => (await get(`list=all&${query}`)).body.items.map((r: any) => r.id);
    expect(await ids("sort=id&direction=asc")).toEqual(["browser", "buyer", "cancelled", "lapsed", "paying", "tester", "trialing"]);
    expect(await ids("sort=id&direction=desc")).toEqual(["trialing", "tester", "paying", "lapsed", "cancelled", "buyer", "browser"]);
    // Ties keep the default order: newest last seen first.
    expect(await ids("sort=spent_in_usd&direction=desc")).toEqual(["buyer", "paying", "cancelled", "lapsed", "trialing", "tester", "browser"]);
    expect(await ids("sort=spent_in_usd")).toEqual(["trialing", "tester", "browser", "paying", "cancelled", "lapsed", "buyer"]);
    expect(await ids("sort=last_seen_at&direction=asc")).toEqual(["browser", "buyer", "tester", "lapsed", "cancelled", "trialing", "paying"]);
    expect(await ids("sort=first_seen_at&direction=desc")).toHaveLength(7);
    const status = (await get("list=all&sort=subscription_status")).body.items.map((r: any) => r.subscription_status);
    expect(status.indexOf("none")).toBeGreaterThan(status.lastIndexOf("expired"));
    expect(status.lastIndexOf("active")).toBeLessThan(status.indexOf("trialing"));
    // Customers with no auto-renewal value stay last in both directions.
    for (const d of ["asc", "desc"]) expect((await ids(`sort=auto_renewal_status&direction=${d}`)).slice(-3)).toEqual(["lapsed", "buyer", "browser"]);
    expect((await ids("sort=auto_renewal_status&direction=desc"))[0]).toBe("cancelled");

    const p1 = await get("list=all&sort=id&limit=3");
    expect(p1.body.items.map((r: any) => r.id)).toEqual(["browser", "buyer", "cancelled"]);
    const after = new URL(p1.body.next_page, "http://x").searchParams.get("starting_after");
    expect((await get(`list=all&sort=id&limit=3&starting_after=${after}`)).body.items.map((r: any) => r.id)).toEqual(["lapsed", "paying", "tester"]);

    expect((await get("list=all&sort=email")).status).toBe(400);
    expect((await get("list=all&sort=id&direction=up")).status).toBe(400);

    const csv = await (await h.fetch("/v2/projects/proj1/customer_lists/export?list=all&sort=spent_in_usd&direction=desc", { key: h.ids.secretKey })).text();
    expect(csv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0])).toEqual(["buyer", "paying", "cancelled", "lapsed", "trialing", "tester", "browser"]);
  });

  it("sorts anonymous IDs after named IDs in both directions", async () => {
    await person("$RCAnonymousID:f00d", { seenDaysAgo: 1 });
    await person("Zed", { seenDaysAgo: 2 });
    await person("$RCAnonymousID:0abc", { seenDaysAgo: 3 });
    await person("amy", { seenDaysAgo: 4 });
    const ids = async (query: string) => (await get(`list=all&${query}`)).body.items.map((r: any) => r.id);
    expect(await ids("sort=id&direction=asc")).toEqual(["amy", "Zed", "$RCAnonymousID:0abc", "$RCAnonymousID:f00d"]);
    expect(await ids("sort=id&direction=desc")).toEqual(["Zed", "amy", "$RCAnonymousID:f00d", "$RCAnonymousID:0abc"]);

    const p1 = await get("list=all&sort=id&limit=2");
    expect(p1.body.items.map((r: any) => r.id)).toEqual(["amy", "Zed"]);
    const p2 = await get(`list=all&sort=id&limit=2&starting_after=${new URL(p1.body.next_page, "http://x").searchParams.get("starting_after")}`);
    expect(p2.body.items.map((r: any) => r.id)).toEqual(["$RCAnonymousID:0abc", "$RCAnonymousID:f00d"]);
    expect(p2.body.next_page).toBeNull();
  });

  it("exports the list as CSV", async () => {
    await seed();
    const res = await h.fetch("/v2/projects/proj1/customer_lists/export?list=active", { key: h.ids.secretKey });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="customers-active-2026-09-01.csv"');
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("app_user_id,email,subscription_status,auto_renewal_status,first_seen_at,last_seen_at,spent_in_usd,latest_product_id,latest_store,latest_purchase_at,country,platform");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^paying,pay@example.com,active,on,/);
  });

  it("CSV cells are quoted and never start a spreadsheet formula", () => {
    const csv = toCsv([{ object: "customer_list_row", id: "=HYPERLINK(\"x\")", customer_uuid: "c", email: "a,b@example.com", subscription_status: "none", auto_renewal_status: null, first_seen_at: 0, last_seen_at: 0, spent_in_usd: 0, latest_purchase: null, country: null, platform: null }]);
    expect(csv.split("\r\n")[1]).toBe(`"'=HYPERLINK(""x"")","a,b@example.com",none,,,,0.00,,,,,`);
    const row = (id: string, spent = 0) => toCsv([{ object: "customer_list_row", id, customer_uuid: "c", email: null, subscription_status: "none", auto_renewal_status: null, first_seen_at: 0, last_seen_at: 0, spent_in_usd: spent, latest_purchase: null, country: null, platform: null }]).split("\r\n")[1]!.split(",")[0];
    expect(row(" =1+1")).toBe("' =1+1");
    expect(row("\t@SUM(A1)")).toBe("'\t@SUM(A1)");
    expect(row("\uFF1D1+1")).toBe("'\uFF1D1+1");
    expect(row("-12")).toBe("-12");
    expect(toCsv([{ object: "customer_list_row", id: "u", customer_uuid: "c", email: null, subscription_status: "none", auto_renewal_status: null, first_seen_at: 0, last_seen_at: 0, spent_in_usd: -4.5, latest_purchase: null, country: null, platform: null }])).toContain(",-4.50,");
  });
});
