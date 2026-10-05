// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: onboarding and growth emails to Cloud accounts (prd/onboarding-emails/PRD.md): the rules that pick a step,
// the caps and send windows, the tick pass with claims, one-click unsubscribe, the welcome's path links, referral and
// time zone at sign-up, the RevenueCat import marker, and every template rendering cleanly.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { inWindow, localTime, MIN_GAP_MS, pickStep, runJourneys, STEPS, type Facts, type JourneyConfig } from "../src/services/journeys.js";
import { journeyEmail, STEP_IDS, VIDEOS, type StepId } from "../src/mail/journeys.js";

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
    referralJoinedAt: null, sent: new Map(), ...o,
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

  it("follows the next missing step of a healthy account", () => {
    const welcomed = sent(["welcome", WED - 3 * D]);
    const created = WED - 3 * D;
    expect(pickStep(facts({ createdAt: created, sent: welcomed }), WED, cfg)).toBe("first_purchase");
    expect(pickStep(facts({ createdAt: created, sent: welcomed, firstAppAt: created, testPurchaseAt: WED - 21 * H }), WED, cfg)).toBe("connect_app");
    expect(pickStep(facts({ createdAt: created, sent: welcomed, firstAppAt: created, sdkFirstAt: WED - 25 * H, sdk: { platform: "Flutter", version: "9.6.1" } }), WED, cfg)).toBe("store_keys");
    expect(pickStep(facts({ createdAt: WED - 5 * D, sent: welcomed, firstAppAt: created, sdkFirstAt: WED - 3 * D, storeConnected: true }), WED, cfg)).toBe("go_live");
  });

  it("never nudges for a step already done", () => {
    const f = facts({ createdAt: WED - 2 * D, sent: sent(["welcome", WED - 2 * D]), testPurchaseAt: WED - 30 * H, firstAppAt: WED - 31 * H, sdkFirstAt: WED - 2 * H });
    // Test purchase and SDK both done: neither first_purchase nor connect_app; store_keys waits for its day.
    expect(pickStep(f, WED, cfg)).toBeNull();
  });

  it("asks what they are building on day 3 when no app exists", () => {
    const f = facts({ createdAt: WED - 3 * D - H, sent: sent(["welcome", WED - 3 * D], ["first_purchase", WED - 2 * D]) });
    expect(pickStep(f, WED, cfg)).toBe("checkin");
  });

  it("takes the RevenueCat path when the reader chose it or imported", () => {
    const base = { createdAt: WED - D - H, sent: sent(["welcome", WED - D]) };
    expect(pickStep(facts({ ...base, path: "revenuecat" }), WED, cfg)).toBe("switch_plan");
    expect(pickStep(facts({ ...base, rcImportAt: WED - 25 * H, firstAppAt: WED - D }), WED, cfg)).toBe("side_by_side");
  });

  it("keeps at most one email every 44 hours and three a week, except the welcome and verification reminder", () => {
    const f = facts({ createdAt: WED - 3 * D - H, sent: sent(["welcome", WED - 3 * D], ["first_purchase", WED - MIN_GAP_MS + H]) });
    expect(pickStep(f, WED, cfg)).toBeNull();
    expect(pickStep(f, WED + H, cfg)).toBe("checkin");
    const week = facts({ createdAt: WED - 30 * D, liveAt: WED - 13 * D, lastSaleAt: WED - H, sent: sent(["paywalls", WED - 6 * D], ["recovery", WED - 4 * D], ["team", WED - 2 * D]) });
    expect(pickStep(week, WED, cfg)).toBeNull();
    const unverified = facts({ createdAt: WED - 25 * H, verified: false, sent: sent(["welcome", WED - 25 * H], ["first_purchase", WED - 2 * H]) });
    expect(pickStep(unverified, WED, cfg)).toBe("verify_reminder");
  });

  it("holds nudges outside 09:00–17:00 weekdays in the reader's time zone", () => {
    const f = facts({ createdAt: WED - 3 * D, sent: sent(["welcome", WED - 3 * D]) });
    const nightInTokyo = { ...f, timeZone: "Asia/Tokyo" }; // 00:00 in Tokyo
    expect(pickStep(nightInTokyo, WED, cfg)).toBeNull();
    const saturday = Date.parse("2026-10-03T15:00:00Z");
    expect(pickStep({ ...f, createdAt: saturday - 3 * D }, saturday, cfg)).toBeNull();
    expect(localTime(WED, "Not/AZone")).toEqual(localTime(WED, "America/New_York"));
    expect(inWindow(STEPS.find((x) => x.id === "first_sale")!, saturday, "America/New_York")).toBe(true);
  });

  it("stays quiet within 24 hours of an alert email, except for the welcome", () => {
    const f = facts({ createdAt: WED - 3 * D - H, sent: sent(["welcome", WED - 3 * D]), alertAt: WED - 2 * H });
    expect(pickStep(f, WED, cfg)).toBeNull();
    expect(pickStep(facts({ alertAt: WED - H }), WED, cfg)).toBe("welcome");
  });

  it("stops onboarding after the last call", () => {
    const f = facts({ createdAt: WED - 40 * D, sent: sent(["last_call", WED - 19 * D]) });
    expect(pickStep(f, WED, cfg)).toBeNull();
  });

  it("walks the upgrade: pricing at $5,000, nudge 3 days after the $10,000 email, then a personal note", () => {
    const live = { createdAt: WED - 60 * D, liveAt: WED - 50 * D, lastSaleAt: WED - 5 * D, paywallPublishedAt: WED - 40 * D, experimentStartedAt: WED - 30 * D, recoveryOn: true, teammates: 2, assistantConnected: true, sent: sent(["referral", WED - 20 * D]) };
    expect(pickStep(facts({ ...live, tracked: 6_000 }), WED, cfg)).toBe("pricing_explainer");
    expect(pickStep(facts({ ...live, tracked: 12_000, free100At: WED - 2 * D }), WED, cfg)).toBeNull();
    expect(pickStep(facts({ ...live, tracked: 12_000, free100At: WED - 3 * D - H }), WED, cfg)).toBe("upgrade_nudge");
    const nudged = new Map(live.sent); nudged.set("upgrade_nudge", WED - 7 * D);
    expect(pickStep(facts({ ...live, sent: nudged, tracked: 14_000, free100At: WED - 10 * D - H }), WED, cfg)).toBe("upgrade_personal");
    expect(pickStep(facts({ ...live, tracked: 14_000, free100At: WED - 4 * D, plan: "standard" }), WED, cfg)).toBeNull();
  });

  it("asks how it's going after two live weeks, for a referral after four, and checks in when an app goes quiet", () => {
    const two = { createdAt: WED - 30 * D, liveAt: WED - 15 * D, paywallPublishedAt: WED - 14 * D, experimentStartedAt: WED - 10 * D, recoveryOn: true, teammates: 1, assistantConnected: true };
    expect(pickStep(facts({ ...two, lastSaleAt: WED - D, sdkLastAt: WED - H }), WED, cfg)).toBe("how_going");
    const live = { createdAt: WED - 40 * D, liveAt: WED - 29 * D, sent: sent(["how_going", WED - 14 * D]), paywallPublishedAt: WED - 20 * D, experimentStartedAt: WED - 15 * D, recoveryOn: true, teammates: 1, assistantConnected: true };
    expect(pickStep(facts({ ...live, lastSaleAt: WED - D, sdkLastAt: WED - H }), WED, cfg)).toBe("referral");
    expect(pickStep(facts({ ...live, lastSaleAt: WED - 9 * D, sdkLastAt: WED - 8 * D }), WED, cfg)).toBe("went_quiet");
  });

  it("helps migrators who have not imported, and checks that store notifications are forwarded after an import", () => {
    const rc = { path: "revenuecat" as const, createdAt: WED - 4 * D - H, sent: sent(["welcome", WED - 4 * D], ["switch_plan", WED - 3 * D]) };
    expect(pickStep(facts(rc), WED, cfg)).toBe("import_help");
    // Migrators never get the new-developer nudges.
    expect(pickStep(facts({ ...rc, createdAt: WED - 6 * D - H, sent: sent(["welcome", WED - 6 * D], ["switch_plan", WED - 5 * D], ["import_help", WED - 2 * D], ["checkin", WED - 2 * D]) }), WED, cfg)).toBeNull();
    const imported = { createdAt: WED - 8 * D, rcImportAt: WED - 5 * D - H, firstAppAt: WED - 7 * D, sent: sent(["welcome", WED - 8 * D], ["side_by_side", WED - 4 * D]) };
    expect(pickStep(facts(imported), WED, cfg)).toBe("forwarding_check");
    expect(pickStep(facts({ ...imported, lastNotificationAt: WED - D }), WED, cfg)).toBeNull();
  });

  it("holds adoption emails for migrators until the cutover email, which comes first", () => {
    const f = { path: "revenuecat" as const, createdAt: WED - 30 * D, rcImportAt: WED - 25 * D, liveAt: WED - 8 * D, lastSaleAt: WED - H, tracked: 6_000 };
    expect(pickStep(facts(f), WED, cfg)).toBe("cutover");
    expect(pickStep(facts({ ...f, sent: sent(["cutover", WED - 2 * D]) }), WED, cfg)).toBe("pricing_explainer");
  });

  it("counts the verification reminder towards the 44-hour gap, so day 1 brings one email", () => {
    const f = facts({ createdAt: WED - 24 * H - 10 * 60_000, verified: false, sent: sent(["welcome", WED - 24 * H], ["verify_reminder", WED - 5 * 60_000]) });
    expect(pickStep(f, WED, cfg)).toBeNull();
  });

  it("thanks a referrer when a friend signs up, and asks why when Standard is cancelled", () => {
    expect(pickStep(facts({ createdAt: WED - 60 * D, referralJoinedAt: WED - H }), WED, cfg)).toBe("referral_joined");
    expect(pickStep(facts({ createdAt: WED - 60 * D, canceledAt: WED - D }), WED, cfg)).toBe("standard_canceled");
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
  const journeyMails = (to: string) => s!.mail.sent.filter((m) => m.to === to && m.from?.includes("kai@mail.revenuedot.app"));

  it("sends the welcome from Kai once, with one-click unsubscribe, and the unsubscribe turns them off", async () => {
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
    expect(m!.text).toContain("Welcome, Maya");
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
    // Unsubscribed: day 1 brings nothing.
    s!.advance(D);
    expect((await run()).sent).toBe(0);
  });

  it("records the path picked in the welcome and redirects to its guide", async () => {
    await cloud();
    await signup("sam@ai.dev");
    s!.advance(6 * 60_000);
    await run();
    const m = journeyMails("sam@ai.dev")[0]!;
    const link = /https:\/\/dash\.example\.com(\/auth\/journeys\/path\/[^?"]+\?path=revenuecat)/.exec(m.html.replace(/&amp;/g, "&"))![1]!;
    const r = await s!.app.fetch(new Request(`http://localhost${link}`));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/docs/migrate");
    const [u] = await s!.db.select().from(schema.users).where(eq(schema.users.email, "sam@ai.dev"));
    expect(u!.journeyPath).toBe("revenuecat");
  });

  it("skips excluded domains and addresses", async () => {
    await cloud();
    await signup("kai@circo.so");
    await signup("qa@example.com");
    s!.advance(6 * 60_000);
    expect((await run()).sent).toBe(0);
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
    await s!.db.insert(schema.customers).values({ id: "cus_j", projectId: p!.id, originalAppUserId: "u1", firstSeen: s!.now(), lastSeen: s!.now() });
    await s!.db.insert(schema.transactions).values({ id: "tx_j", projectId: p!.id, customerId: "cus_j", appId: "app_j", store: "app_store", storeTransactionId: "1", productIdentifier: "pro_annual", kind: "purchase", purchasedAt: s!.now(), revenueUsd: 39.99, priceAmount: 39.99, priceCurrency: "USD", countryCode: "DE", isSandbox: false, createdAt: s!.now() });
    s!.advance(H);
    expect((await run()).sent).toBe(1);
    const sale = journeyMails("jordan@photo.app").at(-1)!;
    expect(sale.subject).toBe("Your first real sale through RevenueDot");
    expect(sale.text).toContain("pro_annual");
    expect(sale.text).toContain("Germany");
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
      expect(m.text, step).toMatch(/Hi there,|^Welcome to RevenueDot/m);
      for (const [, url] of m.html.matchAll(/href="(https:\/\/(?:app\.)?revenuedot\.app\/(?!auth\/)[^"]*)"/g)) expect(url, step).toContain("utm_content=" + step);
    }
  });

  it("shows a video only once its page is live", () => {
    const base = { app: "https://app.revenuedot.app", first: "Maya", projectId: "p", projectName: "Habitly", unsubscribeUrl: "https://app.revenuedot.app/auth/journeys/unsubscribe/x" };
    expect(journeyEmail({ ...base, step: "assistant" }).html).toContain(`/email/${VIDEOS["chatgpt-demo"].slug}.jpg`);
    const ready = VIDEOS["first-purchase"].ready;
    expect(journeyEmail({ ...base, step: "first_purchase" }).html.includes("/email/revenuedot-first-purchase.jpg")).toBe(ready);
  });
});
