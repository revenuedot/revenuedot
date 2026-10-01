import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { memoryMailer } from "../src/mail/index.js";
import { getOrCreateCustomer, setAttributes } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { SENDS_PER_TICK, offerUrlFor, runCampaign, runDueCampaigns } from "../src/services/winback.js";
import type { VerifiedPurchase } from "../src/stores/types.js";

/** Win-back campaigns (prd/lifecycle/PRD.md): audience, sending, links, unsubscribe, reactivation. */
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
let h: Harness;
let mail: ReturnType<typeof memoryMailer>;
beforeEach(async () => { mail = memoryMailer(); h = await harness({ mailer: mail, publicUrl: "https://app.example.test" }); });
afterEach(async () => { await h.close(); });

const v2 = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const res = await h.fetch(`/v2/projects/proj1${path}`, { key: h.ids.secretKey, ...init });
  return { status: res.status, body: await res.json() as any };
};

/** A subscriber whose subscription ended `endedDaysAgo` days ago (or is still active when negative). */
async function subscriber(user: string, o: { endedDaysAgo: number; email?: string; store?: string; sandbox?: boolean; product?: string; appId?: string }) {
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, new Date(NOW - 200 * DAY));
  const end = new Date(NOW - o.endedDaysAgo * DAY);
  const store = o.store ?? "app_store";
  const p = {
    kind: "subscription", store, storeKey: `key_${user}`, productIdentifier: o.product ?? "pro_monthly", isSandbox: !!o.sandbox,
    purchaseDate: new Date(end.getTime() - 30 * DAY), originalPurchaseDate: new Date(end.getTime() - 90 * DAY), expiresDate: end, periodType: "normal",
    ownershipType: "PURCHASED", storeTransactionId: `tx_${user}_1`, originalTransactionId: `key_${user}`, price: { amount: 9.99, currency: "USD" },
  } as unknown as VerifiedPurchase;
  await applyPurchases(h.db, customer, [p], { projectId: "proj1", appId: o.appId ?? (store === "play_store" ? "app_play" : "app_ios"), appUserId: user, now: new Date(end.getTime() - 30 * DAY), fromDevice: false });
  if (o.email) await setAttributes(h.db, customer.id, { $email: { value: o.email } }, new Date(NOW));
  return { customer, purchase: p };
}

const campaign = (over: Record<string, unknown> = {}) => ({
  name: "Come back in September", status: "active",
  audience: { churned_min_days: 3, churned_max_days: 60, product_ids: [], stores: [], audience_id: null },
  email: { subject: "We saved your scans", heading: "Your scans are waiting", body: "Come back to Scanner Pro.\n\nYour first month is on us.", button_label: "Resubscribe" },
  offer: { type: "store" }, send_hour_utc: 9, ...over,
});

async function people() {
  const a = await subscriber("lapsed_ios", { endedDaysAgo: 10, email: "lapsed@example.com" });
  await subscriber("still_paying", { endedDaysAgo: -10, email: "paying@example.com" });
  await subscriber("no_email", { endedDaysAgo: 10 });
  await subscriber("long_gone", { endedDaysAgo: 100, email: "gone@example.com" });
  await subscriber("unsubscribed", { endedDaysAgo: 10, email: "Quiet@Example.com" });
  await subscriber("sandbox_only", { endedDaysAgo: 10, email: "sandbox@example.com", sandbox: true });
  await subscriber("lapsed_android", { endedDaysAgo: 5, email: "android@example.com", store: "play_store", product: "pro:monthly" });
  await h.db.insert(schema.emailSuppressions).values({ projectId: "proj1", email: "quiet@example.com" });
  return a;
}

describe("win-back campaigns", () => {
  it("emails each churned subscriber with an email once, with tracked links and a one-click unsubscribe", async () => {
    h.setNow(new Date(NOW));
    const lapsed = await people();
    const made = await v2("/winback_campaigns", { method: "POST", json: campaign() });
    expect(made.status).toBe(201);
    const id = made.body.id;
    const preview = await v2(`/winback_campaigns/${id}/actions/preview`, { method: "POST" });
    expect(preview.body).toMatchObject({ object: "winback_preview", eligible: 2, is_approximate: false });
    expect(preview.body.sample.map((s: any) => s.app_user_id).sort()).toEqual(["lapsed_android", "lapsed_ios"]);

    const run = await v2(`/winback_campaigns/${id}/actions/run`, { method: "POST" });
    expect(run.body).toMatchObject({ object: "winback_run", sent: 2, failed: 0 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["android@example.com", "lapsed@example.com"]);
    const m = mail.sent.find((x) => x.to === "lapsed@example.com")!;
    expect(m.subject).toBe("We saved your scans");
    expect(m.html).toContain("Your scans are waiting");
    expect(m.html).toContain("Scanner"); // the project's name speaks for the app
    expect(m.html).not.toMatch(/width="1" height="1"/); // no open tracking unless asked for
    const sends = await h.db.select().from(schema.winbackSends);
    const ios = sends.find((s) => s.email === "lapsed@example.com")!;
    expect(ios.offerUrl).toBe("https://apps.apple.com/account/subscriptions");
    expect(sends.find((s) => s.email === "android@example.com")!.offerUrl).toBe("https://play.google.com/store/account/subscriptions?sku=pro&package=com.example.scanner");
    expect(m.text).toContain(`https://app.example.test/v1/winback/c/${ios.token}`);
    expect(m.text).toContain(`https://app.example.test/v1/winback/u/${ios.token}`);
    expect(m.headers).toEqual({ "List-Unsubscribe": `<https://app.example.test/v1/winback/u/${ios.token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

    // Running again emails nobody twice.
    expect((await v2(`/winback_campaigns/${id}/actions/run`, { method: "POST" })).body.sent).toBe(0);

    // Click: recorded, then the store page.
    const click = await h.fetch(`/v1/winback/c/${ios.token}`, { key: "", redirect: "manual" });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe("https://apps.apple.com/account/subscriptions");
    expect((await h.fetch("/v1/winback/c/AAAAAAAAAAAAAAAAAAAA", { key: "" })).status).toBe(404);

    // Unsubscribe: GET only asks (mail scanners follow links); POST unsubscribes.
    const ask = await h.fetch(`/v1/winback/u/${ios.token}`, { key: "" });
    expect(await ask.text()).toContain("<form method=\"post\">");
    expect(await h.db.select().from(schema.emailSuppressions)).toHaveLength(1);
    const done = await h.fetch(`/v1/winback/u/${ios.token}`, { key: "", method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("You are unsubscribed");
    expect((await h.db.select().from(schema.emailSuppressions)).map((s) => s.email).sort()).toEqual(["lapsed@example.com", "quiet@example.com"]);

    // A second campaign skips the unsubscribed address.
    const second = await v2("/winback_campaigns", { method: "POST", json: campaign({ name: "Second" }) });
    expect((await v2(`/winback_campaigns/${second.body.id}/actions/preview`, { method: "POST" })).body.sample.map((s: any) => s.app_user_id)).toEqual(["lapsed_android"]);

    // The customer comes back 2 days later: reactivated, with the revenue.
    h.setNow(new Date(NOW + 2 * DAY));
    const back = { ...lapsed.purchase, purchaseDate: new Date(NOW + 2 * DAY), expiresDate: new Date(NOW + 32 * DAY), storeTransactionId: "tx_lapsed_ios_2" } as VerifiedPurchase;
    await applyPurchases(h.db, lapsed.customer, [back], { projectId: "proj1", appId: "app_ios", appUserId: "lapsed_ios", now: new Date(NOW + 2 * DAY), fromDevice: true });
    const detail = await v2(`/winback_campaigns/${id}`);
    expect(detail.body.stats).toEqual({ sent: 2, failed: 0, opened: 1, clicked: 1, unsubscribed: 1, reactivated: 1, reactivated_revenue_in_usd: 9.99 });
    expect(detail.body.recent_sends).toHaveLength(2);
    expect(detail.body.email).not.toHaveProperty("link_base");
  });

  it("filters by product, store and a saved audience; open tracking adds the image only when asked", async () => {
    h.setNow(new Date(NOW));
    await people();
    const aud = await v2("/audiences", { method: "POST", json: { name: "Android", rules: { groups: [{ conditions: [{ field: "latestStore", operator: "is", value: "play_store" }] }] } } });
    const filtered = await v2("/winback_campaigns", { method: "POST", json: campaign({ audience: { churned_min_days: 1, churned_max_days: 30, product_ids: [], stores: [], audience_id: aud.body.id }, track_opens: true }) });
    expect((await v2(`/winback_campaigns/${filtered.body.id}/actions/preview`, { method: "POST" })).body.eligible).toBe(1);
    const byProduct = await v2("/winback_campaigns", { method: "POST", json: campaign({ audience: { churned_min_days: 1, churned_max_days: 30, product_ids: ["pro_monthly"], stores: ["app_store"], audience_id: null } }) });
    expect((await v2(`/winback_campaigns/${byProduct.body.id}/actions/preview`, { method: "POST" })).body.sample.map((s: any) => s.app_user_id)).toEqual(["lapsed_ios"]);
    expect((await v2("/winback_campaigns", { method: "POST", json: campaign({ audience: { churned_min_days: 1, churned_max_days: 30, product_ids: [], stores: [], audience_id: "aud_missing" } }) })).status).toBe(400);
    expect((await v2("/winback_campaigns", { method: "POST", json: campaign({ offer: { type: "url", url: "http://insecure.example.com" } }) })).status).toBe(400);

    await v2(`/winback_campaigns/${filtered.body.id}/actions/run`, { method: "POST" });
    const [send] = await h.db.select().from(schema.winbackSends);
    expect(mail.sent[0]!.html).toContain(`https://app.example.test/v1/winback/o/${send!.token}`);
    const pixel = await h.fetch(`/v1/winback/o/${send!.token}`, { key: "" });
    expect(pixel.headers.get("content-type")).toBe("image/gif");
    expect((await h.db.select().from(schema.winbackSends).where(eq(schema.winbackSends.id, send!.id)))[0]!.openedAt).not.toBeNull();
  });

  it("the tick sends active campaigns once a day at their hour; drafts and paused campaigns never send", async () => {
    h.setNow(new Date(NOW));
    await people();
    const active = await v2("/winback_campaigns", { method: "POST", json: campaign({ send_hour_utc: 14 }) });
    await v2("/winback_campaigns", { method: "POST", json: campaign({ name: "Draft", status: "draft", send_hour_utc: 0 }) });
    const deps = (at: number) => ({ db: h.db, mailer: mail, now: () => new Date(at) });
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T13:59:00Z")), "https://app.example.test")).toBe(0);
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T14:05:00Z")), "https://app.example.test")).toBe(2);
    await subscriber("lapsed_later", { endedDaysAgo: 4, email: "later@example.com" });
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T20:00:00Z")), "https://app.example.test")).toBe(0);
    expect(await runDueCampaigns(deps(Date.parse("2026-09-02T14:00:00Z")), "https://app.example.test")).toBe(1);
    await v2(`/winback_campaigns/${active.body.id}`, { method: "POST", json: { status: "paused" } });
    await subscriber("lapsed_last", { endedDaysAgo: 4, email: "last@example.com" });
    expect(await runDueCampaigns(deps(Date.parse("2026-09-03T14:00:00Z")), "https://app.example.test")).toBe(0);
    // Without REVENUEDOT_PUBLIC_URL the tick uses the dashboard origin saved with the campaign.
    await v2(`/winback_campaigns/${active.body.id}`, { method: "POST", json: { status: "active" } });
    expect(await runDueCampaigns(deps(Date.parse("2026-09-04T14:00:00Z")))).toBe(1);
  });

  it("sends a test email and refuses to run a draft", async () => {
    const draft = await v2("/winback_campaigns", { method: "POST", json: campaign({ status: "draft", offer: { type: "url", url: "https://scanner.app/comeback" } }) });
    const test = await v2(`/winback_campaigns/${draft.body.id}/actions/send_test`, { method: "POST", json: { email: "me@scanner.app" } });
    expect(test.body).toEqual({ object: "winback_test", sent_to: "me@scanner.app" });
    expect(mail.sent[0]).toMatchObject({ to: "me@scanner.app", subject: "[Test] We saved your scans" });
    expect((await v2(`/winback_campaigns/${draft.body.id}/actions/run`, { method: "POST" })).status).toBe(422);
    expect((await v2(`/winback_campaigns/${draft.body.id}`, { method: "DELETE" })).body.object).toBe("winback_campaign");
    expect((await v2(`/winback_campaigns/${draft.body.id}`)).status).toBe(404);
  });

  it("a tick sends at most SENDS_PER_TICK emails across campaigns and finishes the run in the next ticks", async () => {
    h.setNow(new Date(NOW));
    for (let i = 0; i < 60; i++) await subscriber(`lapsed_${i}`, { endedDaysAgo: 10, email: `lapsed${i}@example.com` });
    const a = await v2("/winback_campaigns", { method: "POST", json: campaign({ name: "A", send_hour_utc: 14 }) });
    const b = await v2("/winback_campaigns", { method: "POST", json: campaign({ name: "B", send_hour_utc: 14 }) });
    const deps = (at: number) => ({ db: h.db, mailer: mail, now: () => new Date(at) });
    expect(SENDS_PER_TICK).toBe(100);
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T14:00:00Z")), "https://app.example.test")).toBe(100);
    // The unfinished campaign has no last run yet, so the next tick goes on with it; then both are done for the day.
    const runs = async () => Object.fromEntries((await h.db.select().from(schema.winbackCampaigns)).map((c) => [c.id, c.lastRunAt?.toISOString() ?? null]));
    expect(Object.values(await runs()).filter(Boolean)).toHaveLength(1);
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T14:01:00Z")), "https://app.example.test")).toBe(20);
    expect(await runs()).toEqual({ [a.body.id]: expect.any(String), [b.body.id]: expect.any(String) });
    expect(await runDueCampaigns(deps(Date.parse("2026-09-01T14:02:00Z")), "https://app.example.test")).toBe(0);
    expect(mail.sent).toHaveLength(120);
    // The email speaks for the app: the From name is the sender name, or the project's name.
    expect(new Set(mail.sent.map((m) => m.fromName))).toEqual(new Set(["Scanner"]));
  });

  it("List-Unsubscribe is sent only with an https link; test emails are rate limited and go to one plain address", async () => {
    h.setNow(new Date(NOW));
    await subscriber("lapsed_http", { endedDaysAgo: 10, email: "http@example.com" });
    const c = await v2("/winback_campaigns", { method: "POST", json: campaign({ email: { ...campaign().email, sender_name: "Scanner Pro" } }) });
    const [row] = await h.db.select().from(schema.winbackCampaigns).where(eq(schema.winbackCampaigns.id, c.body.id));
    await runCampaign({ db: h.db, mailer: mail, now: () => new Date(NOW) }, row!, "http://localhost:8080");
    expect(mail.sent[0]).toMatchObject({ to: "http@example.com", fromName: "Scanner Pro" });
    expect(mail.sent[0]!.headers).toBeUndefined();

    expect((await v2(`/winback_campaigns/${c.body.id}/actions/send_test`, { method: "POST", json: { email: "me@scanner.app?cc=x@evil.example" } })).status).toBe(400);
    expect((await v2(`/winback_campaigns/${c.body.id}/actions/send_test`, { method: "POST", json: { email: "a@x.example, b@y.example" } })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await v2(`/winback_campaigns/${c.body.id}/actions/send_test`, { method: "POST", json: { email: "me@scanner.app" } })).status).toBe(200);
    expect((await v2(`/winback_campaigns/${c.body.id}/actions/send_test`, { method: "POST", json: { email: "me@scanner.app" } })).status).toBe(429);
  });

  it("never emails a customer whose $email is not one plain address", async () => {
    h.setNow(new Date(NOW));
    await subscriber("bad_1", { endedDaysAgo: 10, email: "victim@x.example?bcc=me@evil.example" });
    await subscriber("bad_2", { endedDaysAgo: 10, email: "a@x.example,b@y.example" });
    await subscriber("good", { endedDaysAgo: 10, email: "good@example.com" });
    const c = await v2("/winback_campaigns", { method: "POST", json: campaign() });
    expect((await v2(`/winback_campaigns/${c.body.id}/actions/run`, { method: "POST" })).body.sent).toBe(1);
    expect(mail.sent.map((m) => m.to)).toEqual(["good@example.com"]);
  });

  it("an audience a campaign uses cannot be deleted", async () => {
    const aud = await v2("/audiences", { method: "POST", json: { name: "US", rules: { groups: [{ conditions: [{ field: "country", operator: "is", value: "US" }] }] } } });
    const c = await v2("/winback_campaigns", { method: "POST", json: campaign({ audience: { churned_min_days: 1, churned_max_days: 30, product_ids: [], stores: [], audience_id: aud.body.id } }) });
    const del = await v2(`/audiences/${aud.body.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(del.body.message).toContain("Come back in September");
    await v2(`/winback_campaigns/${c.body.id}`, { method: "DELETE" });
    expect((await v2(`/audiences/${aud.body.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("offer links: App Store subscriptions page, the Play Store page for the product, or the campaign's URL", () => {
    expect(offerUrlFor({ type: "store" }, { store: "app_store", productId: "pro_monthly", bundleId: "com.x" })).toBe("https://apps.apple.com/account/subscriptions");
    expect(offerUrlFor({ type: "store" }, { store: "play_store", productId: "pro:monthly", bundleId: "com.x" })).toBe("https://play.google.com/store/account/subscriptions?sku=pro&package=com.x");
    expect(offerUrlFor({ type: "store" }, { store: "stripe", productId: "price_1", bundleId: null })).toBeNull();
    expect(offerUrlFor({ type: "url", url: "https://x.example/back" }, { store: "app_store", productId: "p", bundleId: null })).toBe("https://x.example/back");
  });
});
