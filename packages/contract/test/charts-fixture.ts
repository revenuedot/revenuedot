import { expect } from "vitest";
import { schema } from "@revenuedot/db";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import type { VerifiedPurchase } from "@revenuedot/server/stores/types.js";
import type { Harness } from "../src/harness.js";
import { buy } from "./v2-helpers.js";

/**
 * The purchase history behind the chart tests (v2-charts.test.ts, charts-sql.test.ts). App Store and Google Play
 * purchases go through the purchase pipeline with the clock set back, exactly as store notifications on those days would.
 *
 *   u_a  App Store monthly $10 from May 10, renewed Jun 10, Jul 10, Aug 10 (active; app opened Aug 15)
 *   u_b  App Store 7-day trial Jul 1, converts Jul 8, renewed Aug 8 (active, GB); saw a paywall on Jul 1
 *   u_c  App Store trial Aug 1–8, turned auto-renew off on Aug 3, never converted
 *   u_d  App Store annual $120 on Jun 15, refund requested Jun 18 and granted Jun 20
 *   u_e  App Store monthly Jun 5, renewed Jul 5, cancelled Jul 20, lapsed Aug 5
 *   u_g  App Store one-time purchase $5 on Aug 20
 *   u_p  Google Play monthly $10 on Aug 2, cancelled Aug 12 ("cost related")
 *   u_x  no purchase: saw a paywall Aug 10, started a purchase and cancelled it
 *   u_s  Test Store (sandbox) monthly $9.99 on Aug 30
 * Plus ad events for u_a on Aug 15 and three Customer Center survey answers. Now is 2026-09-01T12:00Z.
 */
export const NOW = new Date("2026-09-01T12:00:00Z");
const DAY = 86_400_000;
export const d = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
const addMonths = (x: Date, n: number) => { const y = new Date(x); y.setUTCMonth(y.getUTCMonth() + n); return y; };

async function chain(h: Harness, user: string, o: { store?: "app_store" | "play_store"; product: string; plan?: string; start: string; trialDays?: number; periods: number; months: number; price: number; country: string;
  cancelAt?: string; refundAt?: string; survey?: string }) {
  const app = o.store === "play_store" ? "app_play" : "app_ios";
  const start = d(o.start);
  h.setNow(start);
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, start);
  const key = `${user}_key`;
  const base = { kind: "subscription", store: o.store ?? "app_store", storeKey: key, productIdentifier: o.product, productPlanIdentifier: o.plan ?? null, isSandbox: false,
    originalPurchaseDate: start, originalTransactionId: key, countryCode: o.country } as const;
  const steps: { at: Date; p: Record<string, unknown> }[] = [];
  let at = start;
  if (o.trialDays) {
    const end = new Date(start.getTime() + o.trialDays * DAY);
    steps.push({ at, p: { ...base, purchaseDate: at, expiresDate: end, periodType: "trial", storeTransactionId: `${key}_0`, price: { amount: 0, currency: "USD" } } });
    at = end;
  }
  for (let i = 1; i <= o.periods; i++) {
    const end = addMonths(at, o.months);
    steps.push({ at, p: { ...base, purchaseDate: at, expiresDate: end, periodType: "normal", storeTransactionId: `${key}_${i}`, price: { amount: o.price, currency: "USD" } } });
    at = end;
  }
  const ctx = (now: Date) => ({ projectId: "proj1", appId: app, appUserId: user, now, fromDevice: false });
  for (const s of steps) { h.setNow(s.at); await applyPurchases(h.db, customer, [s.p as unknown as VerifiedPurchase], ctx(s.at)); }
  let last = steps[steps.length - 1]!.p;
  if (o.cancelAt) { const t = d(o.cancelAt); h.setNow(t); last = { ...last, unsubscribeDetectedAt: t, cancelSurveyReason: o.survey ?? null }; await applyPurchases(h.db, customer, [last as unknown as VerifiedPurchase], ctx(t)); }
  if (o.refundAt) { const t = d(o.refundAt); h.setNow(t); await applyPurchases(h.db, customer, [{ ...last, refundedAt: t } as unknown as VerifiedPurchase], ctx(t)); }
  return customer;
}

/** A JWS whose payload we can read (the chart loader does not re-verify notifications). */
const jws = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const refundNote = async (h: Harness, id: string, type: string, transactionId: string, at: string, environment = "production") =>
  h.db.insert(schema.storeNotifications).values({ id, projectId: "proj1", appId: "app_ios", store: "app_store", type, environment, receivedAt: d(at),
    body: JSON.stringify({ signedPayload: jws({ notificationType: type, data: { signedTransactionInfo: jws({ transactionId }) } }) }) });

export async function seedChartsHistory(h: Harness) {
  await chain(h, "u_a", { product: "pro_monthly", start: "2026-05-10", periods: 4, months: 1, price: 10, country: "US" });
  await chain(h, "u_b", { product: "pro_monthly", start: "2026-07-01", trialDays: 7, periods: 2, months: 1, price: 10, country: "GB" });
  await chain(h, "u_c", { product: "pro_monthly", start: "2026-08-01", trialDays: 7, periods: 0, months: 1, price: 10, country: "US", cancelAt: "2026-08-03" });
  await chain(h, "u_d", { product: "pro_annual", start: "2026-06-15", periods: 1, months: 12, price: 120, country: "US", refundAt: "2026-06-20" });
  await chain(h, "u_e", { product: "pro_monthly", start: "2026-06-05", periods: 2, months: 1, price: 10, country: "US", cancelAt: "2026-07-20" });
  await chain(h, "u_p", { store: "play_store", product: "pro", plan: "monthly", start: "2026-08-02", periods: 1, months: 1, price: 10, country: "US", cancelAt: "2026-08-12", survey: "CANCEL_SURVEY_REASON_COST_RELATED" });
  h.setNow(d("2026-08-20"));
  const { customer: g } = await getOrCreateCustomer(h.db, "proj1", "u_g", h.now());
  await applyPurchases(h.db, g, [{ kind: "non_subscription", store: "app_store", productIdentifier: "coins_100", storeTransactionId: "g_coins", isSandbox: false, isConsumable: true, purchaseDate: h.now(), price: { amount: 5, currency: "USD" }, countryCode: "US" } as VerifiedPurchase],
    { projectId: "proj1", appId: "app_ios", appUserId: "u_g", now: h.now(), fromDevice: false });
  // The app opens: u_x on Aug 10 (creates the customer), u_a on Aug 15.
  h.setNow(d("2026-08-10T09:00:00Z"));
  await h.fetch("/v1/subscribers/u_x");
  h.setNow(d("2026-08-15T09:00:00Z"));
  await h.fetch("/v1/subscribers/u_a");
  h.setNow(d("2026-08-30T10:00:00Z"));
  await buy(h, "u_s", "pro_monthly", h.now(), 9.99);
  await refundNote(h, "n1", "CONSUMPTION_REQUEST", "u_d_key_1", "2026-06-18T10:00:00Z");
  await refundNote(h, "n2", "REFUND", "u_d_key_1", "2026-06-20T00:00:00Z");
  await refundNote(h, "n3", "CONSUMPTION_REQUEST", "u_a_key_3", "2026-08-31T10:00:00Z");
  await refundNote(h, "n4", "CONSUMPTION_REQUEST", "u_a_key_2", "2026-07-20T10:00:00Z", "sandbox");

  h.setNow(NOW);
  const ev = (type: string, user: string, at: string, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, app_user_id: user, timestamp: d(at).getTime(), ...extra });
  const events = [
    ev("paywall_impression", "u_b", "2026-07-01T08:00:00Z", { paywall_id: "pw_main", session_id: "s1", offering_id: "default" }),
    ev("paywall_impression", "u_x", "2026-08-10T09:00:00Z", { paywall_id: "pw_main", session_id: "s2", offering_id: "default" }),
    ev("paywall_purchase_initiated", "u_x", "2026-08-10T09:01:00Z", { paywall_id: "pw_main", session_id: "s2" }),
    ev("paywall_cancel", "u_x", "2026-08-10T09:02:00Z", { paywall_id: "pw_main", session_id: "s2" }),
    ...[1, 2, 3, 4].map((i) => ({ ...ev("rc_ads_ad_displayed", "u_a", `2026-08-15T10:0${i}:00Z`), timestamp: undefined, timestamp_ms: d(`2026-08-15T10:0${i}:00Z`).getTime() })),
    ...[1, 2, 3, 4].map((i) => ev("rc_ads_ad_loaded", "u_a", `2026-08-15T10:0${i}:00Z`)),
    ev("rc_ads_ad_failed_to_load", "u_a", "2026-08-15T10:05:00Z"),
    ev("rc_ads_ad_opened", "u_a", "2026-08-15T10:06:00Z"),
    ev("rc_ads_ad_revenue", "u_a", "2026-08-15T10:01:00Z", { revenue_micros: 10_000, currency: "USD", precision: "estimated" }),
    ev("rc_ads_ad_revenue", "u_a", "2026-08-15T10:02:00Z", { revenue_micros: 10_000, currency: "USD", precision: "estimated" }),
    ev("customer_center_survey_option_chosen", "u_e", "2026-07-20T09:00:00Z", { survey_option_id: "too_expensive", is_sandbox: false }),
    ev("customer_center_survey_option_chosen", "u_c", "2026-08-03T09:00:00Z", { survey_option_id: "too_expensive", is_sandbox: false }),
    ev("customer_center_survey_option_chosen", "u_a", "2026-08-16T09:00:00Z", { survey_option_id: "other", is_sandbox: false }),
  ];
  const posted = await h.fetch("/v1/events", { method: "POST", json: { events } });
  expect(posted.status).toBe(200);
  // A resent batch is stored once.
  await h.fetch("/v1/events", { method: "POST", json: { events } });
}
