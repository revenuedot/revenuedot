import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { getOrCreateCustomer } from "../src/repo/customers.js";
import { toolsByName } from "../src/services/assistant/tools.js";
import type { Query, RevenueDotClient } from "../src/services/assistant/client.js";

/**
 * The customer history (GET /v2/projects/{id}/customers/{id}/events) pages in SQL, newest first, and leaves paywall events
 * out unless asked: a project that forwards paywall events records one on every paywall view, and 25 impressions must
 * not push a customer's purchases off the first page. The project event log and RevenueDot AI's tools follow the same rule.
 */

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const get = async (path: string) => {
  const res = await h.fetch(path.startsWith("/v2/") ? path : `/v2/projects/proj1${path}`, { key: h.ids.secretKey });
  return { status: res.status, body: await res.json() as any };
};

/** One purchase and two renewals a day apart, then `impressions` paywall views and one close, all newer. */
async function seed(appUserId: string, impressions: number, environment = "production") {
  const { customer } = await getOrCreateCustomer(h.db, "proj1", appUserId, h.now());
  const t0 = h.now().getTime() - 30 * 86400_000;
  let n = 0;
  const row = (type: string, at: number) => ({
    id: `${appUserId}_${String(n++).padStart(3, "0")}`, projectId: "proj1", customerId: customer.id, type, environment, appId: "app_ios",
    payload: { api_version: "1.0", event: { type, app_user_id: appUserId, environment: environment.toUpperCase() } }, eventTimestampMs: at,
  });
  const rows = [row("INITIAL_PURCHASE", t0), row("RENEWAL", t0 + 86400_000), row("RENEWAL", t0 + 2 * 86400_000)];
  for (let i = 0; i < impressions; i++) rows.push(row("PAYWALL_IMPRESSION", t0 + 3 * 86400_000 + i * 60_000));
  rows.push(row("PAYWALL_CLOSE", t0 + 4 * 86400_000));
  await h.db.insert(schema.events).values(rows);
  return customer;
}

/** Follows next_page to the end. */
async function all(first: string) {
  const items: any[] = [];
  let next: string | null = first;
  while (next) {
    const r = await get(next);
    expect(r.status).toBe(200);
    items.push(...r.body.items);
    next = r.body.next_page;
  }
  return items;
}

describe("customer history", () => {
  it("shows purchases on the first page by default, however many paywall events are newer", async () => {
    await seed("wren", 40);
    const r = await get("/customers/wren/events?limit=25");
    expect(r.status).toBe(200);
    expect(r.body.items.map((e: any) => e.type)).toEqual(["RENEWAL", "RENEWAL", "INITIAL_PURCHASE"]);
    expect(r.body.next_page).toBeNull();
  });

  it("include_paywall_events=true pages every event newest first, without repeats, keeping the filter in next_page", async () => {
    await seed("wren", 40);
    const r = await get("/customers/wren/events?limit=25&include_paywall_events=true");
    expect(r.body.items).toHaveLength(25);
    expect(r.body.items[0].type).toBe("PAYWALL_CLOSE");
    expect(r.body.next_page).toContain("include_paywall_events=true");
    const items = await all("/customers/wren/events?limit=25&include_paywall_events=true");
    expect(items).toHaveLength(44);
    expect(new Set(items.map((e) => e.id)).size).toBe(44);
    expect(items.map((e) => e.occurred_at)).toEqual([...items.map((e) => e.occurred_at)].sort((a, b) => b - a));
    expect(items.slice(-3).map((e) => e.type)).toEqual(["RENEWAL", "RENEWAL", "INITIAL_PURCHASE"]);
  });

  it("type names the events to return, paywall types included", async () => {
    await seed("wren", 3);
    expect((await get("/customers/wren/events?type=PAYWALL_CLOSE")).body.items.map((e: any) => e.type)).toEqual(["PAYWALL_CLOSE"]);
    expect((await get("/customers/wren/events?type=renewal,paywall_impression")).body.items.map((e: any) => e.type)).toEqual(["PAYWALL_IMPRESSION", "PAYWALL_IMPRESSION", "PAYWALL_IMPRESSION", "RENEWAL", "RENEWAL"]);
  });

  it("pages through events that share a timestamp by id", async () => {
    const { customer } = await getOrCreateCustomer(h.db, "proj1", "tied", h.now());
    const at = h.now().getTime() - 1000;
    await h.db.insert(schema.events).values(["a", "b", "c", "d", "e"].map((x) => ({
      id: `ev_${x}`, projectId: "proj1", customerId: customer.id, type: "RENEWAL", environment: "production", appId: null, payload: { event: {} }, eventTimestampMs: at,
    })));
    expect((await all("/customers/tied/events?limit=2")).map((e) => e.id)).toEqual(["ev_e", "ev_d", "ev_c", "ev_b", "ev_a"]);
  });

  it("filters by environment and rejects a cursor from another customer, an unknown cursor and a bad include flag", async () => {
    await seed("wren", 2);
    await seed("sandy", 2, "sandbox");
    expect((await get("/customers/wren/events?environment=sandbox")).body.items).toEqual([]);
    expect((await get("/customers/sandy/events?environment=sandbox")).body.items).toHaveLength(3);
    for (const q of ["starting_after=sandy_000", "starting_after=nope", "include_paywall_events=yes", "type=RENEWAL&include_paywall_events=1"]) {
      const r = await get(`/customers/wren/events?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.type).toBe("parameter_error");
    }
  });
});

describe("project event log", () => {
  it("leaves paywall events out unless asked, for one customer or all", async () => {
    await seed("wren", 30);
    expect((await get("/events?customer=wren&limit=5")).body.items.map((e: any) => e.type)).toEqual(["RENEWAL", "RENEWAL", "INITIAL_PURCHASE"]);
    expect((await get("/events?limit=100")).body.items).toHaveLength(3);
    expect((await get("/events?limit=100&include_paywall_events=true")).body.items).toHaveLength(34);
    expect((await get("/events?limit=100&type=PAYWALL_IMPRESSION")).body.items).toHaveLength(30);
  });
});

describe("RevenueDot AI tools", () => {
  /** A client that records requests and answers them from `answer`. */
  const client = (answer: (method: string, path: string, query: Query) => unknown) => {
    const calls: { method: string; path: string; query: Query }[] = [];
    const c: RevenueDotClient = {
      baseUrl: "http://localhost", project: async () => "proj1",
      request: async <T,>(method: string, path: string, o: { query?: Query } = {}) => { calls.push({ method, path, query: o.query ?? {} }); return answer(method, path, o.query ?? {}) as T; },
    };
    return { c, calls };
  };

  it("list-events asks for paywall events only when told to", async () => {
    const { c, calls } = client(() => ({ items: [], next_page: null }));
    await toolsByName.get("list-events")!.run(c, { customer_id: "wren" } as never);
    await toolsByName.get("list-events")!.run(c, { customer_id: "wren", include_paywall_events: true } as never);
    expect(calls.map((x) => x.query.include_paywall_events)).toEqual([undefined, "true"]);
  });

  it("replay-failed-webhook-deliveries sends purchase deliveries before paywall ones within its 100", async () => {
    const now = Date.now();
    const failed = Array.from({ length: 150 }, (_, i) => ({ id: `d${String(i).padStart(3, "0")}`, created_at: now - i, event_type: i < 140 ? "PAYWALL_IMPRESSION" : "RENEWAL" }));
    const { c, calls } = client((method, _path, q) => {
      if (method === "POST") return {};
      const pool = failed.filter((d) => (q.paywall_events === "only") === d.event_type.startsWith("PAYWALL_"));
      const start = q.starting_after ? pool.findIndex((d) => d.id === q.starting_after) + 1 : 0;
      return { items: pool.slice(start, start + 100), next_page: start + 100 < pool.length ? "more" : null };
    });
    const r = await toolsByName.get("replay-failed-webhook-deliveries")!.run(c, { webhook_id: "wh_1" } as never) as any;
    expect(r.retried).toBe(100);
    const posted = calls.filter((x) => x.method === "POST").map((x) => x.path.split("/").at(-2));
    expect(posted.slice(0, 10)).toEqual(failed.slice(140).map((d) => d.id));
    expect(posted.slice(10)).toEqual(failed.slice(0, 90).map((d) => d.id));
    expect(calls.filter((x) => x.method === "GET").map((x) => x.query.paywall_events)).toEqual(["exclude", "only"]);
  });
});
