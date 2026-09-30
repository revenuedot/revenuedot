/**
 * Account email end to end (prd/account-email/PRD.md): forgot and reset password, invite and accept (a new person and
 * an existing account), member management (roles, resend, revoke, remove, leave) and alert email settings, driven
 * through the dashboard. Emails come from the e2e server's in-memory mailer (GET /__mail?to=...); the server side,
 * token rules and rate limits are covered by apps/server/test/account-email.test.ts and invites.test.ts.
 * Every page is also checked at 390px wide. SHOTS=<dir> saves screenshots.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "default" });

const stamp = Date.now();
const PW = `e2e-${stamp}-pw`;

function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
}

/** Checks the page has no sideways scroll at phone width, screenshots it, and restores the desktop size. */
async function phone(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

/** The newest email to `to` with a link containing `path`, as a path on this site. */
async function linkFor(page: Page, to: string, path: string): Promise<string> {
  let found: string | null = null;
  await expect.poll(async () => {
    const mails = await (await page.request.get(`/__mail?to=${encodeURIComponent(to)}`)).json() as { text: string; subject: string }[];
    for (const m of [...mails].reverse()) {
      const u = new RegExp(`https?://[^\\s]+${path.replace(/[?]/g, "\\?")}[^\\s]+`).exec(m.text);
      if (u) { found = new URL(u[0]).pathname + new URL(u[0]).search; return true; }
    }
    return false;
  }, { timeout: 10_000 }).toBe(true);
  return found!;
}
const mailCount = async (page: Page, to: string) => ((await (await page.request.get(`/__mail?to=${encodeURIComponent(to)}`)).json()) as unknown[]).length;

async function signupUi(page: Page, email: string, name: string, project: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByLabel("First project").fill(project);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  return /\/projects\/([^/]+)\//.exec(page.url())![1]!;
}

const newPage = async (browser: Browser) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); return ctx.newPage(); };

test("forgot password: request a link, set a new password, get signed in; the link works once", async ({ page }) => {
  const errors = watch(page);
  const email = `reset-${stamp}@revenuedot.test`;
  await signupUi(page, email, "Reset e2e", "Reset project");
  await page.request.post("/auth/logout");
  await page.context().clearCookies();

  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(email); // carried over from the sign-in form
  await shot(page, "forgot");
  await phone(page, "forgot");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await phone(page, "forgot-sent");

  // The same answer for an address without an account, and no email for it.
  await page.getByRole("button", { name: "Use a different email" }).click();
  await page.getByLabel("Email").fill(`nobody-${stamp}@revenuedot.test`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(await mailCount(page, `nobody-${stamp}@revenuedot.test`)).toBe(0);

  const link = await linkFor(page, email, "/reset-password?token=");
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await phone(page, "reset");
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Repeat the new password").fill("short");
  await page.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Use at least 8 characters for your password.");
  await page.getByLabel("New password", { exact: true }).fill(`${PW}-new`);
  await page.getByLabel("Repeat the new password").fill(`${PW}-new`);
  await shot(page, "reset");
  await page.getByRole("button", { name: "Set password and sign in" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);

  expect((await page.request.post("/auth/login", { data: { email, password: PW } })).status()).toBe(401);
  expect((await page.request.post("/auth/login", { data: { email, password: `${PW}-new` } })).status()).toBe(200);
  // Used links say so.
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await expect(page.getByText("This link was already used.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Send a new link" })).toBeVisible();
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test("invites and members: invite, accept as a new and an existing user, roles, resend, revoke, remove, leave", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = watch(page);
  const owner = `owner-${stamp}@revenuedot.test`;
  const newbie = `newbie-${stamp}@revenuedot.test`;
  const existing = `existing-${stamp}@revenuedot.test`;
  const pending = `pending-${stamp}@revenuedot.test`;
  const pid = await signupUi(page, owner, "Olive Owner", "Team project");
  const toast = (t: string | RegExp) => expect(page.getByRole("status").filter({ hasText: t }).first()).toBeVisible();

  await page.goto(`/projects/${pid}/settings/collaborators`);
  await expect(page.getByRole("row", { name: new RegExp(owner) })).toBeVisible();
  const invite = async (email: string, role: string) => {
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Invite to this project" });
    await d.getByLabel("Email").fill(email);
    await d.getByLabel("Role").selectOption({ label: role });
    await shot(page, `invite-${role.toLowerCase()}`);
    await d.getByRole("button", { name: "Send invite" }).click();
    await toast(`Invite sent to ${email}.`);
  };
  // A bad address stays in the dialog.
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Email").fill("not an email");
  await page.getByRole("dialog").getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Enter a valid email address.");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await invite(newbie, "Viewer");
  await invite(existing, "Developer");
  await invite(pending, "Admin");
  const invites = page.getByRole("region").or(page.locator("section.panel")).filter({ hasText: "Pending invites" });
  await expect(invites.getByRole("row", { name: new RegExp(newbie) })).toContainText("Viewer");
  await expect(invites.getByRole("row", { name: new RegExp(pending) })).toContainText("Pending");
  await shot(page, "members-pending");
  await phone(page, "members-pending");

  // 1. A new person creates an account from the link.
  const guest = await newPage(browser);
  const guestErrors = watch(guest);
  await guest.goto(await linkFor(page, newbie, "/invite?token="));
  await expect(guest.getByRole("heading", { name: "Join Team project" })).toBeVisible();
  await expect(guest.getByText(`Olive Owner invited ${newbie} to Team project as Viewer.`)).toBeVisible();
  await expect(guest.getByLabel("Email")).toHaveValue(newbie);
  await phone(guest, "invite-new");
  await guest.getByLabel("Your name").fill("Nia Newbie");
  await guest.getByLabel("Password").fill(PW);
  await shot(guest, "invite-new");
  await guest.getByRole("button", { name: "Create account and join" }).click();
  await guest.waitForURL(new RegExp(`/projects/${pid}/overview`));
  await guest.goto(`/projects/${pid}/settings/collaborators`);
  await expect(guest.getByRole("button", { name: "Invite", exact: true })).toBeDisabled(); // viewers cannot invite
  await expect(guest.getByText("Only admins can invite people and change roles.")).toBeVisible();

  // 2. An existing account signs in from the invite page and accepts.
  const other = await newPage(browser);
  await signupUi(other, existing, "Eli Existing", "Eli's project");
  await other.request.post("/auth/logout");
  await other.context().clearCookies();
  await other.goto(await linkFor(page, existing, "/invite?token="));
  await expect(other.getByText("You already have a RevenueDot account.")).toBeVisible();
  await other.getByRole("link", { name: "Sign in to accept" }).click();
  await other.getByLabel("Work email").fill(existing);
  await other.getByLabel("Password").fill(PW);
  await other.getByRole("button", { name: "Sign in" }).click();
  await expect(other.getByRole("heading", { name: "Join Team project" })).toBeVisible();
  await shot(other, "invite-existing");
  await other.getByRole("button", { name: "Accept invite" }).click();
  await other.waitForURL(new RegExp(`/projects/${pid}/overview`));

  // 3. The owner sees both, changes a role, resends and revokes the pending invite, removes a member.
  await page.reload();
  const members = page.locator("section.panel").filter({ hasText: "Members" });
  await expect(members.getByRole("row", { name: new RegExp(newbie) })).toBeVisible();
  await expect(members.getByLabel(`Role of ${existing}`)).toHaveValue("developer");
  await members.getByLabel(`Role of ${newbie}`).selectOption("developer");
  await toast("Nia Newbie is now a developer.");
  const collab = (await (await page.request.get(`/v2/projects/${pid}/collaborators`)).json()).items as { email: string; role: string }[];
  expect(collab.find((c) => c.email === newbie)?.role).toBe("developer");
  // The last admin cannot step down.
  await members.getByLabel(`Role of ${owner}`).selectOption("viewer");
  await toast("A project needs at least one admin. Make someone else an admin first.");
  await expect(members.getByLabel(`Role of ${owner}`)).toHaveValue("admin");

  const before = await mailCount(page, pending);
  await page.getByRole("button", { name: `Actions for the invite to ${pending}` }).click();
  await page.getByRole("menuitem", { name: "Resend invite" }).click();
  await toast(`Invite sent again to ${pending}.`);
  expect(await mailCount(page, pending)).toBe(before + 1);
  const revokedLink = await linkFor(page, pending, "/invite?token=");
  await page.getByRole("button", { name: `Actions for the invite to ${pending}` }).click();
  await page.getByRole("menuitem", { name: "Revoke invite" }).click();
  await page.getByRole("dialog", { name: `Revoke the invite for ${pending}?` }).getByRole("button", { name: "Revoke invite" }).click();
  await toast(`Invite for ${pending} revoked.`);
  await expect(page.getByText("Pending invites")).toHaveCount(0);
  const g2 = await newPage(browser);
  await g2.goto(revokedLink);
  await expect(g2.getByRole("heading", { name: "This invite does not work" })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${existing}` }).click();
  await page.getByRole("menuitem", { name: "Remove from project" }).click();
  await page.getByRole("dialog", { name: "Remove Eli Existing?" }).getByRole("button", { name: "Remove" }).click();
  await toast(`${existing} was removed.`);
  await expect(members.getByRole("row", { name: new RegExp(existing) })).toHaveCount(0);
  expect((await other.request.get(`/v2/projects/${pid}`)).status()).toBe(404);
  await shot(page, "members");
  await phone(page, "members");

  // 4. A member leaves.
  await guest.reload();
  await guest.getByRole("button", { name: `Actions for ${newbie}` }).click();
  await guest.getByRole("menuitem", { name: "Leave project" }).click();
  await guest.getByRole("dialog", { name: "Leave this project?" }).getByRole("button", { name: "Leave project" }).click();
  await guest.waitForURL((u) => !u.pathname.includes(pid));
  expect((await guest.request.get(`/v2/projects/${pid}`)).status()).toBe(404);

  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  expect(guestErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test("account settings: turn alert emails off and on, change the name", async ({ page }) => {
  const errors = watch(page);
  const email = `alerts-${stamp}@revenuedot.test`;
  await signupUi(page, email, "Al Alerts", "Alert project");
  await page.getByRole("button", { name: /Alert project/ }).first().click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  await page.waitForURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Account settings" })).toBeVisible();
  const sw = page.getByRole("switch", { name: "Email me about problems with my projects" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(page.getByRole("status").filter({ hasText: "Alert emails are off." })).toBeVisible();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  expect((await (await page.request.get("/auth/me")).json()).user.alert_emails).toBe(false);
  await page.getByLabel("Your name").fill("Alex Alerts");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Name saved." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Email me about problems with my projects" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Your name")).toHaveValue("Alex Alerts");
  await shot(page, "account");
  await phone(page, "account");
  await page.getByRole("switch", { name: "Email me about problems with my projects" }).click();
  await expect.poll(async () => (await (await page.request.get("/auth/me")).json()).user.alert_emails).toBe(true);
  expect(errors).toEqual([]);
});

test("Cloud: the unverified-email banner sends a new link, and the link confirms the address", async ({ page }) => {
  const errors = watch(page);
  const email = `verify-${stamp}@revenuedot.test`;
  const pid = await signupUi(page, email, "Vera Verify", "Verify project");
  // The e2e server is self-hosted, so /auth/me is answered as the Cloud edition would for an unverified account.
  await page.route("**/auth/me", async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    if (r.request().method() === "GET") body.account = { ...body.account, edition: "cloud", email_verification_required: true };
    await r.fulfill({ response: res, json: body });
  });
  await page.goto(`/projects/${pid}/overview`);
  const banner = page.locator(".verify-banner");
  await expect(banner).toContainText(`We sent a link to ${email}`);
  await phone(page, "verify-banner");
  await banner.getByRole("button", { name: "Send a new link" }).click();
  await expect(banner).toContainText("Sent. Check your inbox.");
  await page.unroute("**/auth/me");
  await page.goto(await linkFor(page, email, "/verify-email?token="));
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
  await phone(page, "verify-done");
  expect((await (await page.request.get("/auth/me")).json()).user.email_verified).toBe(true);
  expect(errors).toEqual([]);
});
