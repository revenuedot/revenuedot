import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { webEnv, WEB_APP_ID, WEB_WHSEC, type WebEnv } from "../../../packages/contract/src/web-env.js";
import { signStripePayload } from "../src/stores/stripe/signature.js";

/**
 * Web billing under abuse and concurrency (prd/web-billing/PRD.md §2–§7): two redeems of one link at once, the success page
 * and the webhook completing one checkout at once, ids and answers the public page sends, capped discounts started at once,
 * where redemption emails point, what a custom domain serves, and domain claims a project cannot prove.
 */
let env: WebEnv;
afterEach(async () => { await env?.h.close(); });
const P = () => `/v2/projects/${env.h.ids.project}`;

async function link() {
  const offering = (await env.api("GET", `${P()}/offerings`)).body.items.find((x: any) => x.lookup_key === "web");
  const r = await env.api("POST", `${P()}/purchase_links`, { name: "Go Pro", offering_id: offering.id });
  expect(r.status).toBe(201);
  return r.body as { slug: string; id: string; url: string };
}

async function start(slug: string, json: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await env.raw("http://localhost/pay/api/checkout", { method: "POST", headers, json: { project: "scanner", slug, package: "$rc_monthly", ...json } });
  const body = await res.json() as { url?: string; message?: string; checkout_id?: string };
  return { status: res.status, body, sessionId: body.url ? new URL(body.url).pathname.split("/").pop()! : null };
}

/** An anonymous purchase through a link, paid on the fake Stripe page; answers the success URL and the session. */
async function paid(slug: string, json: Record<string, unknown> = {}) {
  const s = await start(slug, json);
  expect(s.status, s.body.message).toBe(200);
  const session = env.stripe.complete(s.sessionId!, { email: "buyer@example.com" });
  return { session, successUrl: session.success_url as string, sessionId: s.sessionId! };
}

const tokenIn = (text: string) => /\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
const redeem = (appUserId: string, token: string) => env.h.fetch("/v1/subscribers/redeem_purchase", { method: "POST", key: env.h.ids.iosKey, headers: { "X-Platform": "iOS" }, json: { app_user_id: appUserId, redemption_token: token } });
const completedEvent = (sessionId: string, session: Record<string, unknown>) => ({
  id: `evt_${crypto.randomUUID().replace(/-/g, "")}`, type: "checkout.session.completed", livemode: false, created: Math.floor(env.h.now().getTime() / 1000),
  data: { object: { ...session, id: sessionId, object: "checkout.session" } },
});

describe("redemption under concurrency", () => {
  it("app users redeeming one link at once: one gets the purchase, the others 7852, PURCHASE_REDEEMED once", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl } = await paid(l.slug);
    const token = tokenIn(await (await env.raw(successUrl)).text())!;
    const users = ["alice", "bob", "carol", "dave", "erin", "frank"];
    for (const id of users) await env.h.fetch(`/v1/subscribers/${id}`);

    const res = await Promise.all(users.map((u) => redeem(u, token)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 200)) expect(await r.json()).toMatchObject({ code: 7852 });
    const winner = users[res.findIndex((r) => r.status === 200)]!;
    expect(await env.events("PURCHASE_REDEEMED")).toHaveLength(1);
    for (const u of users) {
      const info = await (await env.h.fetch(`/v1/subscribers/${u}`)).json() as any;
      expect(!!info.subscriber.entitlements.pro, u).toBe(u === winner);
    }
    // The same user retrying (the SDK does) gets the customer again; nothing new is sent.
    expect((await redeem(winner, token)).status).toBe(200);
    expect(await env.events("PURCHASE_REDEEMED")).toHaveLength(1);
  });

  it("one user's two redeems at once both answer the customer and send PURCHASE_REDEEMED once", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl } = await paid(l.slug);
    const token = tokenIn(await (await env.raw(successUrl)).text())!;
    const res = await Promise.all([redeem("carol", token), redeem("carol", token)]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    for (const r of res) expect(((await r.json()) as any).subscriber.entitlements.pro).toBeDefined();
    expect(await env.events("PURCHASE_REDEEMED")).toHaveLength(1);
  });
});

describe("completion under concurrency", () => {
  it("the success page and the webhook at once agree on one token, the emailed one, and it redeems", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl, session, sessionId } = await paid(l.slug, { email: "buyer@example.com" });
    const [page, hook] = await Promise.all([env.raw(successUrl), env.webhook(completedEvent(sessionId, session))]);
    expect(hook.status).toBeLessThan(500);
    let html = await page.text();
    // A page that lost the race to record the purchase shows "processing" and reloads; the reload shows the token.
    if (!tokenIn(html)) html = await (await env.raw(successUrl)).text();
    const shown = tokenIn(html)!;
    expect(shown).toBeTruthy();
    expect(env.mail.sent).toHaveLength(1);
    expect(tokenIn(env.mail.sent[0]!.text)).toBe(shown);
    expect(tokenIn(await (await env.raw(successUrl)).text())).toBe(shown);
    expect((await redeem("dave", shown)).status).toBe(200);
    expect(await env.events("INITIAL_PURCHASE")).toHaveLength(1);
  });

  it("a webhook completes only checkouts of its own Stripe app, and a success page only its own project's", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl, sessionId, session } = await paid(l.slug);
    // A second Stripe app (same account and signing secret) in another project, with a page of the same slug.
    const [web] = await env.h.db.select().from(schema.apps).where(eq(schema.apps.id, WEB_APP_ID));
    await env.h.db.insert(schema.projects).values({ id: "proj_other", name: "Other" });
    await env.h.db.insert(schema.apps).values({ ...web!, id: "app_web_other", projectId: "proj_other", publicKey: "strp_other123" });
    await env.h.db.insert(schema.webDomains).values({ projectId: "proj_other", slug: "other", verificationToken: "t" });
    const [lk] = await env.h.db.select().from(schema.purchaseLinks).where(eq(schema.purchaseLinks.id, l.id));
    await env.h.db.insert(schema.purchaseLinks).values({ ...lk!, id: "plink_other", projectId: "proj_other", appId: "app_web_other" });
    const other = new URL(successUrl);
    other.pathname = other.pathname.replace("/pay/scanner/", "/pay/other/");
    expect((await env.raw(other.toString())).status).toBe(404);
    // The other app's webhook names this session: it is not this app's checkout to complete.
    const raw = JSON.stringify(completedEvent(sessionId, session));
    const sig = await signStripePayload(WEB_WHSEC, raw, Math.floor(env.h.now().getTime() / 1000));
    await env.raw("/v1/notifications/stripe/app_web_other", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: raw });
    const [row] = await env.h.db.select().from(schema.webCheckouts).where(eq(schema.webCheckouts.stripeSessionId, sessionId));
    expect(row!.status).toBe("created");
    expect(env.mail.sent).toHaveLength(0);
    // Its own page and its own app's webhook complete it.
    expect((await env.raw(successUrl)).status).toBe(200);
  });
});

describe("what the public page sends", () => {
  it("a visitor id that is already a customer's is not used for the purchase, so redeeming cannot move that customer", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    // Someone's app install: an anonymous app user id with a purchase of its own.
    const victim = `$RCAnonymousID:${"a".repeat(32)}`;
    await env.h.fetch("/v1/receipts", { method: "POST", key: env.h.ids.testKey, json: { app_user_id: victim, fetch_token: `test_${env.h.now().getTime()}_v`, product_id: "lifetime", price: 49.99, currency: "USD" } });
    const before = await (await env.h.fetch(`/v1/subscribers/${encodeURIComponent(victim)}`)).json() as any;
    expect(Object.keys(before.subscriber.non_subscriptions)).toHaveLength(1);

    const s = await start(l.slug, { visitor_id: victim });
    expect(s.status).toBe(200);
    const meta = env.stripe.writes("/v1/checkout/sessions")[0]!.params.metadata;
    expect(meta.app_user_id).toMatch(/^\$RCAnonymousID:[0-9a-f]{32}$/);
    expect(meta.app_user_id).not.toBe(victim);
    const session = env.stripe.complete(s.sessionId!);
    const token = tokenIn(await (await env.raw(session.success_url)).text())!;
    expect((await redeem("attacker", token)).status).toBe(200);
    const after = await (await env.h.fetch(`/v1/subscribers/${encodeURIComponent(victim)}`)).json() as any;
    expect(Object.keys(after.subscriber.non_subscriptions)).toHaveLength(1);
    const attacker = await (await env.h.fetch("/v1/subscribers/attacker")).json() as any;
    expect(Object.keys(attacker.subscriber.non_subscriptions)).toHaveLength(0);

    // A fresh visitor id (no customer yet) is used, so the funnel's events and the purchase share it.
    const fresh = `$RCAnonymousID:${"b".repeat(32)}`;
    expect((await start(l.slug, { visitor_id: fresh })).status).toBe(200);
    expect(env.stripe.writes("/v1/checkout/sessions")[1]!.params.metadata.app_user_id).toBe(fresh);
  });

  it("funnel answers become attributes only as the question's own option labels", async () => {
    env = await webEnv();
    await env.setupWeb();
    const f = (await env.api("POST", `${P()}/funnels`, { name: "Quiz" })).body;
    const draft = structuredClone(f.draft);
    draft.steps.find((s: any) => s.type === "paywall").offering = "web";
    draft.steps.splice(1, 0, { id: "topics", type: "question", title: "Topics", multiple: true, attribute: "topics", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] });
    expect((await env.api("PATCH", `${P()}/funnels/${f.id}`, { draft })).status).toBe(200);
    expect((await env.api("POST", `${P()}/funnels/${f.id}/actions/publish`)).status).toBe(200);
    const res = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: f.slug, package: "$rc_monthly", answers: { goal: "<script>free text</script>", topics: ["Beta", "Gamma", "Alpha", "Beta"] } } });
    expect(res.status).toBe(200);
    const [row] = await env.h.db.select().from(schema.webCheckouts);
    expect(row!.attributes).toEqual({ topics: "Beta, Alpha" });
  });

  it("a purchase for an existing app user id fills in missing attributes and never overwrites theirs", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    await env.h.fetch("/v1/subscribers/known_user/attributes", { method: "POST", json: { attributes: { $email: { value: "owner@example.com", updated_at_ms: env.h.now().getTime() - 1000 } } } });
    const s = await start(l.slug, { app_user_id: "known_user", email: "someone.else@example.com" });
    expect(s.status).toBe(200);
    const session = env.stripe.complete(s.sessionId!);
    expect((await env.raw(session.success_url)).status).toBe(200);
    const [c] = await env.h.db.select({ id: schema.customerAliases.customerId }).from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, "known_user"));
    const [email] = await env.h.db.select().from(schema.customerAttributes).where(and(eq(schema.customerAttributes.customerId, c!.id), eq(schema.customerAttributes.key, "$email")));
    expect(email!.value).toBe("owner@example.com");
  });
});

describe("capped discounts", () => {
  async function capped(max: number) {
    const d = await env.api("POST", `${P()}/discounts`, { identifier: "last_one", customer_facing_name: "Last one", type: "percentage", percentage: 50, duration_mode: "one_time", eligibility: "everyone", max_redemptions: max });
    expect(d.status).toBe(201);
    expect((await env.api("POST", `${P()}/discounts/${d.body.id}/discount_codes`, { codes: ["LAST"] })).status).toBe(201);
    return d.body.id as string;
  }

  it("checkouts started at once cannot all take the last use; an unpaid checkout holds it until its session expires", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    await capped(1);
    const runs = await Promise.all([start(l.slug, { code: "LAST" }), start(l.slug, { code: "last" }), start(l.slug, { code: "Last" })]);
    expect(runs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(runs.find((r) => r.status === 400)!.body.message).toBe("This code has been used the maximum number of times.");
    // The session expires on Stripe before the hold ends.
    const params = env.stripe.writes("/v1/checkout/sessions")[0]!.params;
    expect(Number(params.expires_at)).toBe(Math.floor(env.h.now().getTime() / 1000) + 31 * 60);
    // Abandoned: once the session can no longer be paid, the use is free again.
    env.h.setNow(new Date(env.h.now().getTime() + 34 * 60_000));
    expect((await start(l.slug, { code: "LAST" })).status).toBe(200);
  });

  it("a changed discount's new Stripe coupon allows only the uses that are left", async () => {
    env = await webEnv();
    await env.setupWeb();
    const id = await capped(5);
    await env.h.db.update(schema.discounts).set({ timesRedeemed: 2 }).where(eq(schema.discounts.id, id));
    expect((await env.api("PATCH", `${P()}/discounts/${id}`, { percentage: 40 })).status).toBe(200);
    const coupons = env.stripe.writes("/v1/coupons");
    expect(coupons.at(-1)!.params).toMatchObject({ percent_off: "40", max_redemptions: "3" });
  });
});

describe("redemption emails and hosts", () => {
  it("a redemption email links to the configured pay URL, whatever Host or X-Forwarded-Host the request carried", async () => {
    env = await webEnv({ payUrl: "https://pay.example.dev" });
    await env.setupWeb();
    await link();
    const s = await env.raw("https://pay.example.dev/api/checkout", { method: "POST", headers: { "x-forwarded-host": "pay.example.dev" }, json: { project: "scanner", slug: "go-pro", package: "$rc_monthly", email: "buyer@example.com" } });
    const { url } = await s.json() as { url: string };
    const session = env.stripe.complete(new URL(url).pathname.split("/").pop()!);
    const token = tokenIn(await (await env.raw(session.success_url)).text())!;
    env.h.setNow(new Date(env.h.now().getTime() + 25 * 3_600_000));
    const r = await env.h.fetch("/v1/subscribers/redeem_purchase", { method: "POST", key: env.h.ids.iosKey, headers: { "X-Platform": "iOS", "x-forwarded-host": "evil.example" }, json: { app_user_id: "late", redemption_token: token } });
    expect(await r.json()).toMatchObject({ code: 7853 });
    const last = env.mail.sent.at(-1)!;
    expect(last.text).toMatch(/https:\/\/pay\.example\.dev\/r\/rdrt_/);
    expect(last.text).not.toContain("evil.example");
  });

  it("without a pay URL the email uses the public URL, never the request's forwarded host", async () => {
    env = await webEnv({ publicUrl: "https://dash.example.dev" });
    await env.setupWeb();
    const l = await link();
    const s = await start(l.slug, { email: "buyer@example.com" }, { "x-forwarded-host": "evil.example" });
    const session = env.stripe.complete(s.sessionId!);
    await env.webhook(completedEvent(s.sessionId!, session));
    expect(env.mail.sent).toHaveLength(1);
    expect(env.mail.sent[0]!.text).toMatch(/https:\/\/dash\.example\.dev\/pay\/r\/rdrt_/);
  });

  it("a deep link scheme the browser would handle itself, or an app name over two lines, is refused", async () => {
    env = await webEnv();
    for (const app_scheme of ["javascript", "https", "data"]) {
      const r = await env.api("PUT", `${P()}/apps/${WEB_APP_ID}/web_config`, { app_scheme });
      expect(r.status, app_scheme).toBe(400);
    }
    expect((await env.api("PUT", `${P()}/apps/${WEB_APP_ID}/web_config`, { app_name: "Scanner\r\nBcc: x@example.com" })).status).toBe(400);
  });

  it("the hosted pages send no referrer, so a token in the URL never leaves in a Referer", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    expect((await env.raw(l.url)).headers.get("referrer-policy")).toBe("no-referrer");
    expect((await env.raw("http://localhost/pay/r/rdrt_unknownunknownunknown")).headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("custom domain claims", () => {
  it("a claim another project cannot prove does not block the owner; only one project can hold a verified domain", async () => {
    env = await webEnv({ customDomainTarget: "domains.pay.test" });
    await env.setupWeb();
    await env.h.db.insert(schema.projects).values({ id: "proj_squat", name: "Squatter" });
    await env.h.db.insert(schema.webDomains).values({ projectId: "proj_squat", slug: "squat", customDomain: "pay.scanner.example", status: "pending", verificationToken: "squat" });
    const put = await env.api("PUT", `${P()}/web_domain`, { custom_domain: "pay.scanner.example" });
    expect(put.status).toBe(200);
    const [, txt] = put.body.dns;
    env.dns["_revenuedot.pay.scanner.example"] = { TXT: [txt.value] };
    env.dns["pay.scanner.example"] = { CNAME: ["domains.pay.test"] };
    expect((await env.api("POST", `${P()}/web_domain/actions/verify`)).body).toMatchObject({ status: "verified" });
    // The database holds one verified owner per domain.
    await expect(env.h.db.update(schema.webDomains).set({ status: "verified" }).where(eq(schema.webDomains.projectId, "proj_squat"))).rejects.toThrow();
  });
});
