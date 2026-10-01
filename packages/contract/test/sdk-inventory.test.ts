// The SDK endpoint inventory in prd/sdk-api/PRD.md is the contract: every row the SDKs can call is sent here with the
// SDK's own request headers, and must answer with the documented status and RevenueCat error code. Absent rows must
// really be unrouted, so the table cannot drift from the server in either direction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { harness, type Harness } from "../src/harness.js";

const PRD = readFileSync(new URL("../../../prd/sdk-api/PRD.md", import.meta.url), "utf8");
const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const IOS_HEADERS = fx("ios/req-post-receipt-sk2-jws.json").headers as Record<string, string>;

interface Row { n: number; method: string; path: string; sdks: string; handling: "Real" | "Stub" | "Absent"; answer: string }

function inventory(): Row[] {
  const block = PRD.split("<!-- inventory:start -->")[1]!.split("<!-- inventory:end -->")[0]!;
  return block.trim().split("\n").slice(2).map((line) => {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    return { n: Number(cells[0]), method: cells[1]!, path: cells[2]!.replace(/`/g, ""), sdks: cells[3]!, handling: cells[4] as Row["handling"], answer: cells[5]! };
  });
}

const rows = inventory();
const routed = rows.filter((r) => r.handling !== "Absent");

/** A concrete URL for a path template. */
const concrete = (template: string) => template
  .replace("{app_user_id}", encodeURIComponent("$RCAnonymousID:inventory"))
  .replace("{client_transaction_id}", "AABBCCDD-1111-2222-3333-444455556666")
  .replace("{domain}", "app").replace("{product_id}", "pro_monthly")
  .replace("{store_user_id}", "amzn1.account.x").replace("{receipt_id}", "hQ8uPyAdwptgdTLKGRhJ_smWRJQs0L0gj-Aejyah8uY=:3:24")
  .replace("{operation_session_id}", "op_session_id").replace("{workflow_id}", "wf_123");

/** Request bodies: the SDK's own, from the upstream request fixtures where one exists. */
const body = (r: Row): unknown => {
  const f: Record<string, string> = {
    "/v1/offers": "ios/req-post-offer-for-signing.json",
    "/v1/subscribers/redeem_purchase": "ios/req-post-redeem-web-purchase.json",
    "/v1/external_purchase_tokens": "ios/req-post-external-purchase-token.json",
    "/rcbilling/v1/hosted-checkout": "ios/req-post-hosted-checkout.json",
    "/v1/subscribers/{app_user_id}/attribution": "ios/req-post-attribution-data.json",
    "/v1/subscribers/{app_user_id}/adservices_attribution": "ios/req-post-adservices-attribution.json",
    "/v1/subscribers/{app_user_id}/intro_eligibility": "ios/req-post-intro-eligibility.json",
    "/v1/subscribers/{app_user_id}/attributes": "ios/req-post-subscriber-attributes.json",
    "/v1/subscribers/{app_user_id}/restore/eligibility": "ios/req-post-restore-eligibility.json",
    "/v1/customercenter/support/create-ticket": "ios/req-post-customer-center-create-ticket.json",
    "/v1/diagnostics": "ios/req-post-diagnostics.json",
    "/v1/events": "ios/req-post-paywall-events.json",
    "/v1/subscribers/identify": "ios/req-login.json",
  };
  // A subscriber-token path sends the body of the /v1/subscribers/{app_user_id} path it stands for.
  const path = r.path.startsWith("/v1/customer/customercenter/") ? r.path.replace("/v1/customer/", "/v1/") : r.path.replace(/^\/v1\/customer\//, "/v1/subscribers/{app_user_id}/");
  if (f[path]) return fx(f[path]!).request.body;
  if (r.path === "/v1/receipts") return { app_user_id: "$RCAnonymousID:inventory", fetch_token: `test_${Date.now()}_inventory`, product_id: "pro_monthly", is_restore: false };
  if (r.path.endsWith("/alias")) return { new_app_user_id: "inventory_alias" };
  if (r.path === "/v1/customer/virtual_currencies/spend") return { adjustments: { GEMS: 1 }, reference: null };
  return r.method === "GET" ? undefined : {};
};

/** The subscriber-token rows (IAM mode) name no app user id: they take an access token from the v2 `authenticate` operation. */
const isIam = (r: Row) => /^\/(rcbilling\/)?v1\/customer(\/|$)/.test(r.path);
let token = "";

/** Test Store keys for the Test Store paths, the Play key for Android-only rows, a subscriber token for IAM rows, the App Store key otherwise. */
const keyFor = (h: Harness, r: Row) =>
  isIam(r) ? token : r.path === "/v1/receipts" ? h.ids.testKey : r.sdks === "Android" ? h.ids.androidKey : h.ids.iosKey;

/** Every status the row documents, with the RevenueCat error code written after it ("400 · 7234"). */
const expected = (r: Row) => {
  const codes = new Map<number, number | null>();
  for (const m of r.answer.matchAll(/\b([1-5]\d{2})\b(?:\s*·\s*(\d{4}))?/g)) codes.set(Number(m[1]), m[2] ? Number(m[2]) : null);
  return codes;
};

let h: Harness;
beforeAll(async () => {
  h = await harness();
  const res = await h.fetch(`/v2/projects/${h.ids.project}/apps/${h.ids.app}/authenticate`, { method: "POST", key: h.ids.secretKey, json: { app_user_id: "$RCAnonymousID:inventory" } });
  token = (await res.json() as { access_token: string }).access_token;
});
afterAll(async () => { await h.close(); });

describe("the SDK endpoint inventory (prd/sdk-api/PRD.md)", () => {
  it("is complete and its counts add up", () => {
    expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => i + 1));
    const real = rows.filter((r) => r.handling === "Real").length, stub = rows.filter((r) => r.handling === "Stub").length;
    const absent = rows.filter((r) => r.handling === "Absent").reduce((n, r) => n + (/^(\d+) IAM/.exec(r.path) ? Number(/^(\d+)/.exec(r.path)![1]) : r.path.split(",").length), 0);
    expect({ real, stub, absent }).toEqual({ real: 28, stub: 27, absent: 3 });
    expect(PRD).toContain(`55 of the 58 method-and-path pairs have a route: 28 answer with real data and 27 are safe stubs. The other 3`);
  });

  for (const r of routed) {
    it(`#${r.n} ${r.method} ${r.path} answers ${r.answer.split(";")[0]}`, async () => {
      const url = concrete(r.path);
      const b = body(r);
      const res = await h.fetch(url, {
        method: r.method, key: keyFor(h, r),
        headers: { ...IOS_HEADERS, ...(r.sdks === "Android" ? { "X-Platform": "android" } : {}), Authorization: "" },
        ...(b === undefined ? {} : { json: b }),
      });
      const want = expected(r);
      expect([...want.keys()], `status ${res.status} is not documented for #${r.n}`).toContain(res.status);
      expect(res.headers.get("x-revenuecat-request-time"), "X-RevenueCat-Request-Time").toMatch(/^\d+$/);
      if (res.status === 204) return;
      // Remote config answers the binary RC Container; every other row answers JSON.
      expect(res.headers.get("content-type")).toMatch(r.path === "/v1/config/{domain}" ? /^application\/x-rc-format/ : /^application\/json/);
      if (r.path === "/v1/config/{domain}") return; // binary; parsed in remote-config.test.ts
      const json = await res.json() as Record<string, unknown>;
      if (res.status >= 400) {
        // A 404 here is a deliberate RevenueCat error with a code, never a missing route.
        expect(typeof json.code, JSON.stringify(json)).toBe("number");
        expect(json.code, `#${r.n} error code`).toBe(want.get(res.status));
      }
    });
  }

  it("absent rows have no route (the IAM identity-provider login), and /auth/login is the dashboard's sign-in", async () => {
    for (const path of ["/auth/token", "/auth/revoke"]) {
      const res = await h.fetch(path, { method: "POST", headers: IOS_HEADERS, json: {} });
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toMatch(/"code"/);
    }
    const login = await h.fetch("/auth/login", { method: "POST", key: "", json: { method: "anonymous" } });
    expect(login.status).not.toBe(404);
  });
});
