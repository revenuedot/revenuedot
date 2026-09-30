import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { CustomerInfoSchema } from "../src/sdk-schemas.js";
import { spec, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const P = "/v2/projects/{project_id}";
const NOW = new Date("2026-09-01T12:00:00Z").getTime();
const DAY = 86_400_000;

async function scenario(json: Record<string, unknown>) {
  const r = await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "seed_user", product_id: "pro_monthly", price: 9.99, ...json } });
  if (r.status === 201 && spec) {
    expect(spec.check("GET", `${P}/customers/{customer_id}`, 200, r.body.customer)).toBeNull();
    if (r.body.subscription) expect(spec.check("GET", `${P}/subscriptions/{subscription_id}`, 200, r.body.subscription)).toBeNull();
    if (r.body.purchase) expect(spec.check("GET", `${P}/purchases/{purchase_id}`, 200, r.body.purchase)).toBeNull();
  }
  return r;
}
const eventsOf = async (token: string) => (await h.db.select().from(schema.events).orderBy(asc(schema.events.eventTimestampMs), asc(schema.events.createdAt)))
  .map((e) => (e.payload as { event: Record<string, any> }).event).filter((e) => e.original_transaction_id === token);

describe("POST /v2/projects/{id}/test_purchases scenarios", () => {
  it("purchase (default) and trial", async () => {
    let r = await scenario({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ scenario: "purchase", event_types: ["INITIAL_PURCHASE"], subscription: { status: "active", auto_renewal_status: "will_renew" } });
    r = await scenario({ app_user_id: "trialer", scenario: "trial" });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE"], subscription: { status: "trialing", current_period_ends_at: NOW + 7 * DAY } });
    expect((await eventsOf(r.body.store_transaction_id))[0]).toMatchObject({ period_type: "TRIAL", price: 0 });
  });

  it("trial_conversion: the trial a week ago, then RENEWAL with is_trial_conversion and the paid price", async () => {
    const r = await scenario({ scenario: "trial_conversion" });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE", "RENEWAL"], subscription: { status: "active", current_period_starts_at: NOW } });
    const [trial, renewal] = await eventsOf(r.body.store_transaction_id);
    expect(trial).toMatchObject({ period_type: "TRIAL", event_timestamp_ms: NOW - 7 * DAY });
    expect(renewal).toMatchObject({ is_trial_conversion: true, period_type: "NORMAL", price: 9.99, event_timestamp_ms: NOW });
    const txns = await h.db.select().from(schema.transactions).orderBy(asc(schema.transactions.purchasedAt));
    expect(txns.map((t) => [t.kind, t.revenueUsd])).toEqual([["trial", 0], ["renewal", 9.99]]);
  });

  it("renewal: every period from offset_days ago until now renews, each at its own time", async () => {
    const r = await scenario({ scenario: "renewal", offset_days: 65 });
    expect(r.body.event_types).toEqual(["INITIAL_PURCHASE", "RENEWAL", "RENEWAL"]);
    const evs = await eventsOf(r.body.store_transaction_id);
    expect(evs.map((e) => e.purchased_at_ms)).toEqual([NOW - 65 * DAY, Date.parse("2026-07-28T12:00:00Z"), Date.parse("2026-08-28T12:00:00Z")]);
    expect(r.body.subscription).toMatchObject({ status: "active", total_revenue_in_usd: { gross: 29.97 } });
    // Default: one period ago, so exactly one renewal now.
    expect((await scenario({ app_user_id: "one", scenario: "renewal" })).body.event_types).toEqual(["INITIAL_PURCHASE", "RENEWAL"]);
    expect((await scenario({ app_user_id: "short", scenario: "renewal", offset_days: 3 })).body).toMatchObject({ type: "parameter_error", param: "scenario" });
  });

  it("cancel: CANCELLATION(UNSUBSCRIBE) now, access until the period end", async () => {
    const r = await scenario({ scenario: "cancel", offset_days: 10 });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE", "CANCELLATION"], subscription: { gives_access: true, auto_renewal_status: "will_not_renew" } });
    expect((await eventsOf(r.body.store_transaction_id))[1]).toMatchObject({ cancel_reason: "UNSUBSCRIBE", price: 0 });
  });

  it("billing_issue: BILLING_ISSUE and CANCELLATION(BILLING_ERROR) with a week of grace; EXPIRATION(BILLING_ERROR) once grace is over", async () => {
    let r = await scenario({ scenario: "billing_issue" });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION"], subscription: { status: "in_grace_period", gives_access: true } });
    const billing = (await eventsOf(r.body.store_transaction_id))[1]!;
    expect(billing.grace_period_expiration_at_ms).toBe(NOW + 7 * DAY);
    r = await scenario({ app_user_id: "lapsed", scenario: "billing_issue", offset_days: 40 });
    expect(r.body.event_types).toEqual(["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION", "EXPIRATION"]);
    const exp = (await eventsOf(r.body.store_transaction_id))[3]!;
    expect(exp).toMatchObject({ expiration_reason: "BILLING_ERROR", event_timestamp_ms: Date.parse("2026-08-30T12:00:00Z") });
    expect(r.body.subscription.gives_access).toBe(false);
  });

  it("refund: CANCELLATION(CUSTOMER_SUPPORT) with a negative price for a subscription and a one-time purchase", async () => {
    let r = await scenario({ scenario: "refund", offset_days: 2 });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE", "CANCELLATION"], subscription: { gives_access: false } });
    expect((await eventsOf(r.body.store_transaction_id))[1]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -9.99 });
    r = await scenario({ app_user_id: "buyer", product_id: "lifetime", scenario: "refund", price: 49.99 });
    expect(r.body).toMatchObject({ event_types: ["NON_RENEWING_PURCHASE", "CANCELLATION"], purchase: { status: "refunded" } });
  });

  it("expire: auto-renew off and access over: EXPIRATION(UNSUBSCRIBE) at the period end, or now for a shorter offset", async () => {
    let r = await scenario({ scenario: "expire" });
    expect(r.body).toMatchObject({ event_types: ["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"], subscription: { status: "expired", gives_access: false } });
    r = await scenario({ app_user_id: "early", scenario: "expire", offset_days: 5 });
    expect(r.body.event_types).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
    expect((await eventsOf(r.body.store_transaction_id))[2]).toMatchObject({ expiration_reason: "UNSUBSCRIBE", expiration_at_ms: NOW });
  });

  it("rejects scenarios that do not fit the product, offsets and purchased_at together, and the future", async () => {
    expect((await scenario({ product_id: "coins_100", scenario: "trial" })).body).toMatchObject({ type: "parameter_error", param: "scenario" });
    expect((await scenario({ scenario: "renewal", offset_days: 40, purchased_at: NOW })).body).toMatchObject({ type: "parameter_error", param: "offset_days" });
    expect((await scenario({ purchased_at: NOW + DAY })).body).toMatchObject({ type: "parameter_error", param: "purchased_at" });
    expect((await scenario({ scenario: "nope" })).body).toMatchObject({ type: "parameter_error", param: "scenario" });
  });
});

describe("first seen of a customer created by an older purchase", () => {
  it("a customer created by a scenario was first seen at the first purchase", async () => {
    const r = await scenario({ app_user_id: "old_timer", scenario: "renewal", offset_days: 65 });
    expect(r.body.customer.first_seen_at).toBe(NOW - 65 * DAY);
    // An existing customer keeps its first-seen date.
    await h.fetch("/v1/subscribers/existing");
    const again = await scenario({ app_user_id: "existing", offset_days: 90 });
    expect(again.body.customer.first_seen_at).toBe(NOW);
  });

  it("a customer created by a receipt post of an older transaction was first seen at that purchase", async () => {
    const old = NOW - 200 * DAY;
    const res = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "restorer", fetch_token: `test_${old}_${crypto.randomUUID()}`, product_id: "lifetime" } });
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.first_seen).toBe(new Date(old).toISOString().replace(".000", ""));
    const [c] = await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "restorer"));
    expect(c!.firstSeen.getTime()).toBe(old);
  });
});
