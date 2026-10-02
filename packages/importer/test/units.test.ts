// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: unit tests for the importer's HTTP retries, pagination guard and RevenueCat-to-RevenueDot conversion.
// Docs: https://revenuedot.app/docs/migrate
import { describe, expect, it } from "vitest";
import { HttpError, TimeoutError, pool, requestJson, retryAfterMs } from "../src/http.js";
import { RevenueCatClient } from "../src/revenuecat.js";
import { parseTokenCsv, toImportCustomer } from "../src/convert.js";
import { emptyCatalog } from "../src/state.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("requestJson", () => {
  it("reads Retry-After seconds, an HTTP date, or RevenueCat's backoff_ms", () => {
    expect(retryAfterMs(json(429, {}, { "Retry-After": "7" }), {})).toBe(7000);
    expect(retryAfterMs(json(429, {}, { "Retry-After": new Date(10_000).toUTCString() }), {}, 4_000)).toBe(6000);
    expect(retryAfterMs(json(429, {}), { backoff_ms: 1500 })).toBe(1500);
    expect(retryAfterMs(json(429, {}), {})).toBeNull();
  });

  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    const answers: (() => Response)[] = [() => { throw new Error("ECONNRESET"); }, () => json(503, { message: "busy" }), () => json(200, { ok: true })];
    const sleeps: number[] = [];
    const out = await requestJson("https://x.test/a", {}, { fetch: async () => answers.shift()!(), sleep: async (ms) => { sleeps.push(ms); } });
    expect(out).toEqual({ ok: true });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxRetries and throws other 4xx at once, without the query string in the message", async () => {
    await expect(requestJson("https://x.test/a", {}, { fetch: async () => json(500, {}), sleep: async () => {}, maxRetries: 2 })).rejects.toBeInstanceOf(HttpError);
    const e = await requestJson("https://x.test/a?search=secret@example.com", {}, { fetch: async () => json(404, { message: "Customer not found." }) }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(404);
    expect(e.message).toBe("404 from https://x.test/a: Customer not found.");
  });

  it("tries a request that timed out once more, then throws TimeoutError with the limit in seconds", async () => {
    let calls = 0;
    const slow = async () => { calls++; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    const e = await requestJson("https://x.test/import?x=1", {}, { fetch: slow, sleep: async () => {}, timeoutMs: 60_000 }).catch((x) => x);
    expect(e).toBeInstanceOf(TimeoutError);
    expect(e.message).toBe("No answer from https://x.test/import within 60 s.");
    expect(calls).toBe(2);
  });

  it("pool keeps order and limits concurrency", async () => {
    let live = 0, peak = 0;
    const out = await pool([5, 1, 3, 2, 4], 2, async (n) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, n)); live--; return n * 10; });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});

describe("RevenueCatClient", () => {
  it("follows relative and absolute next_page links on its own host only", () => {
    const rc = new RevenueCatClient({ apiKey: "sk_x", projectId: "p", baseUrl: "https://api.revenuecat.com" });
    expect(rc.nextUrl("/v2/projects/p/customers?starting_after=a")).toBe("https://api.revenuecat.com/v2/projects/p/customers?starting_after=a");
    expect(rc.nextUrl("https://api.revenuecat.com/v2/projects/p/apps?starting_after=b")).toBe("https://api.revenuecat.com/v2/projects/p/apps?starting_after=b");
    expect(rc.nextUrl(null)).toBeNull();
    expect(() => rc.nextUrl("https://evil.example.com/v2/x")).toThrow(/another host/);
  });
});

describe("conversion", () => {
  const map = emptyCatalog();
  map.products.prod_m = { id: "p1", storeIdentifier: "pro_monthly", appId: "app_ios", rcAppId: "a1", type: "subscription" };
  map.products.prod_g = { id: "p3", storeIdentifier: "pro:monthly", appId: "app_play", rcAppId: "a2", type: "subscription" };
  const money = (gross: number) => ({ currency: "EUR", gross });
  const base = { object: "subscription", customer_id: "u", starts_at: 1, current_period_starts_at: 100, auto_renewal_status: "will_renew", environment: "production" as const, ownership: "purchased" as const, gives_access: true };

  it("keys Apple chains by their first transaction, takes the grace end from the entitlement, and keeps local prices", () => {
    const { customer } = toImportCustomer({
      customer: { id: "u", first_seen_at: 1, active_entitlements: { object: "list", items: [{ entitlement_id: "entl_pro", expires_at: 900 }] } },
      aliases: ["u", "$RCAnonymousID:x"], attributes: [{ name: "$email", value: "u@x.io", updated_at: 5 }, { name: "gone", value: null }],
      subscriptions: [{
        ...base, id: "sub1", product_id: "prod_m", current_period_ends_at: 500, status: "in_grace_period", store: "app_store", store_subscription_identifier: "t3",
        entitlements: { object: "list", items: [{ id: "entl_pro", lookup_key: "pro", display_name: "Pro" }] },
        transactions: [{ id: "t3", purchased_at: 100, product_store_identifier: "pro_monthly", revenue_in_local_currency: money(8.99) }, { id: "t1", purchased_at: 10, product_store_identifier: "pro_monthly" }],
      }],
      purchases: [],
    }, map);
    expect(customer.aliases).toEqual(["$RCAnonymousID:x"]);
    expect(customer.attributes).toEqual([{ name: "$email", value: "u@x.io", updated_at: 5 }]);
    expect(customer.subscriptions![0]).toMatchObject({ original_transaction_id: "t1", grace_period_expires_at: 900, price: { amount: 8.99, currency: "EUR" }, app_id: "app_ios", product_identifier: "pro_monthly" });
  });

  it("finds Google tokens by order id (renewal suffix or not) or by user and product, and skips unknown products", () => {
    const book = parseTokenCsv("order_id;purchase_token\nGPA.1-2-3-4..2;tok_a\n");
    const user = parseTokenCsv("app_user_id,product_id,purchase_token\nu,pro:monthly,tok_b\n");
    const bundle = (store_subscription_identifier: string, product_id = "prod_g") => ({
      customer: { id: "u", first_seen_at: 1 }, aliases: [], attributes: [], purchases: [],
      subscriptions: [{ ...base, id: "s", product_id, current_period_ends_at: 500, status: "active", store: "play_store", store_subscription_identifier }],
    });
    expect(toImportCustomer(bundle("GPA.1-2-3-4..2"), map, book).customer.subscriptions![0]).toMatchObject({ purchase_token: "tok_a", original_transaction_id: "GPA.1-2-3-4" });
    expect(toImportCustomer(bundle("GPA.1-2-3-4..5"), map, book).customer.subscriptions![0]!.purchase_token).toBe("tok_a");
    expect(toImportCustomer(bundle("GPA.9"), map, user).customer.subscriptions![0]!.purchase_token).toBe("tok_b");
    const none = toImportCustomer(bundle("GPA.9"), map);
    expect(none.googleWithoutToken).toBe(1);
    const unknown = toImportCustomer(bundle("GPA.9", "prod_missing"), map);
    expect(unknown.customer.subscriptions).toEqual([]);
    expect(unknown.problems[0]!.kind).toBe("skipped");
    expect(() => parseTokenCsv("order_id,other\nx,y")).toThrow(/purchase_token/);
  });
});
