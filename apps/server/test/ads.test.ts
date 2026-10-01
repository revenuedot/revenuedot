import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ADMOB_KEYS_URL } from "@revenuedot/core/ads";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { clearAdMobKeys } from "../src/services/ads/admob-ssv.js";
import { fxLookup } from "../src/services/fx.js";
import { tick } from "../src/services/tick.js";

/**
 * Ads (prd/ads/PRD.md): AdMob server-side verification with a generated P-256 key served as Google's verifier keys,
 * reward rules granting in-app currency and temporary entitlements, the SDK's poll, the overview, the AdMob connection
 * against a fake Google, and the Intercom inbox app.
 */

const KEY_ID = "3335741209";
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** WebCrypto signs r‖s; Google sends DER. */
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.slice(i);
    if (v[0]! & 0x80) v = Uint8Array.from([0, ...v]);
    return Uint8Array.from([0x02, v.length, ...v]);
  };
  const r = int(sig.slice(0, 32)), s = int(sig.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let keyFetches = 0;
let keysDown = false;
let google: { token: number; lastTokenBody: string; units: Record<string, unknown>[] };
const calls: string[] = [];

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(url);
  if (url === ADMOB_KEYS_URL) {
    keyFetches++;
    if (keysDown) return new Response("unavailable", { status: 503 });
    const spki = await crypto.subtle.exportKey("spki", keys.publicKey);
    return Response.json({ keys: [{ keyId: Number(KEY_ID), pem: `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----`, base64: b64(spki) }] });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    google.token++;
    google.lastTokenBody = String(init?.body ?? "");
    const p = new URLSearchParams(google.lastTokenBody);
    if (p.get("grant_type") === "authorization_code") return Response.json({ access_token: "ya29.first", refresh_token: "1//refresh-token-value", expires_in: 3599 });
    return Response.json({ access_token: "ya29.refreshed", expires_in: 3599 });
  }
  if (url === "https://admob.googleapis.com/v1/accounts") return Response.json({ account: [{ name: "accounts/pub-9876543210", publisherId: "pub-9876543210", currencyCode: "USD", reportingTimeZone: "America/Los_Angeles" }] });
  if (url.startsWith("https://admob.googleapis.com/v1/accounts/pub-9876543210/adUnits")) {
    const page2 = url.includes("pageToken=p2");
    return Response.json(page2 ? { adUnits: google.units.slice(1) } : { adUnits: google.units.slice(0, 1), nextPageToken: "p2" });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let h: Harness;
beforeEach(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  keyFetches = 0; keysDown = false; calls.length = 0;
  google = { token: 0, lastTokenBody: "", units: [
    { name: "accounts/pub-9876543210/adUnits/111", adUnitId: "ca-app-pub-9876543210/111", appId: "ca-app-pub-9876543210~1", displayName: "Home banner", adFormat: "BANNER" },
    { name: "accounts/pub-9876543210/adUnits/222", adUnitId: "ca-app-pub-9876543210/222", appId: "ca-app-pub-9876543210~1", displayName: "Level end reward", adFormat: "REWARDED" },
  ] };
  clearAdMobKeys();
  h = await harness({
    fetch: fakeFetch, publicUrl: "https://app.example.test", apiUrl: "https://api.example.test",
    encryptionKey: b64(new Uint8Array(32).fill(7)), googleOAuth: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "server-client-secret" },
  });
});
afterEach(async () => { await h.close(); });

const v2 = (path: string, init: { method?: string; json?: unknown } = {}) => h.fetch(`/v2/projects/proj1${path}`, { key: h.ids.secretKey, ...init });
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

/** The SDK's reward verification token (iOS `generateRewardVerificationToken`): sorted keys. */
const customData = (tx: string, apiKey = h.ids.iosKey) => JSON.stringify({ api_key: apiKey, client_transaction_id: tx, impression_id: "imp-1" });

async function callback(o: { tx: string; user?: string; unit?: string; item?: string; amount?: number; networkTx?: string; signer?: CryptoKey; keyId?: string; tamper?: boolean; custom?: string }) {
  const q = [
    "ad_network=5450213213286189855", `ad_unit=${o.unit ?? "1712485313"}`, `custom_data=${encodeURIComponent(o.custom ?? customData(o.tx))}`,
    `reward_amount=${o.amount ?? 10}`, `reward_item=${o.item ?? "coins"}`, `timestamp=${h.now().getTime()}`, `transaction_id=${o.networkTx ?? `gtx-${o.tx}`}`, `user_id=${encodeURIComponent(o.user ?? "wren")}`,
  ].join("&");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.signer ?? keys.privateKey, new TextEncoder().encode(q)));
  const sent = o.tamper ? q.replace("reward_amount=10", "reward_amount=1000") : q;
  return h.fetch(`/v1/ads/admob/ssv?${sent}&signature=${b64url(p1363ToDer(sig))}&key_id=${o.keyId ?? KEY_ID}`, { key: "" });
}
const poll = (user: string, tx: string) => json(h.fetch(`/v1/subscribers/${encodeURIComponent(user)}/ads/reward_verifications/${tx}`));
const balances = async (user: string) => (await json(h.fetch(`/v1/subscribers/${user}/virtual_currencies`))).virtual_currencies;

async function gems() {
  expect((await v2("/virtual_currencies", { method: "POST", json: { code: "GEMS", name: "Gems" } })).status).toBe(201);
}

describe("AdMob server-side verification", () => {
  it("answers Google's Verify URL check, refuses bad signatures and unknown keys, and retries when Google's keys are down", async () => {
    expect((await h.fetch("/v1/ads/admob/ssv", { key: "" })).status).toBe(200);
    expect((await callback({ tx: "T1", tamper: true })).status).toBe(403);
    expect((await callback({ tx: "T1", signer: other.privateKey })).status).toBe(403);
    expect(keyFetches).toBe(1);
    // An unknown key id fetches the keys again once (a rotation), not on every callback.
    h.setNow(new Date(h.now().getTime() + 120_000));
    expect((await callback({ tx: "T1", keyId: "42" })).status).toBe(403);
    expect((await callback({ tx: "T1", keyId: "43" })).status).toBe(403);
    expect(keyFetches).toBe(2);
    expect(await h.db.select().from(schema.adRewardVerifications)).toHaveLength(0);
    clearAdMobKeys();
    keysDown = true;
    expect((await callback({ tx: "T1" })).status).toBe(503);
  });

  it("a verified reward credits the rule's currency once; the SDK's poll goes pending → verified and the balance shows it", async () => {
    await gems();
    const rule = await json(v2("/ads/reward_rules", { method: "POST", json: { name: "Coins", kind: "virtual_currency", currency_code: "GEMS", multiplier: 1 } }));
    expect(rule).toMatchObject({ object: "ad_reward_rule", kind: "virtual_currency", currency_code: "GEMS", multiplier: 1, amount: null, position: 0, enabled: true });
    await h.fetch("/v1/subscribers/wren");
    expect(await poll("wren", "TX-1")).toEqual({ status: "pending" });
    const res = await callback({ tx: "TX-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: true });
    expect(await poll("wren", "TX-1")).toEqual({ status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 10 }, more_rewards: [] });
    // Google retries; the reward is granted once.
    expect((await callback({ tx: "TX-1" })).status).toBe(200);
    expect((await balances("wren")).GEMS).toEqual({ balance: 10, name: "Gems", code: "GEMS", description: null });
    const ledger = await h.db.select().from(schema.virtualCurrencyTransactions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ code: "GEMS", amount: 10, source: "ad_reward", reference: "admob:gtx-TX-1" });
    const [v] = await h.db.select().from(schema.adRewardVerifications);
    expect(v).toMatchObject({ network: "admob", networkTransactionId: "gtx-TX-1", clientTransactionId: "TX-1", appUserId: "wren", adUnitId: "1712485313", rewardItem: "coins", rewardAmount: 10, status: "verified", ruleId: rule.id, impressionId: "imp-1", isSandbox: false, appId: "app_ios" });
    expect(ledger[0]!.sourceKey).toBe(v!.id);
    // The webhook event RevenueCat sends for currency grants, with our ad_reward source.
    const events = await h.db.select().from(schema.events).where(eq(schema.events.type, "VIRTUAL_CURRENCY_TRANSACTION"));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as any).event).toMatchObject({ source: "ad_reward", transaction_id: "gtx-TX-1", adjustments: [{ amount: 10, currency: { code: "GEMS", name: "Gems" } }] });
    // The ledger in the API.
    const list = await json(v2("/ads/reward_verifications"));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ object: "ad_reward_verification", status: "verified", rewards: [{ type: "virtual_currency", code: "GEMS", amount: 10 }], network: "admob" });
  });

  it("an entitlement reward is a promotional grant in customer info that expires on its own", async () => {
    await json(v2("/ads/reward_rules", { method: "POST", json: { name: "A day of Pro", kind: "entitlement", entitlement_id: "pro", duration_minutes: 1440, ad_unit_id: "ca-app-pub-3940256099942544/1712485313" } }));
    expect((await callback({ tx: "TX-2", user: "kai" })).status).toBe(200);
    const answer = await poll("kai", "TX-2");
    expect(answer).toEqual({ status: "verified", reward: { type: "entitlement", identifier: "pro", expires_at: "2026-09-02T12:00:00Z" }, more_rewards: [] });
    const info = await json(h.fetch("/v1/subscribers/kai"));
    expect(info.subscriber.entitlements.pro).toMatchObject({ expires_date: "2026-09-02T12:00:00Z", product_identifier: "rc_promo_pro_ad_reward" });
    h.setNow(new Date("2026-09-02T12:00:01Z"));
    await tick(h.db, h.now(), fakeFetch, { admob: false });
    const later = await json(h.fetch("/v1/subscribers/kai"));
    expect(new Date(later.subscriber.entitlements.pro.expires_date).getTime()).toBeLessThan(h.now().getTime());
  });

  it("verified with no reward when no rule matches; user mismatch, missing user and a vanished currency fail", async () => {
    await gems();
    await json(v2("/ads/reward_rules", { method: "POST", json: { name: "Only gems", kind: "virtual_currency", currency_code: "GEMS", amount: 3, reward_item: "gems" } }));
    await callback({ tx: "TX-3" });
    expect(await poll("wren", "TX-3")).toEqual({ status: "verified", reward: null, more_rewards: [] });
    expect(await poll("someone-else", "TX-3")).toEqual({ status: "failed", failure_reason: "user_mismatch", message: "The ad network's user id is not this customer." });
    await callback({ tx: "TX-4", user: "" });
    expect(await poll("wren", "TX-4")).toMatchObject({ status: "failed", failure_reason: "missing_user" });
    await h.db.update(schema.virtualCurrencies).set({ state: "inactive" }).where(eq(schema.virtualCurrencies.code, "GEMS"));
    await callback({ tx: "TX-5", item: "gems" });
    expect(await poll("wren", "TX-5")).toMatchObject({ status: "failed", failure_reason: "grant_failed" });
    // A token we did not issue is ignored with 200, so Google stops retrying.
    expect(await json(callback({ tx: "TX-6", custom: "level=3" }))).toEqual({ ok: true, recorded: false, reason: "invalid_custom_data" });
    expect(await json(callback({ tx: "TX-7", custom: customData("TX-7", "appl_unknown") }))).toEqual({ ok: true, recorded: false, reason: "unknown_api_key" });
  });

  it("subscriber tokens poll the same verification", async () => {
    await gems();
    await json(v2("/ads/reward_rules", { method: "POST", json: { name: "Gems", kind: "virtual_currency", currency_code: "GEMS", amount: 2 } }));
    await h.fetch("/v1/subscribers/wren");
    await callback({ tx: "TX-8" });
    const auth = await json(v2("/apps/app_ios/authenticate", { method: "POST", json: { app_user_id: "wren" } }));
    const res = await h.fetch("/v1/customer/ads/reward_verifications/TX-8", { key: auth.access_token ?? auth.token });
    expect(await res.json()).toEqual({ status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 2 }, more_rewards: [] });
  });
});

describe("reward rules and test rewards", () => {
  it("validates, orders, updates and deletes rules; a test reward runs the same grant path", async () => {
    await gems();
    expect((await json(v2("/ads/reward_rules", { method: "POST", json: { name: "x", kind: "virtual_currency", currency_code: "NOPE", amount: 1 } }))).param).toBe("currency_code");
    expect((await json(v2("/ads/reward_rules", { method: "POST", json: { name: "x", kind: "virtual_currency", currency_code: "GEMS" } }))).param).toBe("amount");
    expect((await json(v2("/ads/reward_rules", { method: "POST", json: { name: "x", kind: "entitlement", entitlement_id: "pro" } }))).param).toBe("duration_minutes");
    expect((await json(v2("/ads/reward_rules", { method: "POST", json: { name: "x", kind: "entitlement", entitlement_id: "gold", duration_minutes: 5 } }))).param).toBe("entitlement_id");
    const a = await json(v2("/ads/reward_rules", { method: "POST", json: { name: "Banner bonus", kind: "virtual_currency", currency_code: "GEMS", amount: 1, ad_unit_id: "ca-app-pub-1/111" } }));
    const b = await json(v2("/ads/reward_rules", { method: "POST", json: { name: "Everything else", kind: "virtual_currency", currency_code: "GEMS", amount: 7 } }));
    expect([a.position, b.position]).toEqual([0, 1]);
    const reordered = await json(v2("/ads/reward_rules/actions/reorder", { method: "POST", json: { rule_ids: [b.id, a.id] } }));
    expect(reordered.items.map((x: any) => x.id)).toEqual([b.id, a.id]);
    expect((await v2("/ads/reward_rules/actions/reorder", { method: "POST", json: { rule_ids: [a.id] } })).status).toBe(400);
    // Switching a rule to an entitlement clears its currency fields.
    const changed = await json(v2(`/ads/reward_rules/${b.id}`, { method: "POST", json: { kind: "entitlement", entitlement_id: "pro", duration_minutes: 30 } }));
    expect(changed).toMatchObject({ kind: "entitlement", entitlement_id: "pro", duration_minutes: 30, currency_code: null, amount: null });
    await json(v2(`/ads/reward_rules/${b.id}`, { method: "POST", json: { enabled: false } }));
    const t = await json(v2("/ads/reward_verifications/test", { method: "POST", json: { app_user_id: "tester", ad_unit_id: "ca-app-pub-1/111", reward_amount: 1 } }));
    expect(t).toMatchObject({ network: "test", status: "verified", is_sandbox: true, rewards: [{ type: "virtual_currency", code: "GEMS", amount: 1 }], rule_id: a.id });
    expect(await poll("tester", t.client_transaction_id)).toMatchObject({ status: "verified", reward: { code: "GEMS", amount: 1 } });
    expect((await balances("tester")).GEMS.balance).toBe(1);
    expect((await v2(`/ads/reward_rules/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await v2(`/ads/reward_rules/${a.id}`, { method: "DELETE" })).status).toBe(404);
    const failed = await json(v2("/ads/reward_verifications?status=failed"));
    expect(failed.items).toHaveLength(0);
    const audit = await h.db.select().from(schema.auditLogs);
    expect(audit.map((x) => x.actionType)).toContain("reward_rule_created");
  });
});

describe("ads overview", () => {
  const ev = (o: Record<string, unknown>) => ({
    id: crypto.randomUUID(), version: 1, app_user_id: "wren", app_session_id: "S1", timestamp_ms: h.now().getTime() - 3_600_000, capture_method: "adapter",
    network_name: "Google AdMob", mediator_name: "AdMob", ad_format: "rewarded", placement: "level_end", ad_unit_id: "ca-app-pub-9876543210/222", impression_id: crypto.randomUUID(), ...o,
  });
  it("sums USD and converted revenue, impressions, eCPM and breakdowns next to subscription revenue; sandbox is separate", async () => {
    const empty = await json(v2("/ads/overview"));
    expect(empty).toMatchObject({ object: "ads_overview", has_ad_events: false, totals: { ad_revenue: 0, impressions: 0 } });
    const day = h.now().getTime() - 3_600_000;
    const events = [
      ev({ type: "rc_ads_ad_revenue", revenue_micros: 1_500_000, currency: "USD", precision: "exact" }),
      ev({ type: "rc_ads_ad_revenue", revenue_micros: 2_000_000, currency: "EUR", precision: "estimated", network_name: "Unity Ads", ad_format: "interstitial", placement: "home", ad_unit_id: "ca-app-pub-9876543210/111" }),
      ev({ type: "rc_ads_ad_displayed" }), ev({ type: "rc_ads_ad_displayed" }), ev({ type: "rc_ads_ad_displayed", network_name: "Unity Ads", ad_format: "interstitial", placement: "home", ad_unit_id: "ca-app-pub-9876543210/111" }),
      ev({ type: "rc_ads_ad_opened" }), ev({ type: "rc_ads_ad_loaded" }), ev({ type: "rc_ads_ad_loaded" }), ev({ type: "rc_ads_ad_failed_to_load", mediator_error_code: 3 }),
      // Previous period.
      ev({ type: "rc_ads_ad_revenue", revenue_micros: 500_000, currency: "USD", timestamp_ms: day - 29 * 86_400_000 }),
    ];
    expect((await h.fetch("/v1/events", { method: "POST", json: { events } })).status).toBe(200);
    // Sandbox events from the Test Store app are not in the production overview.
    await h.fetch("/v1/events", { method: "POST", key: h.ids.testKey, json: { events: [ev({ type: "rc_ads_ad_revenue", revenue_micros: 9_000_000, currency: "USD" })] } });
    await h.fetch("/v1/subscribers/wren");
    const [cust] = await h.db.select().from(schema.customers);
    await h.db.insert(schema.transactions).values([
      { id: "tx_prod", projectId: "proj1", customerId: cust!.id, appId: "app_ios", store: "app_store", storeTransactionId: "200001", productIdentifier: "pro_monthly", kind: "purchase", purchasedAt: new Date(day), revenueUsd: 4.99 },
      { id: "tx_sbx", projectId: "proj1", customerId: cust!.id, appId: "app_test", store: "test_store", storeTransactionId: "t1", productIdentifier: "pro_monthly", kind: "purchase", isSandbox: true, purchasedAt: new Date(day), revenueUsd: 1 },
    ]);
    const fx = await fxLookup(h.db);
    const eur = Math.round(fx.toUsd(2, "EUR", day)! * 100) / 100;
    const o = await json(v2("/ads/overview?range=28d"));
    expect(o.has_ad_events).toBe(true);
    expect(o.totals).toMatchObject({ ad_revenue: Math.round((1.5 + eur) * 100) / 100, impressions: 3, clicks: 1, loaded: 2, failed_to_load: 1, fill_rate: 0.6667, ad_customers: 1, subscription_revenue: 4.99 });
    expect(o.totals.ad_share).toBeCloseTo((1.5 + eur) / (1.5 + eur + 4.99), 3);
    expect(o.totals.ecpm).toBeCloseTo(((1.5 + eur) / 3) * 1000, 0);
    expect(o.previous).toMatchObject({ ad_revenue: 0.5, impressions: 1 });
    expect(o.by_network.map((r: any) => r.key).sort()).toEqual(["Google AdMob", "Unity Ads"]);
    expect(o.by_format.find((r: any) => r.key === "rewarded")).toMatchObject({ ad_revenue: 1.5, impressions: 2, ecpm: 750 });
    expect(o.series).toHaveLength(28);
    const sandbox = await json(v2("/ads/overview?range=7d&environment=sandbox"));
    expect(sandbox.totals).toMatchObject({ ad_revenue: 9, impressions: 1 });
    expect(sandbox.totals.subscription_revenue).toBe(1);
    expect((await v2("/ads/overview?range=3d")).status).toBe(400);
  });
});

describe("AdMob connection", () => {
  it("connects with OAuth (state single use), loads ad units in pages, names them in the overview, refreshes and disconnects", async () => {
    const start = await json(v2("/ads/admob/connect", { method: "POST", json: {} }));
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "123-abc.apps.googleusercontent.com", redirect_uri: "https://api.example.test/v1/ads/admob/oauth/callback", scope: "https://www.googleapis.com/auth/admob.readonly", access_type: "offline", prompt: "consent", response_type: "code" });
    const state = url.searchParams.get("state")!;
    expect(state.startsWith("proj1.")).toBe(true);
    const back = await h.fetch(`/v1/ads/admob/oauth/callback?code=4%2Fcode&state=${encodeURIComponent(state)}`, { key: "" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("https://app.example.test/projects/proj1/integrations/admob?connected=1");
    expect(Object.fromEntries(new URLSearchParams(google.lastTokenBody))).toMatchObject({ grant_type: "refresh_token", client_secret: "server-client-secret", refresh_token: "1//refresh-token-value" });
    const view = await json(v2("/ads/admob"));
    expect(view).toMatchObject({ connected: true, oauth_client: "server", accounts: [{ id: "pub-9876543210", currency: "USD" }], last_sync_error: null, ssv_callback_url: "https://api.example.test/v1/ads/admob/ssv" });
    expect(view.ad_units.map((u: any) => [u.ad_unit_id, u.name, u.format])).toEqual([["ca-app-pub-9876543210/111", "Home banner", "banner"], ["ca-app-pub-9876543210/222", "Level end reward", "rewarded"]]);
    // The refresh token is sealed, never stored or returned in plain text.
    const [row] = await h.db.select().from(schema.integrations).where(eq(schema.integrations.kind, "admob"));
    expect(row!.secrets).toMatch(/^v1:/);
    expect(JSON.stringify(view)).not.toContain("refresh-token-value");
    // The same state cannot be used twice.
    const again = await h.fetch(`/v1/ads/admob/oauth/callback?code=4%2Fcode&state=${encodeURIComponent(state)}`, { key: "" });
    expect(decodeURIComponent(again.headers.get("location")!)).toContain("admob_error=This AdMob sign-in link is not valid");
    // Names on the overview.
    await h.fetch("/v1/events", { method: "POST", json: { events: [{ id: "e1", type: "rc_ads_ad_displayed", app_user_id: "wren", timestamp_ms: h.now().getTime() - 1000, ad_unit_id: "ca-app-pub-9876543210/222", network_name: "Google AdMob", ad_format: "rewarded", mediator_name: "AdMob" }] } });
    expect((await json(v2("/ads/overview"))).by_ad_unit[0]).toMatchObject({ key: "ca-app-pub-9876543210/222", name: "Level end reward", unit_format: "rewarded", impressions: 1 });
    // A removed unit disappears on refresh; the tick refreshes daily.
    google.units = google.units.slice(0, 1).concat([]);
    expect((await json(v2("/ads/admob/refresh", { method: "POST" }))).ad_units).toHaveLength(1);
    h.setNow(new Date(h.now().getTime() + 25 * 3_600_000));
    const t = await tick(h.db, h.now(), fakeFetch, { encryptionKey: b64(new Uint8Array(32).fill(7)), googleOAuth: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "server-client-secret" } });
    expect(t.admob).toBe(1);
    expect((await json(v2("/ads/admob", { method: "DELETE" })))).toMatchObject({ connected: false, ad_units: [] });
    expect(await h.db.select().from(schema.adUnits)).toHaveLength(0);
  });

  it("refuses an expired state and a cancelled sign-in; a project's own client is used when given", async () => {
    const start = await json(v2("/ads/admob/connect", { method: "POST", json: { client_id: "999-own.apps.googleusercontent.com", client_secret: "own-secret" } }));
    const state = new URL(start.url).searchParams.get("state")!;
    expect(new URL(start.url).searchParams.get("client_id")).toBe("999-own.apps.googleusercontent.com");
    expect(decodeURIComponent((await h.fetch(`/v1/ads/admob/oauth/callback?error=access_denied&state=${state}`, { key: "" })).headers.get("location")!)).toContain("Google sign-in was cancelled.");
    h.setNow(new Date(h.now().getTime() + 11 * 60_000));
    expect(decodeURIComponent((await h.fetch(`/v1/ads/admob/oauth/callback?code=x&state=${state}`, { key: "" })).headers.get("location")!)).toContain("longer than 10 minutes");
    const s2 = new URL((await json(v2("/ads/admob/connect", { method: "POST", json: {} }))).url).searchParams.get("state")!;
    await h.fetch(`/v1/ads/admob/oauth/callback?code=x&state=${s2}`, { key: "" });
    expect(new URLSearchParams(google.lastTokenBody).get("client_secret")).toBe("own-secret");
    expect((await json(v2("/ads/admob"))).oauth_client).toBe("project");
    expect((await json(v2("/ads/admob/connect", { method: "POST", json: { client_id: "not-a-client" } }))).param).toBe("client_id");
  });
});

describe("Intercom inbox app", () => {
  it("answers a signed Canvas Kit request with the contact's subscription; refuses a bad signature", async () => {
    const created = await v2("/integrations/partners", { method: "POST", json: { type: "intercom_inbox", settings: { client_secret: "ic-secret" } } });
    expect(created.status).toBe(201);
    await v2("/test_purchases", { method: "POST", json: { app_user_id: "wren", product_id: "p4", scenario: "purchase" } });
    const body = JSON.stringify({ workspace_id: "abc", contact: { external_id: "wren", email: "wren@example.com" }, context: { location: "conversation" } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("ic-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
    const ok = await h.fetch("/v1/support/intercom/proj1/canvas", { method: "POST", key: "", body, headers: { "content-type": "application/json", "x-body-signature": sig } });
    expect(ok.status).toBe(200);
    const canvas = (await ok.json() as any).canvas.content.components;
    expect(canvas[0]).toEqual({ type: "text", text: "RevenueDot", style: "header" });
    const fields = Object.fromEntries(canvas[1].items.map((i: any) => [i.field, i.value]));
    expect(fields).toMatchObject({ Status: "Active", Entitlements: "pro", Plan: "pro_monthly", "App user ID": "wren" });
    expect(canvas[3]).toMatchObject({ type: "button", action: { type: "url", url: "https://app.example.test/projects/proj1/customers/wren" } });
    const bad = await h.fetch("/v1/support/intercom/proj1/canvas", { method: "POST", key: "", body, headers: { "content-type": "application/json", "x-body-signature": "00".repeat(32) } });
    expect(bad.status).toBe(401);
    const unknown = await h.fetch("/v1/support/intercom/proj1/canvas", { method: "POST", key: "", body: JSON.stringify({ contact: { email: "nobody@example.com" } }), headers: { "x-body-signature": "x" } });
    expect(unknown.status).toBe(401);
    const [i] = await h.db.select().from(schema.integrations).where(and(eq(schema.integrations.projectId, "proj1"), eq(schema.integrations.kind, "intercom_inbox")));
    expect(i!.lastDeliveredAt).not.toBeNull();
  });
});

describe("Apple Search Ads", () => {
  it("signs the client secret with Apple's SEC1 key, loads campaign names and reports customers and revenue by campaign", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    // PKCS #8 → SEC1, the format `openssl ecparam -genkey` writes and Apple's guide uses.
    const at = pkcs8.findIndex((b, i) => b === 0x04 && pkcs8[i + 1]! + i + 2 === pkcs8.length);
    const sec1 = pkcs8.slice(at + 2);
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${b64(sec1)}\n-----END EC PRIVATE KEY-----`;
    const { appleAdsClientSecret } = await import("../src/services/ads/apple-ads.js");
    const jwt = await appleAdsClientSecret({ clientId: "SEARCHADS.client", teamId: "SEARCHADS.team", keyId: "kid-1", privateKeyPem: pem, nowMs: h.now().getTime() });
    const [hd, pl, sg] = jwt.split(".");
    const dec = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    expect(dec(hd!)).toEqual({ alg: "ES256", kid: "kid-1" });
    expect(dec(pl!)).toMatchObject({ sub: "SEARCHADS.client", iss: "SEARCHADS.team", aud: "https://appleid.apple.com" });
    const raw = Uint8Array.from(atob(sg!.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (sg!.length % 4)) % 4)), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, new TextEncoder().encode(`${hd}.${pl}`))).toBe(true);

    // Two customers from campaign 542370539 (one paying), one from 999.
    for (const [user, campaign] of [["a1", "542370539"], ["a2", "542370539"], ["a3", "999"]] as const) {
      await h.fetch(`/v1/subscribers/${user}`);
      await v2(`/customers/${user}/attributes`, { method: "POST", json: { attributes: [{ name: "$appleAdsCampaignId", value: campaign }] } });
    }
    const [a1] = await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "a1"));
    await h.db.insert(schema.transactions).values({ id: "tx_asa", projectId: "proj1", customerId: a1!.id, appId: "app_ios", store: "app_store", storeTransactionId: "300001", productIdentifier: "pro_annual", kind: "purchase", purchasedAt: h.now(), revenueUsd: 39.99 });
    const created = await v2("/integrations/partners", { method: "POST", json: { type: "apple_search_ads", settings: { org_id: "40669820", client_id: "SEARCHADS.client", team_id: "SEARCHADS.team", key_id: "kid-1", private_key: pem } } });
    expect(created.status).toBe(201);
    const appleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://appleid.apple.com/auth/oauth2/token?")) {
        expect(new URL(url).searchParams.get("scope")).toBe("searchadsorg");
        return Response.json({ access_token: "asa-token", token_type: "Bearer", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("x-ap-context")).toBe("orgId=40669820");
      if (url === "https://api.searchads.apple.com/api/v5/campaigns?limit=1000&offset=0") return Response.json({ data: [{ id: 542370539, name: "Brand US" }], pagination: { totalResults: 1 } });
      if (url.startsWith("https://api.searchads.apple.com/api/v5/campaigns/542370539/adgroups")) return Response.json({ data: [{ id: 542317095, name: "Exact match" }] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    // The service with a fake Apple (the harness's own fetch knows no Apple endpoints; see the API call below).
    const { syncAppleAdsNames } = await import("../src/services/ads/apple-ads.js");
    const { secretKeyFrom } = await import("../src/services/secrets.js");
    expect(await syncAppleAdsNames({ db: h.db, fetch: appleFetch, now: h.now, secretKey: await secretKeyFrom(b64(new Uint8Array(32).fill(7)), null) }, "proj1")).toBe(1);
    const report = await json(v2("/ads/apple_search_ads/report?range=28d"));
    expect(report).toMatchObject({ object: "apple_search_ads_report", names_loaded: 1, last_sync_error: null });
    expect(report.campaigns).toEqual([
      { campaign_id: "542370539", name: "Brand US", customers: 2, paying_customers: 1, revenue: 39.99, revenue_per_customer: 20 },
      { campaign_id: "999", name: null, customers: 1, paying_customers: 0, revenue: 0, revenue_per_customer: 0 },
    ]);
    // Through the API the real fetch is the harness's fake, which knows no Apple: the error is recorded and returned.
    const failed = await v2("/ads/apple_search_ads/sync", { method: "POST" });
    expect(failed.status).toBe(422);
    expect((await json(v2("/ads/apple_search_ads/report"))).last_sync_error).toMatch(/HTTP 404/);
  });
});
