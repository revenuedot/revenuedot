// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: account settings (prd/account-settings/PRD.md): email change, password change, sessions, two-factor
// authentication with TOTP and recovery codes, OAuth tokens, account deletion, preferences and the display currency.
// Docs: https://revenuedot.app/docs/guides/account-settings
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { accountServer, type Client } from "./account-helpers.js";
import { base32Decode, totp } from "../src/services/totp.js";
import { createSecretKey, resolveKey } from "../src/services/auth.js";
import { sealStoreSecrets } from "../src/services/store-secrets.js";

type S = Awaited<ReturnType<typeof accountServer>>;
let s: S | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const PW = "correct horse battery";
const subjects = (to: string) => s!.mail.sent.filter((m) => m.to === to).map((m) => m.subject);
const login = (b: Client, email: string, password = PW, headers: Record<string, string> = {}) => b.call("POST", "/auth/login", { email, password }, headers);
const code = async (secret: string, at = s!.now()) => totp(base32Decode(secret), at.getTime());

/** Turns two-factor on for a signed-in browser; returns the secret and the recovery codes. */
async function enable2fa(b: Client) {
  const setup = await b.call("POST", "/auth/2fa/setup", { password: PW });
  expect(setup.status).toBe(200);
  const on = await b.call("POST", "/auth/2fa/enable", { code: await code(setup.body.secret) });
  expect(on.status).toBe(200);
  await s!.settle();
  s!.advance(30_000); // the next sign-in uses a new time step
  return { secret: setup.body.secret as string, recovery: on.body.recovery_codes as string[] };
}

describe("email change", () => {
  it("sends a link to the new address and a notice to the old one; the link moves the account once", async () => {
    s = await accountServer();
    const { browser } = await s.signup("ana@example.com");
    expect((await browser.call("POST", "/auth/email/change", { new_email: "ana@new.example", password: "wrong password" })).body).toMatchObject({ type: "invalid_password" });
    expect((await browser.call("POST", "/auth/email/change", { new_email: "ana@example.com", password: PW })).status).toBe(400);
    await s.signup("taken@example.com");
    expect((await browser.call("POST", "/auth/email/change", { new_email: "Taken@Example.com", password: PW })).status).toBe(409);

    const r = await browser.call("POST", "/auth/email/change", { new_email: " Ana@New.Example ", password: PW });
    expect(r.status).toBe(200);
    expect(r.body.pending_email.email).toBe("ana@new.example");
    expect((await browser.call("GET", "/auth/me")).body.user.pending_email.email).toBe("ana@new.example");
    expect(subjects("ana@example.com")).toContain("Your RevenueDot email is about to change");
    const { token, url } = s.linkIn("ana@new.example", "/confirm-email?token=");
    expect(url.startsWith("https://dash.example.com/confirm-email?token=")).toBe(true);
    // Only the hash is stored, with the new address on the row.
    const [row] = await s.db.select().from(schema.authTokens).where(eq(schema.authTokens.kind, "email_change"));
    expect(row!.hash).not.toContain(token);
    expect(row!.newEmail).toBe("ana@new.example");
    // Still the old address until the link is used.
    expect((await browser.call("GET", "/auth/me")).body.user.email).toBe("ana@example.com");

    // The link works in another browser, without a session.
    const other = s.client();
    const done = await other.call("POST", "/auth/email/change/confirm", { token });
    expect(done.body).toEqual({ ok: true, email: "ana@new.example" });
    await s.settle();
    const me = (await browser.call("GET", "/auth/me")).body.user;
    expect(me).toMatchObject({ email: "ana@new.example", email_verified: true, pending_email: null });
    expect(subjects("ana@example.com")).toContain("Your RevenueDot email was changed");
    expect((await login(s.client(), "ana@example.com")).status).toBe(401);
    expect((await login(s.client(), "ana@new.example")).status).toBe(200);
    // Single use.
    expect((await other.call("POST", "/auth/email/change/confirm", { token })).body).toMatchObject({ type: "token_invalid", reason: "used" });
  });

  it("links expire after 24 hours, a new request replaces the old link, cancel stops it, and old links die with the old address", async () => {
    s = await accountServer();
    const { browser } = await s.signup("ben@example.com");
    // A reset link sent to the old address.
    await s.client().call("POST", "/auth/password/forgot", { email: "ben@example.com" }, { "cf-connecting-ip": "203.0.113.9" });
    await s.settle();
    const reset = s.linkIn("ben@example.com", "/reset-password?token=").token;

    await browser.call("POST", "/auth/email/change", { new_email: "ben@one.example", password: PW });
    const first = s.linkIn("ben@one.example", "/confirm-email?token=").token;
    await browser.call("POST", "/auth/email/change", { new_email: "ben@two.example", password: PW });
    const second = s.linkIn("ben@two.example", "/confirm-email?token=").token;
    expect((await s.client().call("POST", "/auth/email/change/confirm", { token: first })).body).toMatchObject({ reason: "used" });
    s.advance(24 * 3600_000 + 60_000);
    expect((await s.client().call("POST", "/auth/email/change/confirm", { token: second })).body).toMatchObject({ type: "token_invalid", reason: "expired" });
    expect((await browser.call("GET", "/auth/me")).body.user.pending_email).toBeNull();

    await browser.call("POST", "/auth/email/change", { new_email: "ben@three.example", password: PW });
    const third = s.linkIn("ben@three.example", "/confirm-email?token=").token;
    expect((await browser.call("DELETE", "/auth/email/change")).body).toEqual({ ok: true, pending_email: null });
    expect((await s.client().call("POST", "/auth/email/change/confirm", { token: third })).body).toMatchObject({ reason: "used" });

    await browser.call("POST", "/auth/email/change", { new_email: "ben@four.example", password: PW });
    const fourth = s.linkIn("ben@four.example", "/confirm-email?token=").token;
    // Someone else takes the address before the link is used.
    await s.signup("ben@four.example");
    expect((await s.client().call("POST", "/auth/email/change/confirm", { token: fourth })).status).toBe(409);

    await browser.call("POST", "/auth/email/change", { new_email: "ben@five.example", password: PW });
    expect((await s.client().call("POST", "/auth/email/change/confirm", { token: s.linkIn("ben@five.example", "/confirm-email?token=").token })).status).toBe(200);
    // The reset link was sent to ben@example.com, which the account no longer uses.
    expect((await s.client().call("POST", "/auth/password/check", { token: reset })).body).toMatchObject({ valid: false });
  });

  it("is rate limited, needs the session, and refuses writes from other sites", async () => {
    s = await accountServer();
    const { browser } = await s.signup("cy@example.com");
    expect((await s.client().call("POST", "/auth/email/change", { new_email: "x@example.com", password: PW })).status).toBe(401);
    expect((await browser.call("POST", "/auth/email/change", { new_email: "x@example.com", password: PW }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    for (let i = 0; i < 5; i++) expect((await browser.call("POST", "/auth/email/change", { new_email: `cy${i}@example.com`, password: PW })).status).toBe(200);
    expect((await browser.call("POST", "/auth/email/change", { new_email: "cy9@example.com", password: PW })).status).toBe(429);
  });
});

describe("password change and sessions", () => {
  it("needs the current password, signs out every other session and emails a notice", async () => {
    s = await accountServer();
    const { browser: laptop } = await s.signup("dee@example.com");
    const phone = s.client();
    await login(phone, "dee@example.com");
    expect((await laptop.call("POST", "/auth/password/change", { current_password: "nope nope", new_password: "a whole new password" })).body).toMatchObject({ type: "invalid_password" });
    expect((await laptop.call("POST", "/auth/password/change", { current_password: PW, new_password: "short" })).status).toBe(400);
    expect((await laptop.call("POST", "/auth/password/change", { current_password: PW, new_password: PW })).status).toBe(400);
    const ok = await laptop.call("POST", "/auth/password/change", { current_password: PW, new_password: "a whole new password" });
    expect(ok.body).toEqual({ ok: true, sessions_revoked: 1 });
    await s.settle();
    expect((await phone.call("GET", "/auth/me")).status).toBe(401);
    expect((await laptop.call("GET", "/auth/me")).status).toBe(200);
    expect(subjects("dee@example.com")).toContain("Your RevenueDot password was changed");
    expect((await login(s.client(), "dee@example.com")).status).toBe(401);
    expect((await login(s.client(), "dee@example.com", "a whole new password")).status).toBe(200);
    const [u] = await s.db.select().from(schema.users).where(eq(schema.users.email, "dee@example.com"));
    expect(u!.passwordChangedAt?.getTime()).toBe(s.now().getTime());
  });

  it("limits wrong current passwords to 10 in 15 minutes", async () => {
    s = await accountServer();
    const { browser } = await s.signup("eli@example.com");
    for (let i = 0; i < 10; i++) expect((await browser.call("POST", "/auth/password/change", { current_password: `wrong ${i} pw`, new_password: "a whole new password" })).status).toBe(400);
    expect((await browser.call("POST", "/auth/password/change", { current_password: PW, new_password: "a whole new password" })).status).toBe(429);
    s.advance(15 * 60_000 + 1000);
    expect((await browser.call("POST", "/auth/password/change", { current_password: PW, new_password: "a whole new password" })).status).toBe(200);
  });

  it("lists sessions by browser with hashed ids, revokes one, the others, or all of them", async () => {
    s = await accountServer();
    const { browser: mac } = await s.signup("fay@example.com");
    const iphone = s.client(), win = s.client();
    await login(iphone, "fay@example.com", PW, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "cf-connecting-ip": "198.51.100.4" });
    s.advance(60_000);
    await login(win, "fay@example.com", PW, { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0" });
    const list = (await mac.call("GET", "/auth/sessions")).body.items as any[];
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ current: true, method: "signup" });
    expect(list.find((x) => x.os === "iOS")).toMatchObject({ browser: "Safari", ip: "198.51.100.4", method: "password", current: false });
    expect(list.find((x) => x.os === "Windows")).toMatchObject({ browser: "Edge" });
    const cookies = [mac, iphone, win].map((b) => b.cookie!.split("=")[1]);
    for (const x of list) expect(cookies).not.toContain(x.id);

    const phoneId = list.find((x) => x.os === "iOS").id;
    expect((await mac.call("DELETE", `/auth/sessions/${phoneId}`)).body).toMatchObject({ ok: true, current: false });
    expect((await iphone.call("GET", "/auth/me")).status).toBe(401);
    expect((await mac.call("DELETE", `/auth/sessions/${phoneId}`)).status).toBe(404);
    expect((await win.call("GET", `/auth/sessions`)).body.items).toHaveLength(2);

    await login(iphone, "fay@example.com");
    expect((await mac.call("POST", "/auth/sessions/revoke_others")).body).toEqual({ ok: true, sessions_revoked: 2 });
    expect((await iphone.call("GET", "/auth/me")).status).toBe(401);
    expect((await win.call("GET", "/auth/me")).status).toBe(401);
    expect((await mac.call("GET", "/auth/me")).status).toBe(200);

    await login(win, "fay@example.com");
    const all = await mac.call("POST", "/auth/logout/all");
    expect(all.body).toEqual({ ok: true, sessions_revoked: 2 });
    expect((await mac.call("GET", "/auth/me")).status).toBe(401);
    expect((await win.call("GET", "/auth/me")).status).toBe(401);
    // Another user's sessions are never listed or touched.
    const { browser: other } = await s.signup("gus@example.com");
    expect((await other.call("GET", "/auth/sessions")).body.items).toHaveLength(1);
  });

  it("records when a session was last active, at most every 5 minutes", async () => {
    s = await accountServer();
    const { browser } = await s.signup("hal@example.com");
    const t0 = s.now().getTime();
    s.advance(2 * 60_000);
    await browser.call("GET", "/auth/me");
    expect((await browser.call("GET", "/auth/sessions")).body.items[0].last_seen_at).toBe(t0);
    s.advance(4 * 60_000);
    await browser.call("GET", "/auth/me");
    expect((await browser.call("GET", "/auth/sessions")).body.items[0].last_seen_at).toBe(t0 + 6 * 60_000);
  });
});

describe("two-factor authentication", () => {
  it("setup needs the password; enabling needs a code and returns 10 recovery codes once", async () => {
    s = await accountServer();
    const { browser } = await s.signup("ivy@example.com");
    expect((await browser.call("POST", "/auth/2fa/setup", { password: "wrong one" })).status).toBe(400);
    const setup = await browser.call("POST", "/auth/2fa/setup", { password: PW });
    expect(setup.body).toMatchObject({ object: "two_factor_setup", issuer: "RevenueDot", digits: 6, period: 30 });
    expect(setup.body.otpauth_url).toBe(`otpauth://totp/RevenueDot:ivy%40example.com?secret=${setup.body.secret}&issuer=RevenueDot&algorithm=SHA1&digits=6&period=30`);
    // Sealed at rest, never the base32 secret itself.
    const [u] = await s.db.select().from(schema.users).where(eq(schema.users.email, "ivy@example.com"));
    expect(u!.totpSecret).not.toContain(setup.body.secret);
    expect((await browser.call("GET", "/auth/me")).body.user.two_factor).toMatchObject({ enabled: false });
    // Pending setup does not change sign-in.
    expect((await login(s.client(), "ivy@example.com")).body).toEqual({ ok: true });

    expect((await browser.call("POST", "/auth/2fa/enable", { code: "000000" })).body).toMatchObject({ type: "invalid_code" });
    const on = await browser.call("POST", "/auth/2fa/enable", { code: await code(setup.body.secret) });
    expect(on.body.enabled).toBe(true);
    expect(on.body.recovery_codes).toHaveLength(10);
    await s.settle();
    expect(subjects("ivy@example.com")).toContain("Two-factor authentication is on");
    expect((await browser.call("GET", "/auth/me")).body.user.two_factor).toMatchObject({ enabled: true, recovery_codes_left: 10 });
    const codes = await s.db.select().from(schema.twoFactorRecoveryCodes);
    expect(codes).toHaveLength(10);
    for (const c of on.body.recovery_codes) for (const r of codes) expect(r.hash).not.toContain(c.replace("-", ""));
    expect((await browser.call("POST", "/auth/2fa/setup", { password: PW })).status).toBe(409);
    expect((await browser.call("POST", "/auth/2fa/enable", { code: await code(setup.body.secret) })).status).toBe(409);
  });

  it("sign-in asks for a code after the password; codes never work twice; a recovery code works once and emails", async () => {
    s = await accountServer();
    const { browser } = await s.signup("jo@example.com");
    const { secret, recovery } = await enable2fa(browser);
    const b = s.client();
    const first = await login(b, "jo@example.com");
    expect(first.body).toMatchObject({ ok: false, two_factor_required: true, methods: ["totp", "recovery_code"] });
    expect(first.cookie).toBeNull();
    expect((await b.call("GET", "/auth/me")).status).toBe(401);
    expect((await b.call("POST", "/auth/login/2fa", { challenge: first.body.challenge, code: "123456" })).status).toBe(401);
    const c1 = await code(secret);
    const ok = await b.call("POST", "/auth/login/2fa", { challenge: first.body.challenge, code: c1 });
    expect(ok.body).toEqual({ ok: true });
    expect((await b.call("GET", "/auth/me")).body.user.email).toBe("jo@example.com");
    // The challenge was used, and the same code in a new sign-in is refused (replay).
    expect((await b.call("POST", "/auth/login/2fa", { challenge: first.body.challenge, code: c1 })).status).toBe(400);
    const again = await login(s.client(), "jo@example.com");
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: again.body.challenge, code: c1 })).status).toBe(401);
    // The next time step works.
    s.advance(30_000);
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: again.body.challenge, code: await code(secret) })).status).toBe(200);

    const lost = s.client();
    const third = await login(lost, "jo@example.com");
    const r = await lost.call("POST", "/auth/login/2fa", { challenge: third.body.challenge, recovery_code: recovery[0]!.toUpperCase().replace("-", " ") });
    expect(r.body).toEqual({ ok: true, recovery_codes_left: 9 });
    await s.settle();
    const sessions = (await lost.call("GET", "/auth/sessions")).body.items as any[];
    expect(sessions.find((x) => x.current).method).toBe("two_factor");
    expect(s.mail.sent.find((m) => m.to === "jo@example.com" && m.subject === "A recovery code was used to sign in")!.text).toContain("9 recovery codes are left");
    const fourth = await login(s.client(), "jo@example.com");
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: fourth.body.challenge, recovery_code: recovery[0] })).status).toBe(401);
    // A recovery code typed in the code field also works.
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: fourth.body.challenge, code: recovery[1] })).status).toBe(200);
  });

  it("limits attempts per challenge and per user; challenges expire after 10 minutes", async () => {
    s = await accountServer();
    const { browser } = await s.signup("kai@example.com");
    const { secret } = await enable2fa(browser);
    const ch = (await login(s.client(), "kai@example.com")).body.challenge;
    for (let i = 0; i < 5; i++) expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: "000000" })).status).toBe(401);
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: await code(secret) })).status).toBe(429);
    // That challenge is finished; a fresh sign-in gets a new one, until the per-user limit (10 wrong codes in 15 minutes).
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: await code(secret) })).status).toBe(400);
    const ch2 = (await login(s.client(), "kai@example.com")).body.challenge;
    for (let i = 0; i < 5; i++) expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch2, code: "000000" })).status).toBe(401);
    const ch3 = (await login(s.client(), "kai@example.com")).body.challenge;
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch3, code: await code(secret) })).status).toBe(429);
    s.advance(15 * 60_000);
    const ch4 = (await login(s.client(), "kai@example.com")).body.challenge;
    s.advance(10 * 60_000 + 1000);
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch4, code: await code(secret) })).body).toMatchObject({ type: "challenge_invalid", reason: "expired" });
    const ch5 = (await login(s.client(), "kai@example.com")).body.challenge;
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch5, code: await code(secret) })).status).toBe(200);
  });

  it("a password reset still needs the second factor before it signs in", async () => {
    s = await accountServer();
    const { browser } = await s.signup("lea@example.com");
    const { secret } = await enable2fa(browser);
    await s.client().call("POST", "/auth/password/forgot", { email: "lea@example.com" }, { "cf-connecting-ip": "203.0.113.5" });
    await s.settle();
    const { token } = s.linkIn("lea@example.com", "/reset-password?token=");
    const b = s.client();
    const r = await b.call("POST", "/auth/password/reset", { token, password: "my brand new password" });
    expect(r.body).toMatchObject({ two_factor_required: true, password_reset: true });
    expect(r.cookie).toBeNull();
    expect((await browser.call("GET", "/auth/me")).status).toBe(401); // every session was revoked
    expect((await b.call("POST", "/auth/login/2fa", { challenge: r.body.challenge, code: await code(secret) })).status).toBe(200);
    expect((await b.call("GET", "/auth/me")).body.user.email).toBe("lea@example.com");
  });

  it("new recovery codes replace the old ones; turning it off needs a code; collaborators show has_mfa", async () => {
    s = await accountServer();
    const { browser, projectId } = await s.signup("max@example.com");
    const { secret, recovery } = await enable2fa(browser);
    expect((await browser.call("GET", `/v2/projects/${projectId}/collaborators`)).body.items[0].has_mfa).toBe(true);
    expect((await browser.call("POST", "/auth/2fa/recovery_codes", { code: "111111" })).status).toBe(400);
    const fresh = await browser.call("POST", "/auth/2fa/recovery_codes", { code: await code(secret) });
    expect(fresh.body.recovery_codes).toHaveLength(10);
    expect(fresh.body.recovery_codes).not.toContain(recovery[0]);
    await s.settle();
    expect(subjects("max@example.com")).toContain("New two-factor recovery codes");
    s.advance(30_000);
    expect((await browser.call("POST", "/auth/2fa/disable", { recovery_code: recovery[0] })).body).toMatchObject({ type: "invalid_code" });
    expect((await browser.call("POST", "/auth/2fa/disable", { recovery_code: fresh.body.recovery_codes[3] })).body).toEqual({ ok: true, enabled: false });
    await s.settle();
    expect(subjects("max@example.com")).toContain("Two-factor authentication is off");
    expect(await s.db.select().from(schema.twoFactorRecoveryCodes)).toHaveLength(0);
    expect((await login(s.client(), "max@example.com")).body).toEqual({ ok: true });
    expect((await browser.call("GET", `/v2/projects/${projectId}/collaborators`)).body.items[0].has_mfa).toBe(false);
  });
});

describe("OAuth tokens", () => {
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const b64url = (u: Uint8Array) => Buffer.from(u).toString("base64url");
  /** The real flow: register, consent with the session, exchange the code. */
  async function connect(b: Client, name: string) {
    const reg = await b.call("POST", "/oauth/register", { client_name: name, redirect_uris: [REDIRECT] });
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const q = { response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "project:write", state: "xyz" };
    const page = await s!.app.fetch(new Request(`http://localhost/oauth/authorize?${new URLSearchParams(q)}`, { headers: { cookie: b.cookie! } }));
    const html = await page.text();
    const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
    const project = /<option value="([^"]+)"/.exec(html)![1]!;
    const res = await s!.app.fetch(new Request("http://localhost/oauth/authorize", { method: "POST", redirect: "manual", headers: { cookie: b.cookie!, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...fields, project_id: project, access: "project:write", decision: "allow" }) }));
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tok = await s!.app.fetch(new Request("http://localhost/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: reg.body.client_id }) }));
    return (await tok.json() as { access_token: string }).access_token;
  }

  it("lists the OAuth keys this person granted, with client, project and access, and revokes them", async () => {
    s = await accountServer();
    const { browser, projectId } = await s.signup("ned@example.com");
    const key = await connect(browser, "Claude");
    await createSecretKey(s.db, projectId!, "Backend", ["*"]); // a plain secret key is not an OAuth token
    const list = (await browser.call("GET", "/auth/oauth_tokens")).body.items as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ client: { name: "Claude", url: "https://claude.ai" }, project: { id: projectId, name: "Scanner" }, access: "read_write", last_used_at: null });
    expect(await resolveKey(s.db, key)).not.toBeNull();
    // Someone else cannot see or revoke it.
    const { browser: stranger } = await s.signup("oli@example.com");
    expect((await stranger.call("GET", "/auth/oauth_tokens")).body.items).toHaveLength(0);
    expect((await stranger.call("DELETE", `/auth/oauth_tokens/${list[0].id}`)).status).toBe(404);
    expect((await browser.call("DELETE", `/auth/oauth_tokens/${list[0].id}`)).body).toEqual({ ok: true, id: list[0].id });
    expect(await resolveKey(s.db, key)).toBeNull();
    const res = await s.app.fetch(new Request(`http://localhost/v2/projects/${projectId}/products`, { headers: { authorization: `Bearer ${key}` } }));
    expect(res.status).toBe(401);
    const [log] = await s.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.projectId, projectId!), eq(schema.auditLogs.actionType, "api_key_deleted")));
    expect(log).toMatchObject({ targetIdentifier: list[0].id, actorType: "user" });
  });
});

describe("account deletion", () => {
  it("is refused while the user owns a project with other members or is its last admin, then deletes properly", async () => {
    s = await accountServer();
    const owner = await s.signup("pat@example.com");
    const mate = await s.signup("quin@example.com");
    // Quin joins Pat's project as a developer.
    await s.db.insert(schema.memberships).values({ userId: mate.userId, projectId: owner.projectId!, role: "developer" });
    const pre = await owner.browser.call("GET", "/auth/account/delete");
    expect(pre.body).toMatchObject({ allowed: false, type: "ownership_transfer_required" });
    const blocked = await owner.browser.call("POST", "/auth/account/delete", { email: "pat@example.com", password: PW });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ type: "ownership_transfer_required", projects: [{ id: owner.projectId, name: "Scanner", reason: "owner", members: 2 }] });

    // Ownership moves to Quin (made an admin first). Pat is still an admin: the account can go now.
    await s.db.update(schema.memberships).set({ role: "admin" }).where(eq(schema.memberships.userId, mate.userId));
    await s.db.update(schema.projects).set({ ownerUserId: mate.userId }).where(eq(schema.projects.id, owner.projectId!));
    // A second project only Pat is in, with a customer, and an OAuth key Pat granted in the shared project.
    const [solo] = await s.db.insert(schema.projects).values({ id: "proj_solo", name: "Side project", ownerUserId: owner.userId }).returning();
    await s.db.insert(schema.memberships).values({ userId: owner.userId, projectId: solo!.id, role: "admin" });
    await s.db.insert(schema.customers).values({ id: "cus_solo", projectId: solo!.id, originalAppUserId: "u1" });
    const [client] = await s.db.insert(schema.oauthClients).values({ id: "oac_test", name: "ChatGPT", redirectUris: ["https://chatgpt.com/cb"] }).returning();
    const oauthKey = await createSecretKey(s.db, owner.projectId!, "OAuth: ChatGPT", ["project_configuration:projects:read"], { userId: owner.userId, clientId: client!.id });
    const plainKey = await createSecretKey(s.db, owner.projectId!, "Backend");
    expect((await owner.browser.call("GET", "/auth/account/delete")).body).toMatchObject({ allowed: true, projects_deleted: [{ id: "proj_solo", name: "Side project" }], projects_left: [{ id: owner.projectId }] });

    expect((await owner.browser.call("POST", "/auth/account/delete", { email: "someone@else.com", password: PW })).body).toMatchObject({ type: "confirmation_mismatch" });
    expect((await owner.browser.call("POST", "/auth/account/delete", { email: "pat@example.com", password: "wrong pass" })).body).toMatchObject({ type: "invalid_password" });
    const ok = await owner.browser.call("POST", "/auth/account/delete", { email: "PAT@example.com", password: PW });
    expect(ok.body).toEqual({ ok: true, deleted: true, projects_deleted: ["proj_solo"] });
    expect(ok.cookie).toContain("rd_session=;");
    await s.settle();
    expect(subjects("pat@example.com")).toContain("Your RevenueDot account was deleted");
    expect(await s.db.select().from(schema.users).where(eq(schema.users.email, "pat@example.com"))).toHaveLength(0);
    expect(await s.db.select().from(schema.sessions).where(eq(schema.sessions.userId, owner.userId))).toHaveLength(0);
    expect(await s.db.select().from(schema.projects).where(eq(schema.projects.id, "proj_solo"))).toHaveLength(0);
    expect(await s.db.select().from(schema.customers).where(eq(schema.customers.id, "cus_solo"))).toHaveLength(0);
    expect(await s.db.select().from(schema.memberships).where(eq(schema.memberships.projectId, owner.projectId!))).toEqual([{ userId: mate.userId, projectId: owner.projectId, role: "admin" }]);
    expect(await resolveKey(s.db, oauthKey.key)).toBeNull();
    expect(await resolveKey(s.db, plainKey.key)).not.toBeNull();
    expect((await login(s.client(), "pat@example.com")).status).toBe(401);
    // The email can sign up again.
    expect((await s.client().call("POST", "/auth/signup", { email: "pat@example.com", password: PW })).status).toBe(201);
  });

  it("refuses the last admin of a project with other members, and asks for a two-factor code", async () => {
    s = await accountServer();
    const a = await s.signup("rae@example.com");
    const b = await s.signup("sam@example.com");
    // Sam's project has no owner on record (its owner left); Rae is its only admin, Sam stays as a viewer.
    await s.db.update(schema.projects).set({ ownerUserId: null }).where(eq(schema.projects.id, b.projectId!));
    await s.db.update(schema.memberships).set({ role: "viewer" }).where(eq(schema.memberships.userId, b.userId));
    await s.db.insert(schema.memberships).values({ userId: a.userId, projectId: b.projectId!, role: "admin" });
    expect((await a.browser.call("POST", "/auth/account/delete", { email: "rae@example.com", password: PW })).body).toMatchObject({ type: "ownership_transfer_required", projects: [{ id: b.projectId, reason: "last_admin" }] });
    await s.db.update(schema.memberships).set({ role: "admin" }).where(eq(schema.memberships.userId, b.userId));
    const { secret } = await enable2fa(a.browser);
    expect((await a.browser.call("POST", "/auth/account/delete", { email: "rae@example.com", password: PW })).body).toMatchObject({ type: "invalid_code" });
    expect((await a.browser.call("POST", "/auth/account/delete", { email: "rae@example.com", password: PW, code: await code(secret) })).status).toBe(200);
    expect(await s.db.select().from(schema.projects).where(eq(schema.projects.id, b.projectId!))).toHaveLength(1);
  });

  it("on Cloud, refuses while Cloud Standard is active", async () => {
    s = await accountServer({ edition: "cloud" });
    const a = await s.signup("tia@example.com");
    await s.db.insert(schema.billingAccounts).values({ userId: a.userId, plan: "standard", status: "active", stripeCustomerId: "cus_1" });
    expect((await a.browser.call("POST", "/auth/account/delete", { email: "tia@example.com", password: PW })).body).toMatchObject({ type: "billing_active" });
    await s.db.update(schema.billingAccounts).set({ status: "canceled", plan: "free" });
    expect((await a.browser.call("POST", "/auth/account/delete", { email: "tia@example.com", password: PW })).status).toBe(200);
  });
});

describe("preferences, projects, notifications and the exchange rate", () => {
  it("stores theme, tint, week start and display currency per user, and validates them", async () => {
    s = await accountServer();
    const { browser } = await s.signup("uma@example.com");
    expect((await browser.call("GET", "/auth/me")).body.user.preferences).toEqual({ theme: "system", tint: null, week_start: 1, display_currency: "USD" });
    for (const bad of [{ theme: "blue" }, { tint: "red" }, { tint: "#12345" }, { week_start: 7 }, { week_start: 1.5 }, { display_currency: "XYZ" }]) {
      expect((await browser.call("POST", "/auth/me", bad)).status).toBe(400);
    }
    const r = await browser.call("POST", "/auth/me", { theme: "dark", tint: "#2a78d6", week_start: 0, display_currency: "eur" });
    expect(r.body.user.preferences).toEqual({ theme: "dark", tint: "#2A78D6", week_start: 0, display_currency: "EUR" });
    expect((await browser.call("POST", "/auth/me", { tint: null })).body.user.preferences.tint).toBeNull();
    // Another person's preferences are their own.
    const { browser: other } = await s.signup("vic@example.com");
    expect((await other.call("GET", "/auth/me")).body.user.preferences.theme).toBe("system");
  });

  it("lists projects with role, owner and plan (self-hosted)", async () => {
    s = await accountServer();
    const a = await s.signup("wes@example.com");
    const b = await s.signup("xia@example.com");
    await s.db.insert(schema.memberships).values({ userId: a.userId, projectId: b.projectId!, role: "viewer" });
    const r = (await a.browser.call("GET", "/auth/account/projects")).body;
    expect(r.edition).toBe("self-hosted");
    expect(r.items).toMatchObject([
      { id: a.projectId, role: "admin", is_owner: true, members: 1, plan: { id: "self_hosted", name: "Self-hosted" } },
      { id: b.projectId, role: "viewer", is_owner: false, members: 2, owner: { email: "xia@example.com" } },
    ]);
  });

  it("lists projects with the owner's Cloud plan", async () => {
    s = await accountServer({ edition: "cloud" });
    const a = await s.signup("yan@example.com");
    await s.db.insert(schema.billingAccounts).values({ userId: a.userId, plan: "standard", status: "active" });
    expect((await a.browser.call("GET", "/auth/account/projects")).body.items[0].plan).toEqual({ id: "standard", name: "Cloud Standard" });
  });

  it("keeps notification choices per user and project; only members may choose", async () => {
    s = await accountServer();
    const a = await s.signup("zed@example.com");
    const b = await s.signup("amy@example.com");
    expect((await a.browser.call("GET", "/auth/notifications")).body).toMatchObject({
      alert_emails: true, projects: [{ project: { id: a.projectId, role: "admin" }, weekly_summary: false, experiment_results: false, anomaly_alerts: false, anomaly_sensitivity: "medium" }],
    });
    const r = await a.browser.call("PUT", `/auth/notifications/${a.projectId}`, { weekly_summary: true, anomaly_alerts: true, anomaly_sensitivity: "high" });
    expect(r.body).toMatchObject({ weekly_summary: true, experiment_results: false, anomaly_alerts: true, anomaly_sensitivity: "high" });
    expect((await a.browser.call("PUT", `/auth/notifications/${a.projectId}`, { anomaly_sensitivity: "extreme" })).status).toBe(400);
    expect((await a.browser.call("PUT", `/auth/notifications/${b.projectId}`, { weekly_summary: true })).status).toBe(404);
    expect((await a.browser.call("PUT", `/auth/notifications/${a.projectId}`, { weekly_summary: false })).body).toMatchObject({ weekly_summary: false, anomaly_alerts: true });
  });

  it("lists the Stripe accounts connected to apps in the person's projects, never another person's", async () => {
    s = await accountServer();
    const a = await s.signup("cora@example.com");
    const b = await s.signup("dan@example.com");
    const stripeApp = async (id: string, projectId: string, account: string | null, mode = "live") => {
      const base = { id, projectId, name: `Web ${id}`, type: "stripe", publicKey: `strp_${id}`, credentials: {} as Record<string, unknown> };
      const sealed = account ? await sealStoreSecrets(base, { stripe_connect_account_id: account }, null) : null;
      await s!.db.insert(schema.apps).values({ ...base, ...(sealed ? { secrets: sealed.secrets, secretHints: sealed.secretHints, credentials: { ...sealed.credentials, stripe_connect_mode: mode } } : {}) });
      if (account) await s!.db.insert(schema.stripeConnections).values({ appId: id, projectId, status: "connected", method: "oauth", mode, chargesEnabled: true, detailsSubmitted: true, connectedAt: s!.now() });
    };
    await stripeApp("app_live", a.projectId!, "acct_1Abcdefghij1234");
    await stripeApp("app_test", a.projectId!, "acct_1Zyxwvutsrq9876", "test");
    await stripeApp("app_none", a.projectId!, null);
    await stripeApp("app_other", b.projectId!, "acct_1Otherperson0000");
    const r = (await a.browser.call("GET", "/auth/stripe_accounts")).body;
    expect(r.available).toBe(false);
    expect(r.items.map((x: any) => [x.app.id, x.mode, x.method])).toEqual([["app_live", "live", "oauth"], ["app_test", "test", "oauth"]]);
    expect(JSON.stringify(r)).not.toContain("acct_1Abcdefghij1234");
    expect(r.items[0].account).toMatch(/1234$/);
    expect(r.connectable_apps).toEqual([{ app: { id: "app_none", name: "Web app_none" }, project: { id: a.projectId, name: "Scanner" } }]);
    expect((await a.browser.call("GET", "/auth/me")).body.account.features).toEqual({ stripe_connect: true });
  });

  it("answers the display currency's rate from cached or bundled ECB rates", async () => {
    // No network in this test: every outside request fails, so the rates come from the bundle.
    s = await accountServer({ fetch: (async () => new Response("down", { status: 503 })) as typeof fetch });
    const { browser } = await s.signup("bea@example.com");
    expect((await browser.call("GET", "/auth/fx")).body).toMatchObject({ currency: "USD", rate: 1 });
    const eur = (await browser.call("GET", "/auth/fx?currency=EUR")).body;
    expect(eur).toMatchObject({ object: "fx_rate", base: "USD", currency: "EUR", source: "ecb" });
    expect(eur.rate).toBeGreaterThan(0.5);
    expect(eur.rate).toBeLessThan(1.5);
    const jpy = (await browser.call("GET", "/auth/fx?currency=jpy")).body;
    expect(jpy.rate).toBeGreaterThan(50);
    expect((await browser.call("GET", "/auth/fx?currency=XYZ")).status).toBe(400);
    // A cached ECB day wins over the bundle.
    await s.db.insert(schema.fxRates).values({ source: "ecb", date: "2026-09-30", rates: { EUR: 1, USD: 1.25, GBP: 0.8 } });
    expect((await browser.call("GET", "/auth/fx?currency=EUR")).body).toMatchObject({ rate: 0.8, date: "2026-09-30" });
    expect((await browser.call("GET", "/auth/fx?currency=GBP")).body.rate).toBe(0.64);
  });
});

describe("review fixes", () => {
  it("an address taken between the check and the move answers 409, never a 500", async () => {
    s = await accountServer();
    const a = await s.signup("ari@example.com");
    await a.browser.call("POST", "/auth/email/change", { new_email: "race@example.com", password: PW });
    const { token } = s.linkIn("race@example.com", "/confirm-email?token=");
    // Another account takes the address at the last moment: a trigger signs it up right before the move is written.
    await s.db.execute(sql`CREATE FUNCTION steal_address() RETURNS trigger AS $$ BEGIN
      IF NEW.email = 'race@example.com' AND OLD.email <> NEW.email THEN INSERT INTO users (id, email) VALUES ('usr_thief', 'race@example.com') ON CONFLICT DO NOTHING; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`);
    await s.db.execute(sql`CREATE TRIGGER steal_address BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION steal_address()`);
    const r = await s.client().call("POST", "/auth/email/change/confirm", { token });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ type: "email_taken" });
    expect((await a.browser.call("GET", "/auth/me")).body.user.email).toBe("ari@example.com");
  });

  it("counts only wrong codes towards the 10 per 15 minutes: ten good sign-ins in a row still work", async () => {
    s = await accountServer();
    const { browser } = await s.signup("cal@example.com");
    const { secret } = await enable2fa(browser);
    for (let i = 0; i < 11; i++) {
      const ch = (await login(s.client(), "cal@example.com")).body.challenge;
      expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: await code(secret) })).status).toBe(200);
      s.advance(30_000); // a new time step: the same code never works twice
    }
    // Ten wrong codes (two sign-in attempts of five) pause code checks, even for the right code.
    for (let k = 0; k < 2; k++) {
      const ch = (await login(s.client(), "cal@example.com")).body.challenge;
      for (let i = 0; i < 5; i++) expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: "000000" })).status).toBe(401);
    }
    const ch = (await login(s.client(), "cal@example.com")).body.challenge;
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: await code(secret) })).status).toBe(429);
  });

  it("a password change or reset ends sign-in challenges that began with the old password", async () => {
    s = await accountServer();
    const { browser } = await s.signup("dov@example.com");
    const { secret } = await enable2fa(browser);
    const ch = (await login(s.client(), "dov@example.com")).body.challenge;
    expect((await browser.call("POST", "/auth/password/change", { current_password: PW, new_password: "another long password" })).status).toBe(200);
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch, code: await code(secret) })).body).toMatchObject({ type: "challenge_invalid" });

    const ch2 = (await login(s.client(), "dov@example.com", "another long password")).body.challenge;
    await s.client().call("POST", "/auth/password/forgot", { email: "dov@example.com" }, { "cf-connecting-ip": "203.0.113.7" });
    await s.settle();
    const { token } = s.linkIn("dov@example.com", "/reset-password?token=");
    const r = await s.client().call("POST", "/auth/password/reset", { token, password: "a third long password" });
    expect(r.body).toMatchObject({ two_factor_required: true });
    s.advance(30_000);
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: ch2, code: await code(secret) })).body).toMatchObject({ type: "challenge_invalid" });
    // The reset's own challenge still works.
    expect((await s.client().call("POST", "/auth/login/2fa", { challenge: r.body.challenge, code: await code(secret) })).status).toBe(200);
  });

  it("a session id of another person can be neither listed nor signed out", async () => {
    s = await accountServer();
    const a = await s.signup("gia@example.com");
    const b = await s.signup("hob@example.com");
    const theirs = (await b.browser.call("GET", "/auth/sessions")).body.items[0].id as string;
    expect((await a.browser.call("DELETE", `/auth/sessions/${theirs}`)).status).toBe(404);
    expect((await b.browser.call("GET", "/auth/me")).status).toBe(200);
    expect((await a.browser.call("GET", "/auth/sessions")).body.items.map((x: any) => x.id)).not.toContain(theirs);
  });

  it("an email change with two-factor on needs a code too", async () => {
    s = await accountServer();
    const { browser } = await s.signup("ira@example.com");
    const { secret } = await enable2fa(browser);
    expect((await browser.call("POST", "/auth/email/change", { new_email: "ira@new.example", password: PW })).body).toMatchObject({ type: "invalid_code" });
    expect((await browser.call("POST", "/auth/email/change", { new_email: "ira@new.example", password: PW, code: await code(secret) })).status).toBe(200);
  });

  it("account deletion leaves an audit entry, with the email, in every project the person leaves", async () => {
    s = await accountServer();
    const owner = await s.signup("eve@example.com");
    const leaver = await s.signup("fin@example.com");
    await s.db.insert(schema.memberships).values({ userId: leaver.userId, projectId: owner.projectId!, role: "developer" });
    expect((await leaver.browser.call("POST", "/auth/account/delete", { email: "fin@example.com", password: PW })).status).toBe(200);
    const logs = await s.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, owner.projectId!));
    expect(logs).toEqual([expect.objectContaining({
      actionType: "collaborator_account_deleted", targetType: "collaborator", targetIdentifier: leaver.userId, actorType: "user", actorIdentifier: leaver.userId,
      additionalData: expect.objectContaining({ email: "fin@example.com", via: "account_settings" }),
    })]);
  });
});
