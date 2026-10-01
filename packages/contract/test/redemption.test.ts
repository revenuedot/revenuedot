import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { webEnv, type WebEnv } from "../src/web-env.js";
import { CustomerInfoSchema, ErrorSchema } from "../src/sdk-schemas.js";

/**
 * Redemption links (prd/web-billing/PRD.md §4) as the SDKs use them: the deep link the iOS and Android parsers accept
 * (host `redeem_web_purchase`, query `redemption_token`), `POST /v1/subscribers/redeem_purchase` with the iOS request
 * fixture's headers and body, every answer against the SDK fixtures (7849, 7852, 7853 with the obfuscated email), the
 * customer info schema, and PURCHASE_REDEEMED against RevenueCat's sample keys.
 */
const fixture = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const REQ = fixture("ios/req-post-redeem-web-purchase.json") as { headers: Record<string, string>; request: { body: Record<string, string>; method: string; url: string } };
const SAMPLE = fixture("webhooks/purchase_redeemed.json").event as Record<string, unknown>;

let env: WebEnv;
afterEach(async () => { await env?.h.close(); });

/** An anonymous web purchase through a purchase link; returns the token from the success page and the deep link. */
async function webPurchase(pkg = "$rc_monthly", email = "buyer@example.com") {
  const links = await env.api("GET", `/v2/projects/${env.h.ids.project}/purchase_links`);
  let l = links.body.items[0];
  if (!l) {
    const offering = (await env.api("GET", `/v2/projects/${env.h.ids.project}/offerings`)).body.items.find((x: any) => x.lookup_key === "web");
    l = (await env.api("POST", `/v2/projects/${env.h.ids.project}/purchase_links`, { name: "Go Pro", offering_id: offering.id })).body;
  }
  const start = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: l.slug, package: pkg } });
  const { url } = await start.json() as { url: string };
  const s = env.stripe.complete(new URL(url).pathname.split("/").pop()!, { email });
  const html = await (await env.raw(s.success_url)).text();
  const token = /\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(html)![1]!;
  const page = await (await env.raw(`http://localhost/pay/r/${token}`)).text();
  const deepLink = /(scanner:\/\/redeem_web_purchase\?redemption_token=[^"&]+)/.exec(page)![1]!;
  return { token, deepLink, appUserId: s.metadata.app_user_id as string };
}

/** The iOS SDK's redeem call: the fixture's headers and body shape, the app's public key. */
const redeem = (appUserId: string, token: string, platform = "iOS") => env.h.fetch("/v1/subscribers/redeem_purchase", {
  method: REQ.request.method, key: env.h.ids.iosKey, headers: { ...Object.fromEntries(Object.entries(REQ.headers).filter(([k]) => k !== "Authorization" && k !== "content-type")), "X-Platform": platform },
  json: { ...Object.fromEntries(Object.keys(REQ.request.body).map((k) => [k, k === "app_user_id" ? appUserId : token])) },
});

describe("redemption links", () => {
  it("the deep link parses like the SDKs' DeepLinkParser, and redeeming attaches the purchase with PURCHASE_REDEEMED", async () => {
    env = await webEnv();
    await env.setupWeb();
    const { token, deepLink, appUserId: anon } = await webPurchase();
    expect(Object.keys(REQ.request.body).sort()).toEqual(["app_user_id", "redemption_token"]);
    expect(new URL(REQ.request.url).pathname).toBe("/v1/subscribers/redeem_purchase");
    const u = new URL(deepLink);
    expect(u.protocol).toBe("scanner:");
    expect(u.host).toBe("redeem_web_purchase");
    expect(u.searchParams.get("redemption_token")).toBe(token);

    const r = await redeem("ios_user_1", token);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(CustomerInfoSchema.safeParse(body).success).toBe(true);
    expect(body.subscriber.entitlements.pro).toMatchObject({ product_identifier: expect.stringMatching(/^price_/) });
    expect(body.subscriber.other_purchases).toBeDefined();
    // The app user id now owns the web purchase; the anonymous web id is an alias of the same customer.
    const again = await (await env.h.fetch("/v1/subscribers/ios_user_1")).json() as any;
    expect(Object.keys(again.subscriber.subscriptions)).toHaveLength(1);
    const ev = await env.events("PURCHASE_REDEEMED");
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]!).sort()).toEqual([...Object.keys(SAMPLE), "app_user_id"].sort());
    expect(ev[0]).toMatchObject({
      store: "STRIPE", environment: "SANDBOX", redeemed_from: [anon], redeemed_by: ["ios_user_1"], redemption_outcome: "alias", redemption_platform: "ios",
      entitlement_ids: ["pro"], app_id: "app_web", workflow_id: null, workflow_step_id: null, trace_id: expect.stringMatching(/^wco_/), app_user_id: "ios_user_1",
    });
    expect(typeof ev[0]!.event_timestamp_ms).toBe("number");

    // A retry from the same user (the SDK retries) answers the same customer info and records nothing new.
    const retry = await redeem("ios_user_1", token);
    expect(retry.status).toBe(200);
    expect(await env.events("PURCHASE_REDEEMED")).toHaveLength(1);

    // Another user: 7852, in the Android fixture's shape.
    const other = await redeem("someone_else", token, "android");
    expect(other.status).toBe(400);
    const ob = await other.json() as Record<string, unknown>;
    expect(ErrorSchema.safeParse(ob).success).toBe(true);
    const f7852 = fixture("android/error_7852_web_purchase_already_redeemed.json");
    expect(ob).toEqual(f7852);
    // The redemption page says it is used.
    expect(await (await env.raw(`http://localhost/pay/r/${token}`)).text()).toContain("Already unlocked");
  });

  it("an unknown or malformed token is 7849, the SDK's invalidToken, in the fixture's shape", async () => {
    env = await webEnv();
    await env.setupWeb();
    const f7849 = fixture("android/error_7849_invalid_web_redemption_token.json");
    for (const t of ["test-redemption-token", "rdrt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ""]) {
      const r = await redeem("u1", t);
      expect(r.status).toBe(400);
      expect(Object.keys(await r.json() as object).sort()).toEqual(Object.keys(f7849).sort());
    }
    const r = await redeem("u1", "nope");
    expect(await r.json()).toMatchObject({ code: 7849 });
  });

  it("an expired link answers 7853 with the obfuscated email and emails a new link that works", async () => {
    env = await webEnv();
    await env.setupWeb();
    const { token } = await webPurchase("$rc_annual", "taylor@example.com");
    expect(env.mail.sent).toHaveLength(1);
    env.h.setNow(new Date(env.h.now().getTime() + 25 * 3_600_000));
    const r = await redeem("late_user", token);
    expect(r.status).toBe(400);
    const b = await r.json() as Record<string, any>;
    const f7853 = fixture("android/error_7853_expired_web_redemption_token.json");
    expect(Object.keys(b).sort()).toEqual(Object.keys(f7853).sort());
    expect(b).toEqual({ code: 7853, message: f7853.message, purchase_redemption_error_info: { obfuscated_email: "t***@e*****e.com" } });
    expect(Object.keys(b.purchase_redemption_error_info)).toEqual(Object.keys(f7853.purchase_redemption_error_info));
    expect(env.mail.sent).toHaveLength(2);
    const fresh = /\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(env.mail.sent[1]!.text)![1]!;
    expect(fresh).not.toBe(token);
    // Asking again within the hour sends nothing more.
    await redeem("late_user", token);
    expect(env.mail.sent).toHaveLength(2);
    const ok = await redeem("late_user", fresh);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).subscriber.entitlements.pro).toBeDefined();
  });

  it("an identified app user with purchases of their own keeps them and gains the web purchase", async () => {
    env = await webEnv();
    await env.setupWeb();
    await env.h.fetch("/v1/receipts", { method: "POST", key: env.h.ids.testKey, json: { app_user_id: "known_user", fetch_token: `test_${env.h.now().getTime()}_${crypto.randomUUID()}`, product_id: "lifetime", price: 49.99, currency: "USD" } });
    const { token } = await webPurchase();
    const r = await redeem("known_user", token);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(Object.keys(body.subscriber.non_subscriptions)).toContain("lifetime");
    expect(Object.keys(body.subscriber.subscriptions)).toHaveLength(1);
    expect(body.subscriber.original_app_user_id).toBe("known_user");
  });
});
