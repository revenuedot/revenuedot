/**
 * Account settings end to end (prd/account-settings/PRD.md): the six sections at /account/* with their own left nav.
 * General (name, email change confirmed from the new address, an expired and a cancelled link, log out of all
 * sessions), Security (wrong current password, two-factor setup from the QR key, sign-in with a code and with a recovery
 * code, sessions, OAuth tokens, new codes, turning it off), deleting an account (blocked while another member needs an
 * owner, allowed after the transfer), Notifications, Interface (theme and tint across pages), Date and region (week
 * start in the calendar and the weekly chart, amounts in EUR on the Overview, Customers and Charts), Billing (owned
 * projects; Cloud billing on the Cloud server). Emails come from GET /__mail. Every page at 390px, dark mode, and no
 * console errors.
 *   E2E_PORT=5530 pnpm --filter @revenuedot/dashboard e2e -- account-settings
 */
import { createHmac, createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 5199);
const CLOUD = `http://localhost:${PORT + 1}`;
const stamp = Date.now();
const PW = `e2e-${stamp}-acct`;

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), written here independently of the server's implementation. */
function totp(secretB32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/\s/g, "").toUpperCase()) { value = (value << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const off = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function json<T = any>(req: APIRequestContext, method: string, url: string, data?: unknown): Promise<T> {
  const res = await req.fetch(url, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
}
/** No sideways scroll at 390px, then back to desktop. Also screenshots the dark variant when SHOTS is set. */
async function phone(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
async function dark(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(150);
  // System theme follows the operating system: the page background turns dark.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}
const mails = async (req: APIRequestContext, to: string, base = "") => json<{ subject: string; text: string }[]>(req, "GET", `${base}/__mail?to=${encodeURIComponent(to)}`);
async function linkIn(req: APIRequestContext, to: string, path: string, base = "") {
  let found = "";
  await expect.poll(async () => {
    for (const m of [...await mails(req, to, base)].reverse()) {
      const u = new RegExp(`https?://[^\\s]+${path.replace(/[?]/g, "\\?")}[^\\s]+`).exec(m.text);
      if (u) { found = new URL(u[0]).pathname + new URL(u[0]).search; return true; }
    }
    return false;
  }, { timeout: 10_000 }).toBe(true);
  return found;
}
async function signup(req: APIRequestContext, email: string, name: string, project: string, base = "") {
  await json(req, "POST", `${base}/auth/signup`, { email, password: PW, name, project_name: project });
  return (await json<{ projects: { id: string }[] }>(req, "GET", `${base}/auth/me`)).projects[0]!.id;
}
const newPage = async (browser: Browser) => (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();

test("General: name, email change confirmed from the new inbox, expired and cancelled links, log out everywhere", async ({ page, browser }) => {
  const errors = watch(page);
  const email = `general-${stamp}@revenuedot.test`, next = `general-new-${stamp}@revenuedot.test`;
  await signup(page.request, email, "Gail General", "General project");
  await page.goto("/account");
  await page.waitForURL(/\/account\/general$/);
  await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  const navEl = page.getByRole("navigation", { name: "Account settings" });
  for (const s of ["General", "Billing", "Security", "Notifications", "Interface", "Date and region"]) await expect(navEl.getByRole("link", { name: s, exact: true })).toBeVisible();
  await expect(navEl.getByRole("link", { name: /Back to General project/ })).toBeVisible();

  await page.getByLabel("Your name").fill("Gail G. General");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Name saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your name")).toHaveValue("Gail G. General");

  // Wrong password, then the request: a link to the new inbox and a notice to the old one.
  await page.getByRole("button", { name: "Change email" }).click();
  const dlg = page.getByRole("dialog", { name: "Change email" });
  await dlg.getByLabel("New email").fill(next);
  await dlg.getByLabel("Current password").fill("not my password");
  await dlg.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("Your current password is not right.");
  await dlg.getByLabel("Current password").fill(PW);
  await dlg.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(page.locator("[data-pending-email]")).toContainText(next);
  expect((await mails(page.request, email)).map((m) => m.subject)).toContain("Your RevenueDot email is about to change");
  const expired = await linkIn(page.request, next, "/confirm-email?token=");
  // 24 hours pass for this link.
  await json(page.request, "POST", "/__tokens/expire", { email, kind: "email_change" });
  const other = await newPage(browser);
  await other.goto(expired);
  // Opening the link changes nothing (mail scanners open links too): the move needs a click.
  await expect(other.getByRole("heading", { name: "Confirm your new email" })).toBeVisible();
  await other.getByRole("button", { name: "Confirm new email" }).click();
  await expect(other.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await expect(other.getByText("This link has expired.")).toBeVisible();
  await phone(other, "confirm-email-expired");
  await page.reload();
  await expect(page.locator("[data-pending-email]")).toHaveCount(0);

  // A new request, cancelled: its link stops working.
  await page.getByRole("button", { name: "Change email" }).click();
  await dlg.getByLabel("New email").fill(next);
  await dlg.getByLabel("Current password").fill(PW);
  await dlg.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(page.locator("[data-pending-email]")).toBeVisible();
  const cancelled = await linkIn(page.request, next, "/confirm-email?token=");
  expect(cancelled).not.toBe(expired);
  await page.getByRole("button", { name: "Cancel change" }).click();
  await expect(page.locator("[data-pending-email]")).toHaveCount(0);
  await other.goto(cancelled);
  await other.getByRole("button", { name: "Confirm new email" }).click();
  await expect(other.getByText("This link was already used.")).toBeVisible();

  // The real one, opened in another browser without a session.
  await page.getByRole("button", { name: "Change email" }).click();
  await dlg.getByLabel("New email").fill(next);
  await dlg.getByLabel("Current password").fill(PW);
  await dlg.getByRole("button", { name: "Send confirmation link" }).click();
  await expect(page.locator("[data-pending-email]")).toBeVisible();
  await shot(page, "account-general-pending");
  const good = await linkIn(page.request, next, "/confirm-email?token=");
  await other.goto(good);
  await expect(other.getByRole("heading", { name: "Confirm your new email" })).toBeVisible();
  expect((await json(page.request, "GET", "/auth/me")).user.email).toBe(email);
  await other.getByRole("button", { name: "Confirm new email" }).click();
  await expect(other.getByRole("heading", { name: "Email changed" })).toBeVisible();
  await expect(other.getByText(`Your account now uses ${next}.`)).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-email]")).toHaveText(next);
  expect((await json(page.request, "GET", "/auth/me")).user).toMatchObject({ email: next, email_verified: true, pending_email: null });
  await expect.poll(async () => (await mails(page.request, email)).map((m) => m.subject)).toContain("Your RevenueDot email was changed");
  await phone(page, "account-general");
  await dark(page, "account-general");

  // Log out of all sessions: this browser and another one.
  const second = await newPage(browser);
  await json(second.request, "POST", "/auth/login", { email: next, password: PW });
  expect((await second.request.get("/auth/me")).status()).toBe(200);
  await page.getByRole("button", { name: "Log out of all sessions" }).click();
  await page.waitForURL(/\/login$/);
  expect((await second.request.get("/auth/me")).status()).toBe(401);
  expect((await page.request.get("/auth/me")).status()).toBe(401);
  // The old address no longer signs in; the new one does.
  expect((await page.request.post("/auth/login", { data: { email, password: PW } })).status()).toBe(401);
  expect((await page.request.post("/auth/login", { data: { email: next, password: PW } })).status()).toBe(200);
  expect(errors).toEqual([]);
});

test("Security: password, two-factor from the QR key, sign-in with a code and a recovery code, sessions, OAuth tokens", async ({ page, browser }) => {
  const errors = watch(page);
  const email = `security-${stamp}@revenuedot.test`;
  const pid = await signup(page.request, email, "Sid Secure", "Secure project");
  const laptop = await newPage(browser);
  await json(laptop.request, "POST", "/auth/login", { email, password: PW });
  await page.goto("/account/security");
  await expect(page.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();

  // Password: a wrong current password, then a change that signs out the other browser.
  const NEW = `${PW}-2`;
  await page.getByLabel("Current password").fill("not it at all");
  await page.getByLabel("New password", { exact: true }).fill(NEW);
  await page.getByLabel("New password again").fill(NEW);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Your current password is not right.");
  await page.getByLabel("Current password").fill(PW);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Password updated. 1 other session was signed out." })).toBeVisible();
  expect((await laptop.request.get("/auth/me")).status()).toBe(401);
  await expect.poll(async () => (await mails(page.request, email)).map((m) => m.subject)).toContain("Your RevenueDot password was changed");

  // Two-factor: password, QR and key, a wrong code, the right one, ten recovery codes.
  await page.getByRole("button", { name: "Set up" }).click();
  const setup = page.getByRole("dialog", { name: "Set up two-factor authentication" });
  await setup.getByLabel("Password", { exact: true }).fill(NEW);
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(setup.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = (await setup.locator("[data-secret]").innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await shot(page, "account-2fa-qr");
  await setup.getByLabel(/Enter the 6-digit code/).fill(totp(secret, Date.now() - 120_000));
  await setup.getByRole("button", { name: "Turn on" }).click();
  await expect(setup.getByRole("alert")).toContainText("That code is not right.");
  await setup.getByLabel(/Enter the 6-digit code/).fill(totp(secret));
  await setup.getByRole("button", { name: "Turn on" }).click();
  await expect(setup.locator("[data-recovery-codes] li")).toHaveCount(10);
  const codes = await setup.locator("[data-recovery-codes] li").allInnerTexts();
  expect(codes).toHaveLength(10);
  await shot(page, "account-2fa-codes");
  await setup.getByRole("button", { name: "I saved my codes" }).click();
  await expect(page.locator("[data-two-factor=on]")).toBeVisible();
  await expect(page.locator("[data-codes-left]")).toHaveText("10 of 10 left");
  await expect.poll(async () => (await mails(page.request, email)).map((m) => m.subject)).toContain("Two-factor authentication is on");

  // Sign-in now asks for a code: a wrong one, then the next step's code (the current step was used to turn it on).
  const phoneCtx = await newPage(browser);
  const pErrors = watch(phoneCtx);
  await phoneCtx.goto("/login");
  await phoneCtx.getByLabel("Email").fill(email);
  await phoneCtx.getByLabel("Password").fill(NEW);
  await phoneCtx.getByRole("button", { name: "Sign in" }).click();
  await expect(phoneCtx.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  expect((await phoneCtx.request.get("/auth/me")).status()).toBe(401);
  await phone(phoneCtx, "login-2fa");
  await phoneCtx.getByLabel("Authentication code").fill(totp(secret, Date.now() - 300_000));
  await phoneCtx.getByRole("button", { name: "Verify" }).click();
  await expect(phoneCtx.getByRole("alert")).toContainText("That code is not right.");
  await phoneCtx.getByLabel("Authentication code").fill(totp(secret, Date.now() + 30_000));
  await phoneCtx.getByRole("button", { name: "Verify" }).click();
  await phoneCtx.waitForURL(/\/projects\/[^/]+\/overview/);

  // Lost phone: a recovery code instead.
  const lost = await newPage(browser);
  await lost.goto("/login");
  await lost.getByLabel("Email").fill(email);
  await lost.getByLabel("Password").fill(NEW);
  await lost.getByRole("button", { name: "Sign in" }).click();
  await lost.getByRole("button", { name: "Lost your phone? Use a recovery code" }).click();
  await lost.getByLabel("Recovery code").fill(codes[0]!);
  await lost.getByRole("button", { name: "Verify" }).click();
  await lost.waitForURL(/\/projects\/[^/]+\/overview/);
  await expect.poll(async () => (await mails(page.request, email)).map((m) => m.subject)).toContain("A recovery code was used to sign in");
  await page.reload();
  await expect(page.locator("[data-codes-left]")).toHaveText("9 of 10 left");

  // Sessions: this browser, the phone and the lost-phone browser; sign the others out.
  const rows = page.locator("[data-session]");
  await expect(rows).toHaveCount(3);
  await expect(page.locator("[data-session=current]")).toContainText("This browser");
  await expect(page.locator("[data-session=other]").first()).toContainText("Password and code");
  await page.getByRole("button", { name: "Sign out other sessions" }).click();
  await page.getByRole("dialog", { name: "Sign out other sessions?" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 sessions signed out." })).toBeVisible();
  await expect(rows).toHaveCount(1);
  expect((await lost.request.get("/auth/me")).status()).toBe(401);
  expect((await phoneCtx.request.get("/auth/me")).status()).toBe(401);

  // An AI assistant connected through OAuth, then revoked here.
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const reg = await json(page.request, "POST", "/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "project:write", state: "s" });
  const html = await (await page.request.get(`/oauth/authorize?${q}`)).text();
  const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&")]));
  const allow = await page.request.post("/oauth/authorize", { form: { ...fields, project_id: pid, access: "project:write", decision: "allow" }, maxRedirects: 0 });
  const code = new URL(allow.headers().location!).searchParams.get("code")!;
  const token = (await json(page.request, "POST", "/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: reg.client_id })).access_token as string;
  expect((await page.request.get(`/v2/projects/${pid}/products`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
  await page.reload();
  const tok = page.locator("[data-token]");
  await expect(tok).toHaveCount(1);
  await expect(tok).toContainText("Claude");
  await expect(tok).toContainText("https://claude.ai");
  await expect(tok).toContainText("Secure project");
  await expect(tok).toContainText("Read and change");
  await shot(page, "account-security");
  await phone(page, "account-security");
  await dark(page, "account-security");
  await tok.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "Revoke Claude?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(tok).toHaveCount(0);
  expect((await page.request.get(`/v2/projects/${pid}/products`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);

  // New recovery codes need a code; then turning it off with a recovery code.
  await page.getByRole("button", { name: "Make new codes" }).click();
  const fresh = page.getByRole("dialog", { name: "Make new recovery codes" });
  // The authenticator's next codes were used to sign in moments ago (a code never works twice): a recovery code.
  await fresh.getByLabel("Code").fill(codes[2]!);
  await fresh.getByRole("button", { name: "Make new codes" }).click();
  await expect(fresh.locator("[data-recovery-codes] li")).toHaveCount(10);
  const newCodes = await fresh.locator("[data-recovery-codes] li").allInnerTexts();
  expect(newCodes).toHaveLength(10);
  await fresh.getByRole("button", { name: "I saved my codes" }).click();
  await expect(page.locator("[data-codes-left]")).toHaveText("10 of 10 left");
  await page.getByRole("button", { name: "Turn off" }).click();
  const off = page.getByRole("dialog", { name: "Turn off two-factor authentication" });
  await off.getByLabel("Code").fill(codes[1]!); // an old code no longer works
  await off.getByRole("button", { name: "Turn off" }).click();
  await expect(off.getByRole("alert")).toContainText("That code is not right.");
  await off.getByLabel("Code").fill(newCodes[0]!);
  await off.getByRole("button", { name: "Turn off" }).click();
  await expect(page.locator("[data-two-factor=off]")).toBeVisible();
  expect((await json(page.request, "POST", "/auth/login", { email, password: NEW })).ok).toBe(true);
  expect(errors).toEqual([]);
  expect(pErrors).toEqual([]);
});

test("Delete account: refused while another member needs an owner, allowed after the transfer, data gone", async ({ page, browser }) => {
  const errors = watch(page);
  const owner = `owner-${stamp}@revenuedot.test`, mate = `mate-${stamp}@revenuedot.test`;
  const pid = await signup(page.request, owner, "Olive Owner", "Shared project");
  const mateCtx = await newPage(browser);
  const matePid = await signup(mateCtx.request, mate, "Matt Mate", "Mate project");
  await json(page.request, "POST", `/v2/projects/${pid}/invites`, { email: mate, role: "admin" });
  const invite = await linkIn(page.request, mate, "/invite?token=");
  const inviteToken = new URLSearchParams(invite.split("?")[1]).get("token")!;
  await json(mateCtx.request, "POST", `/auth/invites/${encodeURIComponent(inviteToken)}/accept`);

  await page.goto("/account/general");
  await page.getByRole("button", { name: "Delete account" }).click();
  const dlg = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dlg.locator("[data-deletion=blocked]")).toBeVisible();
  await expect(dlg.getByRole("alert")).toContainText("Transfer ownership first");
  await expect(dlg.getByText(/Shared project · 2 members · you own it/)).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Delete account" })).toHaveCount(0);
  await shot(page, "account-delete-blocked");
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // Ownership goes to the teammate; now the account can go.
  const mateId = (await json(mateCtx.request, "GET", "/auth/me")).user.id;
  await json(page.request, "POST", `/v2/projects/${pid}/actions/transfer_ownership`, { user_id: mateId });
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(dlg.locator("[data-deletion=allowed]")).toBeVisible();
  await expect(dlg.getByText("No project is deleted")).toBeVisible();
  await dlg.getByLabel(`Type ${owner} to confirm`).fill(owner);
  await dlg.getByLabel("Password").fill("wrong password");
  await dlg.getByRole("button", { name: "Delete account" }).click();
  await expect(dlg.getByRole("alert")).toHaveText("Your current password is not right.");
  await dlg.getByLabel("Password").fill(PW);
  await phone(page, "account-delete-dialog");
  await dlg.getByRole("button", { name: "Delete account" }).click();
  await page.waitForURL(/\/login\?deleted=1/);
  await expect(page.getByRole("status").filter({ hasText: "Your account was deleted." })).toBeVisible();
  await expect.poll(async () => (await mails(page.request, owner)).map((m) => m.subject)).toContain("Your RevenueDot account was deleted");
  expect((await page.request.post("/auth/login", { data: { email: owner, password: PW } })).status()).toBe(401);
  // The teammate keeps the shared project, now as its only member and owner, and their own.
  const me = await json(mateCtx.request, "GET", "/auth/me");
  expect(me.projects.map((p: { id: string }) => p.id).sort()).toEqual([pid, matePid].sort());
  const people = await json(mateCtx.request, "GET", `/v2/projects/${pid}/collaborators`);
  expect(people.items.map((p: { email: string }) => p.email)).toEqual([mate]);
  expect(errors.filter((e) => !/409/.test(e))).toEqual([]);
});

test("Notifications, Interface and Date and region: saved per person and applied on every page", async ({ page }) => {
  const errors = watch(page);
  const email = `prefs-${stamp}@revenuedot.test`;
  const pid = await signup(page.request, email, "Pia Prefs", "Prefs project");
  // Production revenue: $120 today and $80 ten days ago.
  const buyer = (await json(page.request, "POST", "/__revenue", { email, usd: 120 })).customer as string;
  await json(page.request, "POST", "/__revenue", { email, usd: 80, daysAgo: 10 });

  // Notifications.
  await page.goto("/account/notifications");
  await page.getByRole("switch", { name: "Weekly summary for Prefs project" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Weekly summary on for Prefs project." })).toBeVisible();
  await page.getByRole("switch", { name: "Revenue anomalies for Prefs project" }).click();
  await page.getByLabel("Sensitivity for Prefs project").selectOption("high");
  await expect(page.getByRole("status").filter({ hasText: "Sensitivity high for Prefs project." })).toBeVisible();
  const alerts = page.getByRole("switch", { name: "Email me about problems with my projects" });
  await alerts.click();
  await expect(alerts).toHaveAttribute("aria-checked", "false");
  expect((await json(page.request, "GET", "/auth/notifications")).projects[0]).toMatchObject({ weekly_summary: true, experiment_results: false, anomaly_alerts: true, anomaly_sensitivity: "high" });
  expect((await json(page.request, "GET", "/auth/me")).user.alert_emails).toBe(false);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Weekly summary for Prefs project" })).toHaveAttribute("aria-checked", "true");
  await shot(page, "account-notifications");
  await phone(page, "account-notifications");

  // The weekly summary for this project, sent as the tick would on the first day of the week.
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7)); monday.setUTCHours(9, 0, 0, 0);
  await json(page.request, "POST", "/__notifications/run", { at: monday.toISOString() });
  await expect.poll(async () => (await mails(page.request, email)).some((m) => /^Prefs project: your week/.test(m.subject))).toBe(true);

  // Interface: dark theme, then a blue tint, on this page and the Overview; reset; system.
  await page.goto("/account/interface");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => (await json(page.request, "GET", "/auth/me")).user.preferences.theme).toBe("dark");
  await page.getByRole("radio", { name: "Blue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Tint #2A78D6 saved." })).toBeVisible();
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toUpperCase());
  expect(await accent()).toBe("#2A78D6");
  const light = await page.locator("[data-ratio-light]").innerText(), darkRatio = await page.locator("[data-ratio-dark]").innerText();
  expect(parseFloat(light)).toBeGreaterThanOrEqual(4.5);
  expect(parseFloat(darkRatio)).toBeGreaterThanOrEqual(4.5);
  await shot(page, "account-interface-dark-blue");
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await accent()).toBe("#2A78D6");
  // Surfaces stay neutral: the page is the dark token, not tinted.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
  await page.goto("/account/interface");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect.poll(accent).toBe("#F7B500");
  await page.getByRole("radio", { name: "Light" }).click();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
  await page.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect((await json(page.request, "GET", "/auth/me")).user.preferences).toMatchObject({ theme: "system", tint: null });
  await phone(page, "account-interface");

  // Date and region: weeks on Sunday, money in euros.
  await page.goto("/account/date-and-region");
  await page.getByLabel("Start week on").selectOption("0");
  await expect(page.getByRole("status").filter({ hasText: "Weeks start on Sunday." })).toBeVisible();
  await page.getByRole("button", { name: "Choose sample date" }).click();
  const grid = page.getByRole("grid");
  await expect(grid).toHaveAttribute("data-week-start", "0");
  await expect(grid.getByRole("columnheader").first()).toHaveAttribute("aria-label", "Sunday");
  await page.keyboard.press("Escape");
  await page.getByLabel("Display currency").selectOption("EUR");
  await expect(page.locator("[data-fx]")).toContainText(/1 USD = [\d.]+ EUR/);
  const rate = Number(/1 USD = ([\d.]+) EUR/.exec(await page.locator("[data-fx]").innerText())![1]);
  expect(rate).toBeGreaterThan(0.5);
  const eur = (n: number) => (n * rate).toLocaleString("en-US", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await expect(page.locator("[data-sample-amount]")).toContainText(eur(1234.56));
  await shot(page, "account-date-region");
  await phone(page, "account-date-region");

  // The Overview's revenue card, the customers list and the revenue chart, all in EUR.
  await page.goto(`/projects/${pid}/overview`);
  const revenue = page.locator("[data-metric=revenue] .v");
  await expect(revenue).toHaveText(eur(200).replace(/\.00$/, ""));
  await page.goto(`/projects/${pid}/customers`);
  await expect(page.getByRole("row").filter({ hasText: buyer.slice(0, 5) }).first()).toContainText("€");
  const chartReq = page.waitForRequest((r) => r.url().includes("/charts/revenue?") && r.url().includes("resolution=week"));
  await page.goto(`/projects/${pid}/charts/revenue?res=week`);
  const url = new URL((await chartReq).url());
  expect(url.searchParams.get("currency")).toBe("EUR");
  expect(url.searchParams.get("week_start")).toBe("0");
  const body = await json(page.request, "GET", `/v2/projects/${pid}/charts/revenue${url.search}`);
  expect(body.yaxis_currency).toBe("EUR");
  expect(body.values.length).toBeGreaterThan(0);
  for (const v of body.values) expect(new Date(v.cohort * 1000).getUTCDay()).toBe(0);
  await page.getByRole("button", { name: "Custom" }).click();
  await page.locator(".ctools").getByRole("button", { name: "Choose start date" }).click();
  await expect(page.getByRole("grid")).toHaveAttribute("data-week-start", "0");
  await page.keyboard.press("Escape");
  await phone(page, "charts-eur");
  // Back to USD and Monday.
  await json(page.request, "POST", "/auth/me", { display_currency: "USD", week_start: 1 });
  expect(errors).toEqual([]);
});

test("Billing: owned projects with role and plan; Cloud billing only on Cloud", async ({ page }) => {
  const errors = watch(page);
  // Self-hosted: projects with "Self-hosted" plan, no Cloud billing.
  const email = `billing-acct-${stamp}@revenuedot.test`;
  await signup(page.request, email, "Bea Billing", "Own project");
  await page.goto("/account/billing");
  await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
  const own = page.locator("[data-account-project]");
  await expect(own).toHaveCount(1);
  await expect(own).toContainText("Own project");
  await expect(own).toContainText("Admin");
  await expect(own).toContainText("Self-hosted");
  await expect(page.getByText("Billing is only on RevenueDot Cloud. This server is self-hosted: free and unmetered, with no limits.")).toBeVisible();
  await phone(page, "account-billing-selfhost");
  // Cloud with billing set up: the same table plus the Cloud plan and usage.
  await page.goto(`${CLOUD}/login`);
  await signup(page.request, `cloud-${email}`, "Bea Cloud", "Cloud project", CLOUD);
  await page.goto(`${CLOUD}/account/billing`);
  await expect(page.locator("[data-account-project]")).toContainText("Cloud Free");
  await expect(page.locator("[data-plan=free]").getByText("Current")).toBeVisible();
  await expect(page.locator("[data-tracked]")).toHaveText("$0.00");
  await shot(page, "account-billing-cloud");
  await phone(page, "account-billing-cloud");
  expect(errors).toEqual([]);
});
