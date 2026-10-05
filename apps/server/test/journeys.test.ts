// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: onboarding and growth emails to Cloud accounts (prd/onboarding-emails/PRD.md): the rules that pick a step,
// the caps and send windows, the tick pass with claims, one-click unsubscribe, the welcome's path links, referral and
// time zone at sign-up, the RevenueCat import marker, and every template rendering cleanly.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { inWindow, localTime, MIN_GAP_MS, pickStep, runJourneys, STEPS, type Facts, type JourneyConfig } from "../src/services/journeys.js";
import { journeyEmail, STEP_IDS, VIDEOS, videoUrl, type StepId } from "../src/mail/journeys.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const H = 3_600_000, D = 24 * H;
const SINCE = new Date("2026-09-01T00:00:00Z");
const cfg: JourneyConfig = { since: SINCE, exclude: ["circo.so", "qa@example.com"] };
// Wednesday 2026-09-30, 15:00 UTC = 11:00 in New York: inside every send window.
const WED = Date.parse("2026-09-30T15:00:00Z");

function facts(o: Partial<Facts> = {}): Facts {
  return {
    userId: "usr_1", email: "maya@habitly.app", name: "Maya Chen", createdAt: WED - 10 * 60_000, verified: true, timeZone: "America/New_York",
    path: null, referralCode: null, productEmails: true, projectId: "proj_1", projectName: "Habitly", ownsProjects: true, memberOf: null,
    firstAppAt: null, testPurchaseAt: null, sdkFirstAt: null, sdkLastAt: null, sdk: null, storeConnected: false, liveAt: null, lastSaleAt: null,
    firstSale: null, rcImportAt: null, importedCustomers: 0, paywallPublishedAt: null, experimentStartedAt: null, teammates: 0, recoveryOn: false,
    assistantConnected: false, plan: "free", planSince: null, canceledAt: null, tracked: 0, free100At: null, alertAt: null, lastNotificationAt: null,
    referralJoinedAt: null, overTracked: 0, sdkCustomers: 0, customers: 0, sent: new Map(), ...o,
  };
}
const sent = (...steps: [StepId, number][]) => new Map<StepId, number>(steps);

describe("picking the step", () => {
  it("welcomes a new owner 5 minutes after sign-up, and only once", () => {
    expect(pickStep(facts({ createdAt: WED - 60_000 }), WED, cfg)).toBeNull();
    expect(pickStep(facts(), WED, cfg)).toBe("welcome");
    expect(pickStep(facts({ sent: sent(["welcome", WED - 5 * 60_000]) }), WED, cfg)).toBeNull();
  });

  it("sends no onboarding to accounts created before the launch, but still celebrates a first sale", () => {
    const old = { createdAt: Date.parse("2026-08-01T00:00:00Z") };
    expect(pickStep(facts(old), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...old, liveAt: WED - H }), WED, cfg)).toBe("first_sale");
    // A celebration older than 3 days is stale.
    expect(pickStep(facts({ ...old, liveAt: WED - 4 * D }), WED, cfg)).not.toBe("first_sale");
  });

  it("nudges only when the next step is missing: connect the app, then the stores", () => {
    const welcomed = sent(["welcome", WED - 3 * D]);
    const created = WED - 3 * D;
    // Nothing built yet: a quiet account gets no nudge before day 10.
    expect(pickStep(facts({ createdAt: created, sent: welcomed }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ createdAt: created, sent: welcomed, firstAppAt: created, testPurchaseAt: WED - 21 * H }), WED, cfg)).toBe("connect_app");
    expect(pickStep(facts({ createdAt: created, sent: welcomed, firstAppAt: created, sdkFirstAt: WED - 25 * H, sdk: { platform: "Flutter", version: "9.6.1" } }), WED, cfg)).toBe("store_keys");
    // Store connected and no paywall: the paywall email, but not for someone switching (they already have one).
    const ready = { createdAt: WED - 5 * D, sent: welcomed, firstAppAt: created, sdkFirstAt: WED - 3 * D - H, storeConnected: true };
    expect(pickStep(facts(ready), WED, cfg)).toBe("paywall");
    expect(pickStep(facts({ ...ready, paywallPublishedAt: WED - D }), WED, cfg)).toBeNull();
    // A switcher in the same spot hasn't imported yet, so they get the import email instead.
    expect(pickStep(facts({ ...ready, path: "revenuecat" }), WED, cfg)).toBe("need_hand");
    // The paywall email waits two days after the store email.
    expect(pickStep(facts({ ...ready, sent: sent(["welcome", WED - 5 * D], ["store_keys", WED - D]) }), WED, cfg)).toBeNull();
  });

  it("sends one email matched to where someone is stuck: day 5 for builders, day 3 for switchers who never imported", () => {
    const builder = facts({ createdAt: WED - 5 * D - H, sent: sent(["welcome", WED - 5 * D]) });
    expect(pickStep(builder, WED, cfg)).toBe("need_hand");
    expect(pickStep({ ...builder, createdAt: WED - 4 * D }, WED, cfg)).toBeNull();
    expect(pickStep({ ...builder, sent: sent(["welcome", WED - 5 * D], ["need_hand", WED - H]) }, WED, cfg)).toBeNull();
    expect(pickStep({ ...builder, sdkFirstAt: WED - 2 * D, storeConnected: true, paywallPublishedAt: WED - D }, WED, cfg)).toBeNull();
    const switcher = facts({ path: "revenuecat", createdAt: WED - 3 * D - H, sent: sent(["welcome", WED - 3 * D]) });
    expect(pickStep(switcher, WED, cfg)).toBe("need_hand");
    expect(pickStep({ ...switcher, rcImportAt: WED - 2 * D, sent: sent(["welcome", WED - 3 * D], ["side_by_side", WED - D - H]) }, WED, cfg)).toBeNull();
    // Later stuck points: no store five days after the store email; for switchers, no notifications five days after side_by_side.
    const noStore = facts({ createdAt: WED - 12 * D, sdkFirstAt: WED - 7 * D, sent: sent(["welcome", WED - 12 * D], ["store_keys", WED - 5 * D - H]) });
    expect(pickStep(noStore, WED, cfg)).toBe("need_hand");
    expect(pickStep({ ...noStore, storeConnected: true, paywallPublishedAt: WED - D }, WED, cfg)).toBeNull();
    const quiet = facts({ path: "revenuecat", createdAt: WED - 12 * D, rcImportAt: WED - 7 * D, sent: sent(["welcome", WED - 12 * D], ["side_by_side", WED - 5 * D - H]) });
    expect(pickStep(quiet, WED, cfg)).toBe("need_hand");
    expect(pickStep({ ...quiet, lastNotificationAt: WED - D }, WED, cfg)).toBeNull();
  });


  it("asks someone already selling to add the SDK even when store notifications already show sales", () => {
    const f = facts({ createdAt: WED - 3 * D - H, firstAppAt: WED - 3 * D, storeConnected: true, liveAt: WED - 2 * D, lastSaleAt: WED - H, sent: sent(["welcome", WED - 3 * D], ["first_sale", WED - 2 * D]) });
    expect(pickStep(f, WED, cfg)).toBe("connect_app");
  });

  it("never nudges for a step already done", () => {
    const f = facts({ createdAt: WED - 2 * D, sent: sent(["welcome", WED - 2 * D]), testPurchaseAt: WED - 30 * H, firstAppAt: WED - 31 * H, sdkFirstAt: WED - 2 * H });
    // SDK done: no connect_app; store_keys waits for its day.
    expect(pickStep(f, WED, cfg)).toBeNull();
  });

  it("sends a migrator the side-by-side note after the import and no new-developer nudges", () => {
    const base = { createdAt: WED - 2 * D, sent: sent(["welcome", WED - 2 * D]) };
    expect(pickStep(facts({ ...base, path: "revenuecat" }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...base, rcImportAt: WED - 25 * H, firstAppAt: WED - D }), WED, cfg)).toBe("side_by_side");
    // Never the new-developer emails: no connect_app even with an app and a test purchase.
    expect(pickStep(facts({ ...base, path: "revenuecat", firstAppAt: WED - D, testPurchaseAt: WED - 21 * H }), WED, cfg)).toBeNull();
  });

  it("sends the cutover email a week after a migrator's first live sale, before anything else", () => {
    const f = { path: "revenuecat" as const, createdAt: WED - 30 * D, rcImportAt: WED - 25 * D, liveAt: WED - 8 * D, sdkFirstAt: WED - 9 * D, sdkCustomers: 25, lastSaleAt: WED - H, tracked: 6_000 };
    expect(pickStep(facts(f), WED, cfg)).toBe("cutover");
    // Not while only a test build talks to RevenueDot; still on time when the update reaches customers weeks later.
    expect(pickStep(facts({ ...f, sdkCustomers: 2, sent: sent(["first_sale", WED - 8 * D]) }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...f, liveAt: WED - 40 * D }), WED, cfg)).toBe("cutover");
    // A small app needs a tenth of its customers on the update (at least 3), not 25.
    expect(pickStep(facts({ ...f, customers: 40, sdkCustomers: 4 }), WED, cfg)).toBe("cutover");
    expect(pickStep(facts({ ...f, customers: 40, sdkCustomers: 2 }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...f, customers: 250, sdkCustomers: 24 }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...f, sent: sent(["cutover", WED - 2 * D]) }), WED, cfg)).toBeNull();
  });

  it("keeps at most one email every 44 hours, except the welcome and verification reminder", () => {
    const f = facts({ createdAt: WED - 10 * D - H, sent: sent(["welcome", WED - 10 * D], ["connect_app", WED - MIN_GAP_MS + H]), firstAppAt: WED - 10 * D });
    expect(pickStep(f, WED, cfg)).toBeNull();
    expect(pickStep(f, WED + H, cfg)).toBe("need_hand");
    const unverified = facts({ createdAt: WED - 25 * H, verified: false, sent: sent(["welcome", WED - 25 * H]) });
    expect(pickStep(unverified, WED, cfg)).toBe("verify_reminder");
  });

  it("holds nudges outside 09:00–17:00 weekdays in the reader's time zone", () => {
    const f = facts({ createdAt: WED - 10 * D, sent: sent(["welcome", WED - 10 * D]) });
    const nightInTokyo = { ...f, timeZone: "Asia/Tokyo" }; // 00:00 in Tokyo
    expect(pickStep(nightInTokyo, WED, cfg)).toBeNull();
    const saturday = Date.parse("2026-10-03T15:00:00Z");
    expect(pickStep({ ...f, createdAt: saturday - 10 * D }, saturday, cfg)).toBeNull();
    expect(localTime(WED, "Not/AZone")).toEqual(localTime(WED, "America/New_York"));
    expect(inWindow(STEPS.find((x) => x.id === "first_sale")!, saturday, "America/New_York")).toBe(true);
  });

  it("stays quiet within 24 hours of an alert email, except for the welcome", () => {
    const f = facts({ createdAt: WED - 10 * D - H, sent: sent(["welcome", WED - 10 * D]), alertAt: WED - 2 * H });
    expect(pickStep(f, WED, cfg)).toBeNull();
    expect(pickStep(facts({ alertAt: WED - H }), WED, cfg)).toBe("welcome");
  });

  it("sends a first sale and the Standard receipt right away, even inside the 44-hour gap", () => {
    const recent = sent(["welcome", WED - 6 * D], ["store_keys", WED - H]);
    expect(pickStep(facts({ createdAt: WED - 6 * D, sdkFirstAt: WED - 2 * D, storeConnected: true, liveAt: WED - H, lastSaleAt: WED - H, sent: recent }), WED, cfg)).toBe("first_sale");
    expect(pickStep(facts({ createdAt: WED - 60 * D, plan: "standard", planSince: WED - H, sent: recent }), WED, cfg)).toBe("standard_welcome");
  });


  it("sends nothing to a live account but the one-off emails: no growth tips, referral asks or win-backs", () => {
    const live = facts({ createdAt: WED - 40 * D, liveAt: WED - 29 * D, lastSaleAt: WED - D, sdkLastAt: WED - H, tracked: 6_000 });
    expect(pickStep(live, WED, cfg)).toBeNull();
    expect(pickStep({ ...live, lastSaleAt: WED - 9 * D, sdkLastAt: WED - 8 * D }, WED, cfg)).toBeNull();
    expect(pickStep(facts({ createdAt: WED - 60 * D, canceledAt: WED - D }), WED, cfg)).toBeNull();
  });

  it("counts the verification reminder towards the 44-hour gap, so day 1 brings one email", () => {
    const f = facts({ createdAt: WED - 24 * H - 10 * 60_000, verified: false, sent: sent(["welcome", WED - 24 * H], ["verify_reminder", WED - 5 * 60_000]) });
    expect(pickStep(f, WED, cfg)).toBeNull();
  });

  it("thanks Standard once from its first start after launch", () => {
    expect(pickStep(facts({ createdAt: WED - 60 * D, plan: "standard", planSince: WED - D }), WED, cfg)).toBe("standard_welcome");
  });

  it("gives a teammate who joined by invite one welcome and nothing else", () => {
    const f = facts({ ownsProjects: false, memberOf: { projectId: "proj_9", projectName: "Habitly", inviter: "Maya" }, projectId: null });
    expect(pickStep(f, WED, cfg)).toBe("teammate_welcome");
    expect(pickStep({ ...f, createdAt: WED - 3 * D, sent: sent(["teammate_welcome", WED - 3 * D]) }, WED, cfg)).toBeNull();
  });
});

describe("the tick pass", { timeout: 120_000 }, () => {
  async function cloud() {
    s = await accountServer({ edition: "cloud" });
    s.setNow(new Date("2026-09-30T14:00:00Z")); // 10:00 in New York
    return s;
  }
  /** Sign-up stamps created_at with the database clock; the test clock is what the rules read. */
  const signup = async (email: string, extra: Record<string, unknown> = {}) => {
    await s!.signup(email, extra);
    await s!.db.update(schema.users).set({ createdAt: s!.now() }).where(eq(schema.users.email, email));
  };
  const run = () => runJourneys({ db: s!.db, mailer: s!.mail, publicUrl: "https://dash.example.com", config: cfg }, s!.now());
  const journeyMails = (to: string) => s!.mail.sent.filter((m) => m.to === to && m.from?.includes("hello@mail.revenuedot.app"));

  it("sends the welcome from RevenueDot once, with one-click unsubscribe, and the unsubscribe turns them off", async () => {
    await cloud();
    await signup("maya@habitly.app", { name: "Maya Chen", time_zone: "America/New_York" });
    await s!.settle();
    expect((await run()).sent).toBe(0); // not 5 minutes yet
    s!.advance(6 * 60_000);
    expect((await run()).sent).toBe(1);
    expect((await run()).sent).toBe(0);
    const [m] = journeyMails("maya@habitly.app");
    expect(m!.subject).toContain("Welcome to RevenueDot");
    expect(m!.replyTo).toBe("hello@revenuedot.app");
    expect(m!.text).toContain("Welcome to RevenueDot, Maya");
    const unsub = /<(https:\/\/dash\.example\.com\/auth\/journeys\/unsubscribe\/[^>]+)>/.exec(m!.headers!["List-Unsubscribe"]!)![1]!;
    const path = new URL(unsub).pathname;
    const raw = (method: string, p: string) => s!.app.fetch(new Request(`http://localhost${p}`, { method }));
    const get = await raw("GET", path);
    expect(get.status).toBe(200);
    const [u0] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "maya@habitly.app"));
    expect(u0!.productEmails).toBe(true);
    expect(u0!.timeZone).toBe("America/New_York");
    expect((await raw("POST", path)).status).toBe(200);
    const [u1] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "maya@habitly.app"));
    expect(u1!.productEmails).toBe(false);
    expect((await raw("POST", "/auth/journeys/unsubscribe/not-a-real-token-at-all-xx")).status).toBe(404);
    // Unsubscribed (and confirmed, so no verification reminder): day 1 brings nothing.
    await s!.db.update(schema.users).set({ emailVerifiedAt: s!.now() }).where(eq(schema.users.email, "maya@habitly.app"));
    s!.advance(D);
    expect((await run()).sent).toBe(0);
  });

  it("records a one-click rating only after the reader confirms it", async () => {
    await cloud();
    await signup("rita@notes.app");
    s!.advance(6 * 60_000);
    await run();
    const m = journeyMails("rita@notes.app")[0]!;
    const token = /\/auth\/journeys\/unsubscribe\/([A-Za-z0-9_-]+)/.exec(m.headers!["List-Unsubscribe"]!)![1]!;
    const url = `/auth/journeys/feedback/${token}?kind=nps&value=9`;
    const get = await s!.app.fetch(new Request(`http://localhost${url}`));
    expect(get.status).toBe(200);
    expect(await s!.db.select().from(schema.journeyFeedback)).toHaveLength(0);
    const post = await s!.app.fetch(new Request(`http://localhost/auth/journeys/feedback/${token}`, { method: "POST", body: new URLSearchParams({ kind: "nps", value: "9", comment: "Love the importer" }) }));
    expect(post.status).toBe(200);
    const [row] = await s!.db.select().from(schema.journeyFeedback);
    expect(row).toMatchObject({ kind: "nps", value: "9", comment: "Love the importer" });
    expect((await s!.app.fetch(new Request(`http://localhost/auth/journeys/feedback/${token}?kind=nps&value=42`))).status).toBe(404);
  });

  it("records the switching path only when the reader confirms it, so a mail scanner cannot", async () => {
    await cloud();
    await signup("sam@ai.dev");
    s!.advance(6 * 60_000);
    await run();
    const m = journeyMails("sam@ai.dev")[0]!;
    const link = /https:\/\/dash\.example\.com(\/auth\/journeys\/path\/[^?"]+\?path=revenuecat)/.exec(m.html.replace(/&amp;/g, "&"))![1]!;
    const user = async () => (await s!.db.select().from(schema.users).where(eq(schema.users.email, "sam@ai.dev")))[0]!;
    const get = await s!.app.fetch(new Request(`http://localhost${link}`));
    expect(get.status).toBe(200);
    expect((await user()).journeyPath).toBeNull();
    const post = await s!.app.fetch(new Request(`http://localhost${link.split("?")[0]}`, { method: "POST" }));
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toContain("/docs/migrate");
    expect((await user()).journeyPath).toBe("revenuecat");
    // The main button goes straight to the dashboard; no path is recorded for it.
    expect(m.html).toContain("https://dash.example.com/projects/");
  });


  it("skips excluded domains and addresses", async () => {
    await cloud();
    await signup("kai@circo.so");
    await signup("qa@example.com");
    s!.advance(6 * 60_000);
    expect((await run()).sent).toBe(0);
  });

  it("still sends the verification reminder to someone who turned product emails off", async () => {
    await cloud();
    await signup("lena@health.eu");
    await s!.db.update(schema.users).set({ productEmails: false }).where(eq(schema.users.email, "lena@health.eu"));
    s!.advance(6 * 60_000);
    expect((await run()).sent).toBe(0);
    s!.advance(D);
    expect((await run()).sent).toBe(1);
    expect(journeyMails("lena@health.eu")[0]!.subject).toContain("Confirm your email");
  });

  it("keeps the referral code from sign-up and celebrates the first live sale", async () => {
    await cloud();
    await signup("jordan@photo.app", { ref: "k7m2q9xa", time_zone: "Nowhere/Invalid" });
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "jordan@photo.app"));
    expect(u!.referredBy).toBe("k7m2q9xa");
    expect(u!.timeZone).toBeNull();
    s!.advance(6 * 60_000);
    await run(); // welcome
    const [p] = await s!.db.select().from(schema.projects).where(eq(schema.projects.ownerUserId, u!.id));
    await s!.db.insert(schema.apps).values({ id: "app_j", projectId: p!.id, name: "Photo iOS", type: "app_store", publicKey: "appl_j" });
    await s!.db.insert(schema.sdkVersions).values({ projectId: p!.id, appId: "app_j", platform: "iOS", sdkVersion: "5.91.0", firstSeenAt: new Date(s!.now().getTime() - D), lastSeenAt: s!.now() });
    await s!.db.insert(schema.customers).values({ id: "cus_j", projectId: p!.id, originalAppUserId: "u1", firstSeen: s!.now(), lastSeen: s!.now() });
    await s!.db.insert(schema.transactions).values({ id: "tx_j", projectId: p!.id, customerId: "cus_j", appId: "app_j", store: "app_store", storeTransactionId: "1", productIdentifier: "pro_annual", kind: "purchase", purchasedAt: s!.now(), revenueUsd: 39.99, priceAmount: 39.99, priceCurrency: "USD", countryCode: "DE", isSandbox: false, createdAt: s!.now() });
    s!.advance(H);
    expect((await run()).sent).toBe(1);
    const sale = journeyMails("jordan@photo.app").at(-1)!;
    expect(sale.subject).toBe("You made your first real sale");
    expect(sale.text).toContain("pro_annual");
    expect(sale.text).toContain("Germany");
  });

  it("tells a converted trial apart from an app that already sold before RevenueDot", async () => {
    await cloud();
    await signup("lee@yoga.app");
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "lee@yoga.app"));
    const [p] = await s!.db.select().from(schema.projects).where(eq(schema.projects.ownerUserId, u!.id));
    const { loadFacts } = await import("../src/services/journeys.js");
    const tx = (id: string, customerId: string, kind: string, revenue: number, at: Date) => ({ id, projectId: p!.id, customerId, store: "app_store", storeTransactionId: id, productIdentifier: "yoga_annual",
      kind, purchasedAt: at, revenueUsd: revenue, priceAmount: revenue, priceCurrency: "USD", countryCode: "US", isSandbox: false, createdAt: at });
    const now = s!.now(), earlier = new Date(now.getTime() - 3 * D);
    await s!.db.insert(schema.sdkVersions).values({ projectId: p!.id, platform: "iOS", sdkVersion: "5.91.0", firstSeenAt: new Date(earlier.getTime() - D), lastSeenAt: now });
    await s!.db.insert(schema.customers).values([{ id: "cus_t", projectId: p!.id, originalAppUserId: "t", firstSeen: earlier, lastSeen: now }, { id: "cus_o", projectId: p!.id, originalAppUserId: "o", firstSeen: now, lastSeen: now }]);
    // A trial that converts: the trial start is an earlier row, so this is still the app's first real sale.
    await s!.db.insert(schema.transactions).values([tx("t1", "cus_t", "purchase", 0, earlier), tx("t2", "cus_t", "renewal", 59.99, now)]);
    let [f] = await loadFacts(s!.db, [u!.id], now, SINCE);
    expect(f!.firstSale!.existing).toBe(false);
    // A new purchase before any SDK call: the app sold before it came to RevenueDot.
    await s!.db.delete(schema.transactions).where(eq(schema.transactions.projectId, p!.id));
    await s!.db.delete(schema.sdkVersions).where(eq(schema.sdkVersions.projectId, p!.id));
    await s!.db.insert(schema.transactions).values([tx("n1", "cus_o", "purchase", 59.99, now)]);
    [f] = await loadFacts(s!.db, [u!.id], now, SINCE);
    expect(f!.firstSale!.existing).toBe(true);
    await s!.db.insert(schema.sdkVersions).values({ projectId: p!.id, platform: "iOS", sdkVersion: "5.91.0", firstSeenAt: new Date(earlier.getTime() - D), lastSeenAt: now });
    // A renewal from a subscriber RevenueDot never saw start: the app sold before it came to RevenueDot.
    await s!.db.delete(schema.transactions).where(eq(schema.transactions.projectId, p!.id));
    await s!.db.insert(schema.transactions).values([tx("o1", "cus_o", "renewal", 59.99, now)]);
    [f] = await loadFacts(s!.db, [u!.id], now, SINCE);
    expect(f!.firstSale!.existing).toBe(true);
  });

  it("counts customers seen through the SDK for a switcher, never imported ones, and stops after 25", async () => {
    await cloud();
    await signup("maya@habitly.app");
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "maya@habitly.app"));
    const [p] = await s!.db.select().from(schema.projects).where(eq(schema.projects.ownerUserId, u!.id));
    const { loadFacts } = await import("../src/services/journeys.js");
    const now = s!.now();
    const customers = (n: number, prefix: string, sdk: string | null) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, projectId: p!.id, originalAppUserId: `${prefix}${i}`, firstSeen: now, lastSeen: now, lastSeenSdkVersion: sdk }));
    await s!.db.insert(schema.customers).values([...customers(40, "imp", null), ...customers(3, "dbg", "5.91.0")]);
    // Not a switcher yet: nothing counted.
    expect((await loadFacts(s!.db, [u!.id], now, SINCE))[0]!.sdkCustomers).toBe(0);
    await s!.db.update(schema.projects).set({ rcImportAt: now }).where(eq(schema.projects.id, p!.id));
    expect((await loadFacts(s!.db, [u!.id], now, SINCE))[0]!.sdkCustomers).toBe(3);
    await s!.db.insert(schema.customers).values(customers(30, "app", "5.91.0"));
    const f = (await loadFacts(s!.db, [u!.id], now, SINCE))[0]!;
    expect(f.sdkCustomers).toBe(25);
    expect(f.customers).toBe(73);
  });

  it("never counts an imported purchase as a live sale, and gives a failed send's step back", async () => {
    await cloud();
    await signup("dana@fit.app");
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "dana@fit.app"));
    const [p] = await s!.db.select().from(schema.projects).where(eq(schema.projects.ownerUserId, u!.id));
    await s!.db.insert(schema.customers).values({ id: "cus_i", projectId: p!.id, originalAppUserId: "i1", firstSeen: s!.now(), lastSeen: s!.now() });
    // Bought yesterday, written by an import just now.
    await s!.db.insert(schema.transactions).values({ id: "tx_i", projectId: p!.id, customerId: "cus_i", store: "app_store", storeTransactionId: "i1", productIdentifier: "pro", kind: "renewal",
      purchasedAt: new Date(s!.now().getTime() - D), revenueUsd: 9.99, isSandbox: false, source: "import", createdAt: s!.now() });
    const { loadFacts, sendStep } = await import("../src/services/journeys.js");
    const [f] = await loadFacts(s!.db, [u!.id], s!.now(), SINCE);
    expect(f!.liveAt).toBeNull();
    // A mailer that fails: the claim is released, so the step can go out later.
    const failing = { driver: "memory" as const, send: async () => { throw new Error("rate limited"); } };
    expect(await sendStep({ db: s!.db, mailer: failing, publicUrl: "https://dash.example.com", config: cfg }, f!, "welcome", s!.now())).toBe(false);
    expect(await s!.db.select().from(schema.journeySends).where(eq(schema.journeySends.userId, u!.id))).toHaveLength(0);
  });

  it("marks a project as migrating on its first RevenueCat import", async () => {
    await cloud();
    const { client, projectId } = await signup("lena@health.eu").then(async () => {
      const c = s!.client();
      await c.call("POST", "/auth/login", { email: "lena@health.eu", password: "correct horse battery" });
      const me = await c.call("GET", "/auth/me");
      return { client: c, projectId: me.body.projects[0].id as string };
    });
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "lena@health.eu"));
    await s!.db.update(schema.users).set({ emailVerifiedAt: s!.now() }).where(eq(schema.users.id, u!.id));
    const key = await client.call("POST", `/v2/projects/${projectId}/api_keys`, { name: "import", permissions: ["customer_information:customers:read_write"] });
    const sk = key.body.key ?? key.body.secret;
    expect(sk, JSON.stringify(key.body)).toBeTruthy();
    const r = await s!.client().call("POST", `/v2/projects/${projectId}/import/customers`, { customers: [{ id: "rc_1", first_seen_at: s!.now().getTime() - 90 * D }] }, { authorization: `Bearer ${sk}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [p] = await s!.db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(p!.rcImportAt).not.toBeNull();
  });
});

describe("templates", () => {
  it("render every step cleanly, under Gmail's clipping size, with tagged links", () => {
    for (const step of STEP_IDS) {
      const m = journeyEmail({
        step, app: "https://app.revenuedot.app", first: null, projectId: null, projectName: null, unsubscribeUrl: "https://app.revenuedot.app/auth/journeys/unsubscribe/x",
        tracked: 12_000, month: "October", bills: { revenuedot: 10, revenuecat: 120 }, priceRows: [[20_000, 50, 200]], referralUrl: "https://app.revenuedot.app/signup?ref=abc",
      });
      for (const part of [m.subject, m.text, m.html]) expect(part, step).not.toMatch(/undefined|NaN|\[object|href=""/);
      expect(Buffer.byteLength(m.html), step).toBeLessThan(102_000);
      expect(m.text, step).toContain("Unsubscribe: https://app.revenuedot.app/auth/journeys/unsubscribe/x");
      expect(m.text, step).not.toMatch(/\bKai\b|Founder/);
      expect(m.html, step).toMatch(/Questions\?|The RevenueDot team/);
      for (const [, url] of m.html.matchAll(/href="(https:\/\/(?:app\.)?revenuedot\.app\/(?!auth\/)[^"]*)"/g)) expect(url, step).toContain("utm_content=" + step);
    }
  });

  it("never mentions RevenueCat to someone who is not switching, and uses plain characters only", () => {
    const base = { app: "https://app.revenuedot.app", first: "Sam", projectId: "p", projectName: "Notes", unsubscribeUrl: "https://app.revenuedot.app/auth/journeys/unsubscribe/x",
      sdk: { platform: "Flutter", version: "9.6.1" }, sale: { product: "pro_annual", amount: "$39.99", country: "Germany" }, overTracked: 12_000, overMonth: "September",
      bills: { revenuedot: 10, revenuecat: 120 }, testPurchase: true };
    for (const step of STEP_IDS.filter((x) => !["side_by_side", "cutover"].includes(x))) {
      const m = journeyEmail({ ...base, step, migrating: false });
      const text = step === "welcome" ? m.text.replace("Switching from RevenueCat? Start here", "") : m.text;
      expect(`${m.subject}\n${text}`, step).not.toMatch(/RevenueCat/);
    }
    for (const step of STEP_IDS) for (const migrating of [false, true]) {
      const m = journeyEmail({ ...base, step, migrating });
      expect(`${m.subject}${m.text}${m.html}`, step).not.toMatch(/[^\x00-\x7F]/);
    }
  });

  it("celebrates a brand-new app's first sale, but tells an app that already sold that RevenueDot recorded it", () => {
    const base = { step: "first_sale" as const, app: "https://app.revenuedot.app", first: "Lee", projectId: "p", projectName: "Pocket Yoga", unsubscribeUrl: "https://app.revenuedot.app/auth/journeys/unsubscribe/x" };
    expect(journeyEmail({ ...base, sale: { product: "yoga_annual", amount: "$59.99", country: "Canada" } }).subject).toBe("You made your first real sale");
    const existing = journeyEmail({ ...base, sale: { product: "yoga_annual", amount: "$59.99", country: "Canada", existing: true } });
    expect(existing.subject).toBe("RevenueDot recorded its first Pocket Yoga sale");
    expect(existing.text).not.toMatch(/first real sale|Congratulations/);
  });

  it("never turns a name someone else chose into a link", () => {
    const m = journeyEmail({ step: "teammate_welcome", app: "https://app.revenuedot.app", first: "Jo", projectId: "p", projectName: "[Your session expired, sign in](https://evil.example)",
      inviter: "**Admin**", unsubscribeUrl: "https://app.revenuedot.app/auth/journeys/unsubscribe/x" });
    expect(m.html).not.toContain('href="https://evil.example');
    expect(m.text).not.toContain("(https://evil.example)");
    expect(m.html).not.toContain("<strong style=\"font-weight:600;color:#0A0A0A;\">Admin</strong> added");
  });

  it("links a video's own page first and keeps its YouTube copy as a separate address", () => {
    for (const id of Object.keys(VIDEOS) as (keyof typeof VIDEOS)[]) {
      expect(videoUrl(id)).toBe("https://revenuedot.app/watch/" + VIDEOS[id].slug);
      expect(VIDEOS[id].youtube).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
    }
  });
});
