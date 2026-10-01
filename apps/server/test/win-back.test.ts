import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "../src/services/auth.js";
import { readPage } from "../src/services/exports/tables.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { offerOf as appleOfferOf } from "../src/stores/apple/map.js";
import { mapSubscription, offerOf as googleOfferOf } from "../src/stores/google/map.js";
import { loadSpec } from "../../../packages/contract/src/openapi.js";
import { DAY, T0, appleHarness, makeP8, makePki, mockAppleApi, notificationBody, renewalInfo, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import { sub } from "./google-helpers.js";

/**
 * Win-back offers (prd/win-back-offers/PRD.md): the SDK does the offer on the device; the server records which offer each
 * period used, sends it as `offer_code`, exports it, and keeps Apple's eligible win-back offer ids from the renewal info.
 */
let pki: Pki;
let h: AppleHarness | undefined;
beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { await h?.close(); h = undefined; });

const lapsed = () => transaction({ transactionId: "2000000001", purchaseDate: T0 - 60 * DAY, originalPurchaseDate: T0 - 60 * DAY, expiresDate: T0 - 30 * DAY });
const winBack = (over: Record<string, unknown> = {}) => transaction({
  transactionId: "2000000007", originalTransactionId: "2000000001", purchaseDate: T0, originalPurchaseDate: T0 - 60 * DAY, expiresDate: T0 + 30 * DAY,
  offerType: 4, offerIdentifier: "comeback_50", offerDiscountType: "PAY_AS_YOU_GO", price: 4990, ...over,
});

describe("a lapsed App Store customer comes back on a win-back offer", () => {
  it("through the app: active again, RENEWAL with offer_code, and the transaction and its export row say win_back", async () => {
    h = await appleHarness();
    await h.postReceipt("returning", await signJws(lapsed(), pki));
    expect((await h.customerInfo("returning")).subscriber.entitlements.pro.expires_date).toBe(new Date(T0 - 30 * DAY).toISOString().replace(".000", ""));
    await h.newEvents();

    const res = await h.postReceipt("returning", await signJws(winBack(), pki), { product_id: "pro_monthly", price: 4.99, currency: "USD" });
    expect(res.status).toBe(200);
    const info = await res.json() as any;
    expect(info.subscriber.subscriptions.pro_monthly).toMatchObject({ period_type: "normal", store_transaction_id: "2000000007", expires_date: new Date(T0 + 30 * DAY).toISOString().replace(".000", "") });
    const events = await h.newEvents();
    expect(events.map((e) => e.type)).toEqual(["RENEWAL"]);
    expect(events[0]).toMatchObject({ offer_code: "comeback_50", period_type: "NORMAL", price_in_purchased_currency: 4.99, original_transaction_id: "2000000001", transaction_id: "2000000007" });

    const [sub] = await h.db.select().from(schema.subscriptions);
    expect(sub).toMatchObject({ offerType: "win_back", offerId: "comeback_50" });
    const txs = await h.db.select().from(schema.transactions).where(eq(schema.transactions.storeTransactionId, "2000000007"));
    expect(txs.map((t) => [t.kind, t.offerType, t.offerId])).toEqual([["renewal", "win_back", "comeback_50"]]);
    const { rows } = await readPage(h.db, "proj1", "transactions", { since: null, until: new Date(T0 + DAY), environment: "both" }, null);
    expect(rows.map((r) => [r.store_transaction_id, r.offer, r.offer_type])).toEqual(expect.arrayContaining([["2000000001", null, null], ["2000000007", "comeback_50", "win_back"]]));
  });

  it("a free win-back period is a TRIAL with offer type win_back", async () => {
    h = await appleHarness();
    await h.postReceipt("free_back", await signJws(lapsed(), pki));
    await h.newEvents();
    await h.postReceipt("free_back", await signJws(winBack({ offerIdentifier: "free_month", offerDiscountType: "FREE_TRIAL", price: 0 }), pki));
    expect((await h.customerInfo("free_back")).subscriber.subscriptions.pro_monthly.period_type).toBe("trial");
    expect((await h.newEvents())[0]).toMatchObject({ type: "RENEWAL", period_type: "TRIAL", offer_code: "free_month" });
  });

  it("redeemed in the App Store without opening the app (streamlined purchasing): the RESUBSCRIBE notification reaches the same customer", async () => {
    h = await appleHarness();
    await h.postReceipt("streamlined", await signJws(lapsed(), pki));
    await h.newEvents();
    const res = await h.notify(await notificationBody(pki, "SUBSCRIBED", "RESUBSCRIBE", winBack(), renewalInfo({ originalTransactionId: "2000000001", autoRenewStatus: 1 })));
    expect(res.status).toBe(200);
    const events = await h.newEvents();
    expect(events.map((e) => [e.type, e.app_user_id, e.offer_code])).toEqual([["RENEWAL", "streamlined", "comeback_50"]]);
    expect((await h.customerInfo("streamlined")).subscriber.entitlements.pro.expires_date).toBe(new Date(T0 + 30 * DAY).toISOString().replace(".000", ""));
  });
});

describe("win-back eligibility from Apple's renewal info", () => {
  it("is stored when RevenueDot reads the renewal info and readable through the v2 extension", async () => {
    const tx = lapsed();
    const renewal = renewalInfo({ originalTransactionId: "2000000001", autoRenewStatus: 0, expirationIntent: 1, eligibleWinBackOfferIds: ["comeback_50", "free_month"] });
    const api = mockAppleApi({
      production: {
        transactions: [await signJws(tx, pki)],
        statuses: { data: [{ subscriptionGroupIdentifier: "g1", lastTransactions: [{ originalTransactionId: "2000000001", status: 2, signedTransactionInfo: await signJws(tx, pki), signedRenewalInfo: await signJws(renewal, pki) }] }] },
      },
    });
    h = await appleHarness({ credentials: { key_id: "ABC123", issuer_id: "issuer", private_key: await makeP8() }, fetch: api.fetch });
    expect((await h.postReceipt("lapsed_user", await signJws(tx, pki))).status).toBe(200);
    const { key } = await createSecretKey(h.db, "proj1", "support");
    const get = async (user: string) => {
      const res = await h!.request(`/v2/projects/proj1/customers/${user}/win_back_offers`, { headers: { Authorization: `Bearer ${key}` } });
      return { status: res.status, body: await res.json() as any };
    };
    const r = await get("lapsed_user");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "list", next_page: null, url: "/v2/projects/proj1/customers/lapsed_user/win_back_offers" });
    expect(r.body.items).toEqual([{ object: "win_back_offer_eligibility", subscription_id: expect.stringMatching(/^sub_/), product_id: "pro_monthly", store: "app_store", offer_ids: ["comeback_50", "free_month"], updated_at: T0 }]);
    expect((await get("nobody")).status).toBe(404);

    // Every read of the renewal info replaces the stored list.
    await h.db.update(schema.subscriptions).set({ eligibleWinBackOfferIds: ["stale"] });
    await h.postReceipt("lapsed_user", await signJws(winBack(), pki));
    expect((await get("lapsed_user")).body.items[0].offer_ids).toEqual(["comeback_50", "free_month"]);
  });
});

describe("offer classification", () => {
  it("App Store offerType: 1 free_trial or introductory, 2 promotional, 3 offer_code, 4 win_back", () => {
    expect(appleOfferOf({})).toEqual({ offerType: null, offerId: null });
    expect(appleOfferOf({ offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 })).toEqual({ offerType: "free_trial", offerId: null });
    expect(appleOfferOf({ offerType: 1, offerDiscountType: "PAY_UP_FRONT", price: 1990 })).toEqual({ offerType: "introductory", offerId: null });
    expect(appleOfferOf({ offerType: 2, offerIdentifier: "loyal", price: 490 })).toEqual({ offerType: "promotional", offerId: "loyal" });
    expect(appleOfferOf({ offerType: 3, offerIdentifier: "SPRING", price: 0 })).toEqual({ offerType: "offer_code", offerId: "SPRING" });
    expect(appleOfferOf({ offerType: 4, offerIdentifier: "comeback_50", price: 4990 })).toEqual({ offerType: "win_back", offerId: "comeback_50" });
  });

  it("Google Play: the phase names the offer, a renewal order without a phase is unspecified, the base price is no offer", () => {
    const start = new Date(T0), expiry = new Date(T0 + 30 * DAY);
    const s = (over: Record<string, unknown>, order = "GPA.1-2-3-4") => {
      const x = sub({ start, expiry, order, offerId: "winback-3m" });
      Object.assign(x.lineItems![0]!, over);
      return x;
    };
    expect(googleOfferOf(s({ offerPhase: { freeTrial: {} } }), "GPA.1-2-3-4")).toEqual({ offerType: "free_trial", offerId: "winback-3m" });
    expect(googleOfferOf(s({ offerPhase: { introductoryPrice: {} } }), "GPA.1-2-3-4")).toEqual({ offerType: "introductory", offerId: "winback-3m" });
    expect(googleOfferOf(s({ offerPhase: { basePrice: {} } }), "GPA.1-2-3-4")).toEqual({ offerType: null, offerId: null });
    expect(googleOfferOf(s({}, "GPA.1-2-3-4..2"), "GPA.1-2-3-4..2")).toEqual({ offerType: "unspecified", offerId: "winback-3m" });
    expect(googleOfferOf(sub({ start, expiry, order: "GPA.9" }), "GPA.9")).toEqual({ offerType: null, offerId: null });
    const mapped = mapSubscription(s({ offerPhase: { introductoryPrice: {} } }), "tok", { catalog: { productType: () => "subscription", productDuration: () => "P1M" }, now: start });
    expect([mapped.offerType, mapped.offerId, mapped.periodType]).toEqual(["introductory", "winback-3m", "intro"]);
  });
});

describe("the v2 extension is a list, valid as RevenueDot's own shape", () => {
  it("never appears in RevenueCat's spec (it is an extension)", () => {
    const spec = loadSpec();
    if (!spec) return;
    expect(spec.check("GET", "/v2/projects/{project_id}/customers/{customer_id}/win_back_offers", 200, {})).toMatch(/not in the RevenueCat spec/);
  });
});
