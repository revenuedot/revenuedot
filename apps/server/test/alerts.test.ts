// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: alert emails to project admins from the tick (prd/account-email/PRD.md).
// Docs: https://revenuedot.app/docs/guides/alerts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { tick } from "../src/services/tick.js";
import { runAlerts } from "../src/services/alerts.js";
import { recheckDueCredentials } from "../src/services/credential-health.js";
import { Codes, RCError } from "../src/errors.js";
import { defaultStores } from "../src/stores/index.js";
import { makeP8, mockAppleApi } from "./apple-fixtures.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });
let p8: string;
beforeAll(async () => { p8 = await makeP8(); });

const HOUR = 3600_000;

async function project(over: Parameters<typeof accountServer>[0] = {}) {
  s = await accountServer(over);
  const o = await s.signup("admin@example.com");
  const P = `/v2/projects/${o.projectId}`;
  // A second admin who opted out, and a viewer: neither gets alert emails.
  for (const [email, role] of [["quiet@example.com", "admin"], ["viewer@example.com", "viewer"]] as const) {
    await o.browser.call("POST", `${P}/invites`, { email, role });
    const b = s.client();
    await b.call("POST", "/auth/signup", { email, password: "long enough", invite_token: s.linkIn(email, "/invite?token=").token });
    if (email === "quiet@example.com") await b.call("POST", "/auth/me", { alert_emails: false });
  }
  const ios = (await o.browser.call("POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } })).body;
  s.mail.sent.length = 0;
  return { ...o, P, ios, s };
}

const alertMails = (s: S) => s.mail.sent.map((m) => `${m.to}: ${m.subject}`);

describe("store notifications failing", () => {
  it("emails opted-in admins once, reminds after 24 hours, and says when it recovers", async () => {
    const { ios, projectId, s } = await project();
    const fail = (at: Date) => s.db.insert(schema.storeNotifications).values({ id: crypto.randomUUID(), projectId: projectId!, appId: ios.id, store: "app_store", type: "DID_RENEW", body: "{}", error: "The notification's signature does not verify.", receivedAt: at });
    await fail(s.now());
    const run = () => runAlerts({ db: s.db, mailer: s.mail, publicUrl: "https://dash.example.com" }, s.now());

    expect(await run()).toEqual({ opened: 1, reminded: 0, resolved: 0 });
    expect(alertMails(s)).toEqual(["admin@example.com: Store notifications are failing for Scanner iOS"]);
    const m = s.mail.sent[0]!;
    expect(m.text).toContain("Last error: The notification's signature does not verify.");
    expect(m.text).toContain(`https://dash.example.com/projects/${projectId}/apps/${ios.id}`);
    expect(m.text).toContain("Notification settings: https://dash.example.com/account");

    // Every minute for the next day: nothing new.
    for (let i = 0; i < 3; i++) { s.advance(8 * HOUR); if (i < 2) expect(await run()).toEqual({ opened: 0, reminded: 0, resolved: 0 }); }
    // 24 hours after the first email: one reminder.
    expect((await run()).reminded).toBe(1);
    expect(s.mail.sent.at(-1)!.subject).toBe("Still failing: Store notifications are failing for Scanner iOS");
    expect((await run()).reminded).toBe(0);

    // A processed notification (last_notification_at after the failure) resolves it, once.
    s.advance(HOUR);
    await s.db.update(schema.apps).set({ lastNotificationAt: s.now() }).where(eq(schema.apps.id, ios.id));
    expect(await run()).toEqual({ opened: 0, reminded: 0, resolved: 1 });
    expect(s.mail.sent.at(-1)!.subject).toBe("Resolved: store notifications for Scanner iOS");
    expect(await run()).toEqual({ opened: 0, reminded: 0, resolved: 0 });
    expect(s.mail.sent.map((x) => x.to).every((to) => to === "admin@example.com")).toBe(true);
    expect(s.mail.sent).toHaveLength(3);

    // Failing again later opens a new email right away.
    s.advance(HOUR);
    await fail(s.now());
    expect((await run()).opened).toBe(1);
  });

  it("an opted-out admin gets nothing; no admin opted in means no email but the alert still tracks", async () => {
    const { browser, ios, projectId, s } = await project();
    await browser.call("POST", "/auth/me", { alert_emails: false });
    await s.db.insert(schema.storeNotifications).values({ id: "n1", projectId: projectId!, appId: ios.id, store: "app_store", body: "{}", error: "bad", receivedAt: s.now() });
    expect((await runAlerts({ db: s.db, mailer: s.mail }, s.now())).opened).toBe(1);
    expect(s.mail.sent).toHaveLength(0);
    expect((await s.db.select().from(schema.alerts))[0]).toMatchObject({ kind: "store_notifications", subjectId: ios.id, status: "open" });
  });
});

describe("webhook failing", () => {
  it("opens after 5 failed attempts in a row (through the real delivery tick) and resolves on the next success", async () => {
    const { browser, P, s } = await project();
    const w = (await browser.call("POST", `${P}/integrations/webhooks`, { name: "Backend", url: "https://hooks.example.com/rd" })).body;
    const down: typeof fetch = async () => new Response("no", { status: 500 });
    const up: typeof fetch = async () => new Response("ok", { status: 200 });
    for (let i = 0; i < 4; i++) await browser.call("POST", `${P}/integrations/webhooks/${w.id}/test`);
    await tick(s.db, s.now(), down, { stores: defaultStores(), mailer: s.mail, publicUrl: "https://dash.example.com" });
    expect(s.mail.sent).toHaveLength(0); // 4 failures
    await browser.call("POST", `${P}/integrations/webhooks/${w.id}/test`);
    const r = await tick(s.db, s.now(), down, { stores: defaultStores(), mailer: s.mail, publicUrl: "https://dash.example.com" });
    expect(r.alerts.opened).toBe(1);
    expect(s.mail.sent.map((m) => m.subject)).toEqual(["Webhook Backend is failing"]);
    expect(s.mail.sent[0]!.text).toContain("Last error: HTTP 500");
    expect(s.mail.sent[0]!.text).toContain(`/integrations/webhooks/${w.id}`);
    // Retries 5 minutes later succeed.
    s.advance(5 * 60_000 + 1);
    const ok = await tick(s.db, s.now(), up, { stores: defaultStores(), mailer: s.mail, publicUrl: "https://dash.example.com" });
    expect(ok.alerts.resolved).toBe(1);
    expect(s.mail.sent.at(-1)!.subject).toBe("Resolved: webhook Backend");
    const [row] = await s.db.select().from(schema.webhooks).where(eq(schema.webhooks.id, w.id));
    expect(row!.consecutiveFailures).toBe(0);
  });

  it("a paused webhook does not alert, and pausing resolves an open alert", async () => {
    const { browser, P, s } = await project();
    const w = (await browser.call("POST", `${P}/integrations/webhooks`, { name: "Backend", url: "https://hooks.example.com/rd" })).body;
    await s.db.update(schema.webhooks).set({ consecutiveFailures: 7, lastError: "timeout" }).where(eq(schema.webhooks.id, w.id));
    expect((await runAlerts({ db: s.db, mailer: s.mail }, s.now())).opened).toBe(1);
    await s.db.update(schema.webhooks).set({ enabled: false }).where(eq(schema.webhooks.id, w.id));
    expect((await runAlerts({ db: s.db, mailer: s.mail }, s.now())).resolved).toBe(1);
  });
});

describe("store credentials failing", () => {
  it("a receipt check that Apple answers with a key error marks the app failing; the hourly re-check resolves it", async () => {
    const stores = defaultStores();
    stores.app_store = { verify: async () => { throw new RCError(500, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "The App Store rejected the in-app purchase key (key_id, issuer_id or private_key is wrong)."); } };
    const { browser, P, ios, s } = await project({ stores });
    await browser.call("POST", `${P}/apps/${ios.id}`, { app_store: { subscription_private_key: p8, subscription_key_id: "ABC123DEFG", subscription_key_issuer: "69a6de94-014f-47e3-e053-5b8c7c11a4d1" } });
    const key = (await browser.call("GET", `${P}/apps/${ios.id}/public_api_keys`)).body.items[0].key;
    const r = await s.client().call("POST", "/v1/receipts", { app_user_id: "u1", fetch_token: "MIIT...", product_id: "pro" }, { authorization: `Bearer ${key}`, "x-platform": "iOS" });
    expect(r.status).toBe(500); // unchanged SDK behaviour: our setup problem is a 5xx
    const [app] = await s.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id));
    expect(app).toMatchObject({ credentialsStatus: "failing", credentialsError: expect.stringContaining("rejected the in-app purchase key") });

    expect((await runAlerts({ db: s.db, mailer: s.mail, publicUrl: "https://dash.example.com" }, s.now())).opened).toBe(1);
    expect(s.mail.sent.map((m) => m.subject)).toEqual(["The store rejected the credentials for Scanner iOS"]);

    // Within the hour nothing is re-checked; after it, Apple accepts the key (unknown transaction = 404) and it resolves.
    const apple = mockAppleApi({ production: { transactions: [] }, knownIds: [] });
    const deps = { db: s.db, now: s.now, stores: defaultStores(), fetch: apple.fetch as typeof fetch };
    s.advance(30 * 60_000);
    expect(await recheckDueCredentials(deps, s.now())).toBe(0);
    s.advance(31 * 60_000);
    expect(await recheckDueCredentials(deps, s.now())).toBe(1);
    expect(apple.calls).toHaveLength(1);
    expect((await runAlerts({ db: s.db, mailer: s.mail, publicUrl: "https://dash.example.com" }, s.now())).resolved).toBe(1);
    expect(s.mail.sent.at(-1)!.subject).toBe("Resolved: store credentials for Scanner iOS");
  });

  it("the dashboard's check of stored credentials records the result; a check of unsaved values does not", async () => {
    const apple = mockAppleApi({ failWith: 401 });
    const { browser, P, ios, s } = await project({ fetch: apple.fetch as typeof fetch });
    const creds = { subscription_private_key: p8, subscription_key_id: "ABC123DEFG", subscription_key_issuer: "69a6de94-014f-47e3-e053-5b8c7c11a4d1" };
    expect((await browser.call("POST", `${P}/apps/${ios.id}/actions/verify_credentials`, { app_store: creds })).body.status).toBe("invalid");
    expect((await s.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id)))[0]!.credentialsStatus).toBeNull();
    await browser.call("POST", `${P}/apps/${ios.id}`, { app_store: creds });
    expect((await browser.call("POST", `${P}/apps/${ios.id}/actions/verify_credentials`)).body.status).toBe("invalid");
    expect((await s.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id)))[0]).toMatchObject({ credentialsStatus: "failing" });
  });

  it("the daily check covers every app with credentials and skips apps without", async () => {
    const { browser, P, ios, s } = await project();
    const apple = mockAppleApi({ failWith: 401 });
    const deps = { db: s.db, now: s.now, stores: defaultStores(), fetch: apple.fetch as typeof fetch };
    expect(await recheckDueCredentials(deps, s.now())).toBe(0); // no key yet
    await browser.call("POST", `${P}/apps/${ios.id}`, { app_store: { subscription_private_key: p8, subscription_key_id: "ABC123DEFG", subscription_key_issuer: "69a6de94-014f-47e3-e053-5b8c7c11a4d1" } });
    expect(await recheckDueCredentials(deps, s.now())).toBe(1); // saving new credentials asks for a check
    expect((await s.db.select().from(schema.apps).where(eq(schema.apps.id, ios.id)))[0]!.credentialsStatus).toBe("failing");
    expect(await recheckDueCredentials(deps, s.now())).toBe(0);
  });

  it("a deleted app resolves its alert without an email", async () => {
    const { browser, P, ios, s } = await project();
    await s.db.update(schema.apps).set({ credentialsStatus: "failing", credentialsError: "401" }).where(eq(schema.apps.id, ios.id));
    await runAlerts({ db: s.db, mailer: s.mail }, s.now());
    await browser.call("DELETE", `${P}/apps/${ios.id}`);
    const n = s.mail.sent.length;
    expect((await runAlerts({ db: s.db, mailer: s.mail }, s.now())).resolved).toBe(1);
    expect(s.mail.sent.length).toBe(n);
  });
});
