// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: "integration failing" alert emails to project admins, through the real delivery tick with a fake partner.
// Docs: https://revenuedot.app/docs/guides/alerts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { tick } from "../src/services/tick.js";
import { INTEGRATION_FAILED_DELIVERIES, INTEGRATION_MIN_ATTEMPTS, runAlerts } from "../src/services/alerts.js";
import { defaultStores } from "../src/stores/index.js";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const HOUR = 3600_000;

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

/** A project with an admin, an admin with alert emails off, an admin with only integration failures off, a developer and a viewer. */
async function project() {
  s = await accountServer({ encryptionKey: KEY });
  const o = await s.signup("admin@example.com");
  const P = `/v2/projects/${o.projectId}`;
  for (const [email, role] of [["quiet@example.com", "admin"], ["nointeg@example.com", "admin"], ["dev@example.com", "developer"], ["viewer@example.com", "viewer"]] as const) {
    await o.browser.call("POST", `${P}/invites`, { email, role });
    const b = s.client();
    await b.call("POST", "/auth/signup", { email, password: "long enough", invite_token: s.linkIn(email, "/invite?token=").token });
    if (email === "quiet@example.com") await b.call("POST", "/auth/me", { alert_emails: false });
    if (email === "nointeg@example.com") expect((await b.call("POST", "/auth/me", { integration_alert_emails: false })).body.user.integration_alert_emails).toBe(false);
  }
  const integ = (await o.browser.call("POST", `${P}/integrations/partners`, { type: "appstack", name: "Attribution feed", settings: { webhook_url: "https://partner.example.com/hook", authorization: "Bearer partner-token-1234" } })).body;
  if (!integ.id) throw new Error(JSON.stringify(integ));
  s.mail.sent.length = 0;
  const server = s;
  /** Queues `n` TEST events to the integration. */
  const events = async (n: number) => { for (let i = 0; i < n; i++) expect((await o.browser.call("POST", `${P}/integrations/partners/${integ.id}/test`, {})).status).toBe(201); };
  /** The every-minute tick: sends due deliveries through `answer`, then runs the alerts. */
  const run = (answer: () => Response) => tick(server.db, server.now(), (async () => answer()) as typeof fetch, { stores: defaultStores(), mailer: server.mail, publicUrl: "https://dash.example.com", encryptionKey: KEY });
  const mails = () => server.mail.sent.map((m) => `${m.to}: ${m.subject}`);
  return { ...o, P, integ, s: server, events, run, mails };
}

const bad = () => new Response('{"error":"bad request"}', { status: 400 });
const ok = () => new Response("ok", { status: 200 });

describe("integration failing: 10 failed deliveries in a row", () => {
  it("9 failures send nothing; the 10th emails the admins who want it, once, with the numbers and a link to the delivery log", async () => {
    const { projectId, integ, s, events, run, mails } = await project();
    expect(INTEGRATION_FAILED_DELIVERIES).toBe(10);
    // 5 now and 4 two hours later: never 10 attempts in one hour, so only the in-a-row rule can open the alert.
    await events(5);
    expect((await run(bad)).alerts.opened).toBe(0);
    s.advance(2 * HOUR);
    await events(4);
    expect((await run(bad)).alerts.opened).toBe(0);
    expect(s.mail.sent).toHaveLength(0);
    const [row9] = await s.db.select().from(schema.integrations).where(eq(schema.integrations.id, integ.id));
    expect([row9!.failedDeliveriesInRow, row9!.consecutiveFailures]).toEqual([9, 9]);

    await events(1);
    const r = await run(bad);
    expect(r.alerts).toEqual({ opened: 1, reminded: 0, resolved: 0 });
    // Not the admin with alert emails off, not the admin with integration failures off, not the developer or the viewer.
    expect(mails()).toEqual(["admin@example.com: Integration Attribution feed (Appstack) is failing"]);
    const m = s.mail.sent[0]!;
    expect(m.text).toContain("The last 10 deliveries failed, one after the other.");
    expect(m.text).not.toContain("in the last hour");
    expect(m.text).toContain('Last error: HTTP 400: {"error":"bad request"}');
    expect(m.text).toContain(`Open the delivery log: https://dash.example.com/projects/${projectId}/integrations/appstack?id=${integ.id}#deliveries`);
    expect(m.text).toContain("Turn integration failure emails off in your notification settings.");
    expect(m.html).toContain(`/projects/${projectId}/integrations/appstack?id=${integ.id}#deliveries`);

    // The next ticks (every minute for a day) send nothing new.
    for (let i = 0; i < 3; i++) { s.advance(7 * HOUR); expect((await run(bad)).alerts).toEqual({ opened: 0, reminded: 0, resolved: 0 }); }
    expect(s.mail.sent).toHaveLength(1);

    // 24 hours after the first email: one reminder, then nothing again.
    s.advance(3 * HOUR);
    expect((await run(bad)).alerts.reminded).toBe(1);
    expect(mails().at(-1)).toBe("admin@example.com: Still failing: Integration Attribution feed (Appstack) is failing");
    expect((await run(bad)).alerts.reminded).toBe(0);

    // A delivered event (and no failure rate in the last hour) resolves it with one email.
    await events(1);
    const rec = await run(ok);
    expect(rec.alerts).toEqual({ opened: 0, reminded: 0, resolved: 1 });
    expect(mails().at(-1)).toBe("admin@example.com: Resolved: integration Attribution feed (Appstack)");
    expect(s.mail.sent.at(-1)!.text).toContain("works again");
    expect((await run(ok)).alerts).toEqual({ opened: 0, reminded: 0, resolved: 0 });
    expect(s.mail.sent).toHaveLength(3);
    expect(s.mail.sent.every((x) => x.to === "admin@example.com")).toBe(true);
    const [after] = await s.db.select().from(schema.integrations).where(eq(schema.integrations.id, integ.id));
    expect([after!.failedDeliveriesInRow, after!.consecutiveFailures]).toEqual([0, 0]);
  });

  it("a retried delivery counts once, when it runs out of retries; the attempts before that do not add up", async () => {
    const { integ, s, events, run } = await project();
    await events(1);
    const down = () => new Response("busy", { status: 503 });
    await run(down);
    for (const wait of [5, 10, 20, 40, 80]) { s.advance(wait * 60_000); await run(down); }
    const [row] = await s.db.select().from(schema.integrations).where(eq(schema.integrations.id, integ.id));
    const [d] = await s.db.select().from(schema.integrationDeliveries);
    expect([d!.status, d!.attempts]).toEqual(["failed", 6]);
    expect([row!.consecutiveFailures, row!.failedDeliveriesInRow]).toEqual([6, 1]);
  });
});

describe("integration failing: more than half of the last hour's attempts", () => {
  it("opens when 6 of 11 attempts in the hour failed, though no 10 failed in a row", async () => {
    const { s, events, run, mails } = await project();
    await events(11);
    let n = 0;
    // Failures and successes alternate: 6 failed, 5 delivered, never more than one failure in a row.
    const r = await run(() => (n++ % 2 === 0 ? bad() : ok()));
    expect(r.integrations).toBe(10); // at most 10 deliveries of one integration per tick
    await run(() => (n++ % 2 === 0 ? bad() : ok()));
    expect(mails()).toEqual(["admin@example.com: Integration Attribution feed (Appstack) is failing"]);
    expect(s.mail.sent[0]!.text).toContain("6 of 11 delivery attempts in the last hour failed (55%).");
    expect(s.mail.sent[0]!.text).not.toContain("one after the other");
  });

  it("does nothing below the minimum sample, even when every attempt failed", async () => {
    const { s, events, run } = await project();
    expect(INTEGRATION_MIN_ATTEMPTS).toBe(10);
    await events(4);
    let n = 0;
    await run(() => (n++ === 0 ? ok() : bad())); // 3 of 4 failed (75%)
    expect((await run(bad)).alerts.opened).toBe(0);
    expect(s.mail.sent).toHaveLength(0);
  });

  it("does not count skipped deliveries", async () => {
    const { integ, s, run } = await project();
    // 12 skipped deliveries (a skip logs no attempt), and 9 failed attempts: below the minimum.
    const ev = async (i: number) => {
      const id = `ev_skip_${i}`;
      await s.db.insert(schema.events).values({ id, projectId: integ.project_id, type: "TEST", environment: "PRODUCTION", payload: { event: { type: "TEST" } }, eventTimestampMs: s.now().getTime() });
      return id;
    };
    for (let i = 0; i < 12; i++) {
      await s.db.insert(schema.integrationDeliveries).values({ id: `d_skip_${i}`, integrationId: integ.id, eventId: await ev(i), status: "skipped", nextAttemptAt: s.now(), lastError: "nothing to send" });
    }
    for (let i = 12; i < 21; i++) {
      await s.db.insert(schema.integrationDeliveries).values({ id: `d_fail_${i}`, integrationId: integ.id, eventId: await ev(i), status: "failed", attempts: 1, nextAttemptAt: s.now(), lastError: "HTTP 400",
        attemptLog: [{ at: s.now().getTime(), status: 400, ms: 1, error: "HTTP 400", response_body: null }] });
    }
    expect((await run(ok)).alerts.opened).toBe(0);
  });

  it("stays open after the hour passes with no success, and resolves only when a delivery succeeds with the rate back under half", async () => {
    const { s, events, run, mails } = await project();
    await events(10);
    let n = 0;
    await run(() => (n++ < 7 ? bad() : ok())); // 7 of 10 failed
    expect(mails()).toEqual(["admin@example.com: Integration Attribution feed (Appstack) is failing"]);
    // Two hours with no attempts: the rate has no sample any more, but nothing was delivered since the alert opened.
    s.advance(2 * HOUR);
    expect((await run(ok)).alerts).toEqual({ opened: 0, reminded: 0, resolved: 0 });
    // A success while the last hour is still mostly failures keeps it open.
    await events(10);
    n = 0;
    await run(() => (n++ < 9 ? bad() : ok())); // 9 of 10 failed, the last one delivered
    expect((await runAlerts({ db: s.db, mailer: s.mail, publicUrl: "https://dash.example.com" }, s.now())).resolved).toBe(0);
    // An hour later the failures are out of the window and a delivery succeeded: resolved, once.
    s.advance(HOUR + 60_000);
    await events(1);
    expect((await run(ok)).alerts.resolved).toBe(1);
    expect(mails().at(-1)).toBe("admin@example.com: Resolved: integration Attribution feed (Appstack)");
  });
});

describe("integration failing: turned off or deleted", () => {
  it("turning the integration off resolves the alert with an email that says so; a turned-off integration never alerts", async () => {
    const { browser, P, integ, s, events, run, mails } = await project();
    await events(10);
    await run(bad);
    expect(mails()).toHaveLength(1);
    expect((await browser.call("POST", `${P}/integrations/partners/${integ.id}`, { enabled: false })).status).toBe(200);
    expect((await run(bad)).alerts.resolved).toBe(1);
    expect(mails().at(-1)).toBe("admin@example.com: Resolved: integration Attribution feed (Appstack)");
    expect(s.mail.sent.at(-1)!.text).toContain("was turned off, so this alert is closed");
    // Still 10 failed in a row while off: no new alert.
    await s.db.update(schema.integrations).set({ failedDeliveriesInRow: 12 }).where(eq(schema.integrations.id, integ.id));
    expect((await run(bad)).alerts.opened).toBe(0);
    // Turning it back on starts both counts again: attempts before that are not in the failure rate either.
    s.advance(60_000);
    await browser.call("POST", `${P}/integrations/partners/${integ.id}`, { enabled: true });
    const [row] = await s.db.select().from(schema.integrations).where(eq(schema.integrations.id, integ.id));
    expect(row!.failedDeliveriesInRow).toBe(0);
    expect((await run(bad)).alerts.opened).toBe(0);
  });

  it("deleting the integration resolves the alert without an email", async () => {
    const { browser, P, integ, s, events, run, mails } = await project();
    await events(10);
    await run(bad);
    expect(mails()).toHaveLength(1);
    expect((await browser.call("DELETE", `${P}/integrations/partners/${integ.id}`)).status).toBe(200);
    expect((await run(bad)).alerts.resolved).toBe(1);
    expect(mails()).toHaveLength(1);
    const [a] = await s.db.select().from(schema.alerts);
    expect(a).toMatchObject({ kind: "integration", subjectId: integ.id, status: "resolved" });
  });
});

describe("integration failure emails setting", () => {
  it("is on by default, shows in GET /auth/notifications, and only alert emails on plus this on gets the email", async () => {
    const { browser, P, s, events, run, mails } = await project();
    const n = await browser.call("GET", "/auth/notifications");
    expect(n.body).toMatchObject({ alert_emails: true, integration_alert_emails: true });
    expect((await browser.call("GET", "/auth/me")).body.user.integration_alert_emails).toBe(true);
    // The admin turns integration failures off: nobody is left to email, but the alert still tracks.
    await browser.call("POST", "/auth/me", { integration_alert_emails: false });
    await events(10);
    expect((await run(bad)).alerts.opened).toBe(1);
    expect(mails()).toEqual([]);
    expect((await browser.call("GET", "/auth/notifications")).body.integration_alert_emails).toBe(false);
    // Other alert kinds still reach them: integration failures off does not turn off webhooks.
    const w = (await browser.call("POST", `${P}/integrations/webhooks`, { name: "Backend", url: "https://hooks.example.com/rd" })).body;
    await s.db.update(schema.webhooks).set({ consecutiveFailures: 5, lastError: "timeout" }).where(eq(schema.webhooks.id, w.id));
    await runAlerts({ db: s.db, mailer: s.mail, publicUrl: "https://dash.example.com" }, s.now());
    expect(mails()).toEqual(["admin@example.com: Webhook Backend is failing", "nointeg@example.com: Webhook Backend is failing"]);
  });
});

describe("integration failing: no flapping, idle", () => {
  it("fail ×10, one success, fail ×10: one email, the alert stays open while the hour is mostly failures", async () => {
    const { s, events, run, mails } = await project();
    await events(10);
    await run(bad);
    await events(1);
    expect((await run(ok)).alerts.resolved).toBe(0); // 10 of 11 attempts in the hour failed
    await events(10);
    await run(bad);
    expect(mails()).toEqual(["admin@example.com: Integration Attribution feed (Appstack) is failing"]);
    expect((await s.db.select().from(schema.alerts))[0]!.status).toBe("open");
  });

  it("failing again within a day of resolving reopens quietly; the reminder follows 24 hours after the last email", async () => {
    const { s, events, run, mails } = await project();
    await events(10);
    await run(bad);
    s.advance(2 * HOUR);
    await events(1);
    expect((await run(ok)).alerts.resolved).toBe(1);
    expect(mails()).toHaveLength(2);
    s.advance(HOUR);
    await events(10);
    await run(bad);
    expect(mails()).toHaveLength(2);
    expect((await s.db.select().from(schema.alerts))[0]!.status).toBe("open");
    s.advance(21 * HOUR);
    expect((await run(bad)).alerts.reminded).toBe(1);
    expect(mails().at(-1)).toBe("admin@example.com: Still failing: Integration Attribution feed (Appstack) is failing");
  });

  it("closes as idle when no rule holds and nothing failed for 7 days", async () => {
    const { s, events, run, mails } = await project();
    await events(10);
    let n = 0;
    await run(() => (n++ < 7 ? bad() : ok())); // 7 of 10 failed: opened by the hourly rule
    expect(mails()).toHaveLength(1);
    s.advance(3 * 24 * HOUR);
    expect((await run(ok)).alerts).toEqual({ opened: 0, reminded: 1, resolved: 0 });
    s.advance(5 * 24 * HOUR);
    expect((await run(ok)).alerts.resolved).toBe(1);
    expect(s.mail.sent.at(-1)!.text).toContain("has failed for 7 days, so this alert is closed");
  });
});
