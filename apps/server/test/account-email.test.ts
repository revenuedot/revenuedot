// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: password reset and email verification (prd/account-email/PRD.md).
// Docs: https://revenuedot.app/docs/guides/self-hosting#email
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer } from "./account-helpers.js";
import { RESET_LIMITS } from "../src/routes/auth.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const forgot = (b: ReturnType<S["client"]>, email: string, ip = "203.0.113.7") => b.call("POST", "/auth/password/forgot", { email }, { "cf-connecting-ip": ip });

describe("password reset", () => {
  it("emails a single-use link; the reset sets the password, revokes every session and signs this browser in", async () => {
    s = await accountServer();
    const { browser: laptop } = await s.signup("ana@example.com");
    const phone = s.client();
    expect((await phone.call("POST", "/auth/login", { email: "ana@example.com", password: "correct horse battery" })).status).toBe(200);

    const stranger = s.client();
    const r = await forgot(stranger, "Ana@Example.com ");
    expect(r.status).toBe(200);
    await s.settle();
    const { token, url, message } = s.linkIn("ana@example.com", "/reset-password?token=");
    expect(url.startsWith("https://dash.example.com/reset-password?token=")).toBe(true);
    expect(message.subject).toBe("Reset your RevenueDot password");
    expect(message.html).toContain(url.replace(/&/g, "&amp;"));
    // Only the hash is stored.
    const rows = await s.db.select().from(schema.authTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).not.toContain(token);
    expect(rows[0]!.kind).toBe("password_reset");

    expect((await stranger.call("POST", "/auth/password/check", { token })).body).toEqual({ valid: true, email: "ana@example.com" });
    expect((await stranger.call("POST", "/auth/password/reset", { token, password: "short" })).status).toBe(400);
    const done = await stranger.call("POST", "/auth/password/reset", { token, password: "a brand new password" });
    expect(done.status).toBe(200);
    expect((await stranger.call("GET", "/auth/me")).body.user.email).toBe("ana@example.com");
    // Every earlier session is gone.
    expect((await laptop.call("GET", "/auth/me")).status).toBe(401);
    expect((await phone.call("GET", "/auth/me")).status).toBe(401);
    // Old password fails, new one works.
    expect((await s.client().call("POST", "/auth/login", { email: "ana@example.com", password: "correct horse battery" })).status).toBe(401);
    expect((await s.client().call("POST", "/auth/login", { email: "ana@example.com", password: "a brand new password" })).status).toBe(200);

    // Single use.
    const again = await s.client().call("POST", "/auth/password/reset", { token, password: "yet another password" });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ type: "token_invalid", reason: "used" });
    expect((await s.client().call("POST", "/auth/password/check", { token })).body).toMatchObject({ valid: false, reason: "used" });
  });

  it("links expire after 1 hour; each request gets its own link", async () => {
    s = await accountServer();
    await s.signup("ben@example.com");
    const b = s.client();
    await forgot(b, "ben@example.com"); await s.settle();
    const first = s.linkIn("ben@example.com", "/reset-password?token=").token;
    s.advance(59 * 60_000);
    await forgot(b, "ben@example.com"); await s.settle();
    const second = s.linkIn("ben@example.com", "/reset-password?token=").token;
    expect(second).not.toBe(first);
    s.advance(2 * 60_000); // first is 61 minutes old, second 2 minutes
    expect((await b.call("POST", "/auth/password/check", { token: first })).body).toMatchObject({ valid: false, reason: "expired" });
    expect((await b.call("POST", "/auth/password/reset", { token: first, password: "new password one" })).body).toMatchObject({ reason: "expired" });
    expect((await b.call("POST", "/auth/password/reset", { token: second, password: "new password two" })).status).toBe(200);
    s.advance(61 * 60_000);
    expect((await b.call("POST", "/auth/password/check", { token: second })).body.valid).toBe(false);
    expect((await b.call("POST", "/auth/password/reset", { token: "made-up", password: "new password three" })).body).toMatchObject({ reason: "invalid" });
  });

  it("answers the same for known and unknown emails, and sends nothing for unknown ones", async () => {
    s = await accountServer();
    await s.signup("cara@example.com");
    const sentBefore = s.mail.sent.length;
    const known = await forgot(s.client(), "cara@example.com", "198.51.100.1");
    const unknown = await forgot(s.client(), "nobody@example.com", "198.51.100.2");
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(Object.keys(unknown.body)).toEqual(["ok", "message"]);
    await s.settle();
    expect(s.mail.sent.slice(sentBefore).map((m) => m.to)).toEqual(["cara@example.com"]);
    // A malformed address is a 400 for everyone; it says nothing about accounts.
    expect((await forgot(s.client(), "not-an-email")).status).toBe(400);
  });

  it("rate-limits by IP (429) and by address (silently: still 200, no more emails)", async () => {
    s = await accountServer();
    await s.signup("dev@example.com");
    const before = s.mail.sent.length;
    // Per address: 3 emails an hour, from different IPs.
    for (let i = 0; i < 5; i++) expect((await forgot(s.client(), "dev@example.com", `192.0.2.${i}`)).status).toBe(200);
    await s.settle();
    expect(s.mail.sent.length - before).toBe(RESET_LIMITS.perEmail);
    // Per IP: 5 requests in 15 minutes, then 429.
    for (let i = 0; i < RESET_LIMITS.perIp; i++) expect((await forgot(s.client(), `x${i}@example.com`, "192.0.2.200")).status).toBe(200);
    const blocked = await forgot(s.client(), "x9@example.com", "192.0.2.200");
    expect(blocked.status).toBe(429);
    expect(blocked.body.type).toBe("rate_limit_error");
    // The windows reset.
    s.advance(RESET_LIMITS.ipWindowMs + 1);
    expect((await forgot(s.client(), "x9@example.com", "192.0.2.200")).status).toBe(200);
    s.advance(RESET_LIMITS.emailWindowMs);
    const n = s.mail.sent.length;
    await forgot(s.client(), "dev@example.com", "192.0.2.99"); await s.settle();
    expect(s.mail.sent.length).toBe(n + 1);
  });

  it("does the lookup and the send after the response (the deferred task)", async () => {
    s = await accountServer();
    await s.signup("eve@example.com");
    const before = s.mail.sent.length;
    await forgot(s.client(), "eve@example.com");
    expect(s.mail.sent.length).toBe(before); // nothing sent before the response
    await s.settle();
    expect(s.mail.sent.length).toBe(before + 1);
  });

  it("a mail outage still answers 200 and logs, never 500", async () => {
    s = await accountServer({ mailer: { driver: "smtp", send: async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }); } } });
    await s.signup("fay@example.com");
    const r = await forgot(s.client(), "fay@example.com");
    expect(r.status).toBe(200);
    await s.settle();
  });
});

describe("email verification", () => {
  it("Cloud: sign-up sends a link; unverified accounts cannot create secret keys or invite; the link verifies once", async () => {
    s = await accountServer({ edition: "cloud" });
    const { browser, projectId, userId } = await s.signup("gus@example.com");
    const me = await browser.call("GET", "/auth/me");
    expect(me.body.user).toMatchObject({ email_verified: false, alert_emails: true });
    expect(me.body.account.email_verification_required).toBe(true);
    const { token, message } = s.linkIn("gus@example.com", "/verify-email?token=");
    expect(message.subject).toBe("Confirm your email for RevenueDot");

    const key = await browser.call("POST", `/v2/projects/${projectId}/api_keys`, { name: "server" });
    expect(key.status).toBe(403);
    expect(key.body.message).toContain("Confirm your email address");
    const inv = await browser.call("POST", `/v2/projects/${projectId}/invites`, { email: "x@example.com", role: "viewer" });
    expect(inv.status).toBe(403);

    // Resend retires the first link.
    const resend = await browser.call("POST", "/auth/email/verify/resend");
    expect(resend.body).toEqual({ ok: true, email: "gus@example.com" });
    const newer = s.linkIn("gus@example.com", "/verify-email?token=").token;
    expect((await s.client().call("POST", "/auth/email/verify", { token })).body).toMatchObject({ reason: "used" });
    const ok = await s.client().call("POST", "/auth/email/verify", { token: newer });
    expect(ok.body).toEqual({ ok: true, email: "gus@example.com" });
    expect((await s.client().call("POST", "/auth/email/verify", { token: newer })).status).toBe(400);
    const [u] = await s.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.emailVerifiedAt).toEqual(s.now());
    expect((await browser.call("GET", "/auth/me")).body.account.email_verification_required).toBe(false);
    expect((await browser.call("POST", `/v2/projects/${projectId}/api_keys`, { name: "server" })).status).toBe(201);
    expect((await browser.call("POST", "/auth/email/verify/resend")).body).toEqual({ ok: true, already_verified: true });
  });

  it("Cloud: resend is limited to 5 an hour; links expire after 24 hours", async () => {
    s = await accountServer({ edition: "cloud" });
    const { browser } = await s.signup("hal@example.com");
    for (let i = 0; i < 5; i++) expect((await browser.call("POST", "/auth/email/verify/resend")).status).toBe(200);
    expect((await browser.call("POST", "/auth/email/verify/resend")).status).toBe(429);
    const { token } = s.linkIn("hal@example.com", "/verify-email?token=");
    s.advance(24 * 3600_000 + 1);
    expect((await s.client().call("POST", "/auth/email/verify", { token })).body).toMatchObject({ reason: "expired" });
    expect((await s.client().call("POST", "/auth/email/verify/resend")).status).toBe(401);
  });

  it("a password reset also verifies the email", async () => {
    s = await accountServer({ edition: "cloud" });
    const { userId } = await s.signup("ivy@example.com");
    await forgot(s.client(), "ivy@example.com"); await s.settle();
    await s.client().call("POST", "/auth/password/reset", { token: s.linkIn("ivy@example.com", "/reset-password?token=").token, password: "fresh password 1" });
    const [u] = await s.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u!.emailVerifiedAt).not.toBeNull();
  });

  it("self-hosted: no verification email and no gate", async () => {
    s = await accountServer({ signup: "owner_only" });
    const { browser, projectId } = await s.signup("owner@example.com");
    expect(s.mail.sent).toHaveLength(0);
    expect((await browser.call("GET", "/auth/me")).body.account.email_verification_required).toBe(false);
    expect((await browser.call("POST", `/v2/projects/${projectId}/api_keys`, { name: "server" })).status).toBe(201);
  });
});

describe("account settings", () => {
  it("POST /auth/me changes the name and the alert email opt-out", async () => {
    s = await accountServer();
    const { browser } = await s.signup("jo@example.com");
    const r = await browser.call("POST", "/auth/me", { name: "Jo Park", alert_emails: false });
    expect(r.body.user).toMatchObject({ name: "Jo Park", alert_emails: false });
    expect((await browser.call("GET", "/auth/me")).body.user.alert_emails).toBe(false);
    expect((await browser.call("POST", "/auth/me", { alert_emails: "no" })).status).toBe(400);
    expect((await s.client().call("POST", "/auth/me", { name: "x" })).status).toBe(401);
  });
});
