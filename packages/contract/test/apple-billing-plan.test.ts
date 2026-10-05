import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { defaultStores } from "@revenuedot/server";
import { createAppleStore, setAppleRootsForTesting } from "@revenuedot/server/stores/apple/index.js";
import type { AppleTransaction } from "@revenuedot/server/stores/apple/map.js";
import {
  DAY, T0, makeP8, makePki, makeReceipt, mockAppleApi, notificationBody, renewalInfo, signJws, transaction, type Pki,
} from "../../../apps/server/test/apple-fixtures.js";
import { harness, type Harness } from "../src/harness.js";
import { ProductEntitlementMappingSchema } from "../src/sdk-schemas.js";
import { iosLookup, type Mapping } from "../src/offline-sdk.js";

/**
 * App Store billing plans (iOS 26.4) end to end against a stubbed App Store (prd/offline-entitlements/PRD.md): signed
 * StoreKit 2 transactions carrying Apple's `billingPlanType` go through POST /v1/receipts, App Store Server Notifications
 * and the App Store Server API, and the entitlements customer info grants online equal the ones the iOS SDK computes
 * offline from GET /v1/product_entitlement_mapping for the same transaction.
 */
let pki: Pki;
let h: Harness;
let api: ReturnType<typeof mockAppleApi>;
let apiData: Parameters<typeof mockAppleApi>[0];

beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
beforeEach(async () => {
  apiData = {};
  api = mockAppleApi(new Proxy({}, { get: (_, k) => (apiData as Record<string | symbol, unknown>)[k] }) as Parameters<typeof mockAppleApi>[0]);
  h = await harness({ stores: { ...defaultStores(), app_store: createAppleStore({ fetch: api.fetch, now: () => h.now() }) } });
  // app_ios already sells pro_monthly and pro_annual (entitlement pro). Billing-plan products: max only with plans,
  // plus both bare and with the monthly plan.
  const ents = [["ent_max", "max"], ["ent_plus", "plus"], ["ent_plus_extra", "plus_extra"]] as const;
  await h.db.insert(schema.entitlements).values(ents.map(([id, key]) => ({ id, projectId: "proj1", lookupKey: key, displayName: key })));
  const prods: [string, string, string[]][] = [
    ["bp1", "max:monthly", ["ent_max"]], ["bp2", "max:upFront", ["ent_max", "ent_pro"]], ["bp3", "plus", ["ent_plus"]], ["bp4", "plus:monthly", ["ent_plus_extra"]],
  ];
  for (const [i, [id, storeId, es]] of prods.entries()) {
    await h.db.insert(schema.products).values({ id, projectId: "proj1", appId: "app_ios", storeIdentifier: storeId, type: "subscription", duration: "P1M", displayName: storeId, createdAt: new Date(T0 + i) });
    await h.db.insert(schema.entitlementProducts).values(es.map((entitlementId) => ({ entitlementId, productId: id })));
  }
});
afterEach(async () => { await h.close(); });

const mapping = async (): Promise<Mapping> =>
  ProductEntitlementMappingSchema.parse(await (await h.fetch("/v1/product_entitlement_mapping")).json()).product_entitlement_mapping;
const post = (user: string, fetchToken: string) => h.fetch("/v1/receipts", {
  method: "POST", headers: { "X-Platform": "iOS" }, json: { app_user_id: user, fetch_token: fetchToken, is_restore: false, observer_mode: false, initiation_source: "purchase" },
});
const info = async (user: string) => (await (await h.fetch(`/v1/subscribers/${user}`)).json()).subscriber;
/** Active entitlement identifiers in customer info, as the SDK reads them (expires_date after the request date). */
const activeOnline = (subscriber: any) =>
  Object.entries(subscriber.entitlements as Record<string, { expires_date: string | null }>)
    .filter(([, e]) => e.expires_date === null || Date.parse(e.expires_date) > h.now().getTime()).map(([k]) => k).sort();
/** The StoreKit `Transaction.billingPlanType` the device sees for an App Store Server API value, as iOS names it. */
const storeKitPlan = (t?: string) => (t === "MONTHLY" ? "monthly" : t === "BILLED_UPFRONT" ? "upFront" : undefined);

describe("App Store billing plans: online entitlements equal offline ones", () => {
  it("POST /v1/receipts with a StoreKit 2 transaction records the plan and unlocks what iOS unlocks offline", async () => {
    const m = await mapping();
    const cases: [string, string | undefined, string[]][] = [
      ["max", "MONTHLY", ["max"]], ["max", "BILLED_UPFRONT", ["max", "pro"]], ["max", undefined, ["max", "pro"]],
      ["plus", "MONTHLY", ["plus", "plus_extra"]], ["plus", "BILLED_UPFRONT", ["plus"]], ["plus", undefined, ["plus"]],
    ];
    for (const [i, [productId, billingPlanType, want]] of cases.entries()) {
      const user = `bp_user_${i}`;
      const tx = transaction({ transactionId: `30000000${i}`, productId, ...(billingPlanType ? { billingPlanType } : {}) });
      const res = await post(user, await signJws(tx, pki));
      expect(res.status, `${productId} ${billingPlanType}`).toBe(200);
      const sub = (await res.json()).subscriber;
      expect(activeOnline(sub), `${productId} ${billingPlanType}`).toEqual(want);
      expect(activeOnline(sub), `${productId} ${billingPlanType}`).toEqual(iosLookup(m, productId, storeKitPlan(billingPlanType)));
      // The plan is reported the way the iOS SDK documents productPlanIdentifier: only for a non-up-front billing plan.
      expect(sub.subscriptions[productId].product_plan_identifier).toBe(billingPlanType === "MONTHLY" ? "monthly" : undefined);
      for (const e of want) expect(sub.entitlements[e].product_plan_identifier).toBe(billingPlanType === "MONTHLY" ? "monthly" : undefined);
      // The INITIAL_PURCHASE webhook names the same entitlements (an up-front `max` matches `max:upFront`).
      const ev = (await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE"))).map((e) => e.payload.event as Record<string, unknown>).find((e) => e.app_user_id === user);
      expect([...((ev?.entitlement_ids ?? []) as string[])].sort(), `${productId} ${billingPlanType} webhook`).toEqual(want);
    }
  });

  it("a bare product keeps unlocking online for a monthly billing plan purchase", async () => {
    const res = await post("bp_bare", await signJws(transaction({ transactionId: "300000100", productId: "pro_monthly", billingPlanType: "MONTHLY" }), pki));
    const sub = (await res.json()).subscriber;
    expect(activeOnline(sub)).toEqual(["pro"]);
    expect(sub.entitlements.pro).toMatchObject({ product_identifier: "pro_monthly", product_plan_identifier: "monthly" });
    // Offline too: iOS looks the purchase up as pro_monthly:monthly, which the mapping adds for every bare subscription.
    expect(iosLookup(await mapping(), "pro_monthly", "monthly")).toEqual(["pro"]);
  });

  it("App Store Server Notifications: a renewal on the monthly plan moves the chain to the plan's entitlements", async () => {
    const first: AppleTransaction = transaction({ transactionId: "300000200", productId: "max" });
    expect((await post("bp_notify", await signJws(first, pki))).status).toBe(200);
    expect(activeOnline(await info("bp_notify"))).toEqual(["max", "pro"]);
    const renewed = transaction({
      transactionId: "300000201", originalTransactionId: "300000200", productId: "max", purchaseDate: T0 + 30 * DAY, expiresDate: T0 + 60 * DAY,
      signedDate: T0 + 30 * DAY, billingPlanType: "MONTHLY",
    });
    h.setNow(new Date(T0 + 30 * DAY));
    const body = await notificationBody(pki, "DID_RENEW", undefined, renewed, renewalInfo({ originalTransactionId: "300000200", productId: "max", autoRenewProductId: "max", renewalBillingPlanType: "MONTHLY" }), { signedDate: T0 + 30 * DAY });
    expect((await h.fetch("/v1/notifications/apple/app_ios", { key: "", method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(200);
    const sub = await info("bp_notify");
    expect(sub.subscriptions.max).toMatchObject({ product_plan_identifier: "monthly", store_transaction_id: "300000201" });
    expect(activeOnline(sub)).toEqual(["max"]);
    expect(activeOnline(sub)).toEqual(iosLookup(await mapping(), "max", "monthly"));
  });

  it("the App Store Server API (history and subscription status) records the plan for a StoreKit 1 receipt", async () => {
    await h.db.update(schema.apps).set({ credentials: { key_id: "KEY123", issuer_id: "issuer-uuid", private_key: await makeP8() } }).where(eq(schema.apps.id, "app_ios"));
    const tx = transaction({ transactionId: "300000301", originalTransactionId: "300000300", productId: "plus", billingPlanType: "MONTHLY" });
    apiData.production = {
      transactions: [await signJws(tx, pki)],
      statuses: { data: [{ subscriptionGroupIdentifier: "g1", lastTransactions: [{ originalTransactionId: "300000300", status: 1, signedTransactionInfo: await signJws(tx, pki), signedRenewalInfo: await signJws(renewalInfo({ originalTransactionId: "300000300", productId: "plus", autoRenewProductId: "plus", renewalBillingPlanType: "MONTHLY" }), pki) }] }] },
    };
    const receipt = makeReceipt({ inApp: [{ productId: "plus", transactionId: "300000301", originalTransactionId: "300000300", purchaseDate: "2026-09-01T12:00:00Z", expiresDate: "2026-10-01T12:00:00Z" }] });
    const res = await post("bp_api", receipt);
    expect(res.status).toBe(200);
    const sub = (await res.json()).subscriber;
    expect(api.calls.map((c) => c.path.split("?")[0])).toEqual(["/inApps/v2/history/300000301", "/inApps/v1/subscriptions/300000301"]);
    expect(sub.subscriptions.plus).toMatchObject({ product_plan_identifier: "monthly", store_transaction_id: "300000301" });
    expect(activeOnline(sub)).toEqual(["plus", "plus_extra"]);
    expect(activeOnline(sub)).toEqual(iosLookup(await mapping(), "plus", "monthly"));
  });
});
