// RevenueDot Enterprise (ee/LICENSE). OpenID Connect single sign-on in the browser against the local test identity
// provider: a connection with a client secret, sign-in with JIT and a groups claim, and refused tokens (email not
// verified, wrong nonce), plus the sign-in link from another browser. Spec: prd/enterprise/PRD.md §5.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DOMAIN, IDP, closeSql, createOrgUi, orgTab, person, publishTxt, shot, signupUi, sql, watch } from "./fixtures";

test.describe.configure({ mode: "serial" });

const D = `oidc-${DOMAIN}`;
let owner: { context: BrowserContext; page: Page };
let orgId = "", projectId = "", connId = "";

test.beforeAll(async ({ browser }) => { owner = await person(browser); });
test.afterAll(async () => { await owner.context.close(); await closeSql(); });

async function answer(page: Page, email: string, o: { groups?: string; mode?: string } = {}) {
  await page.waitForURL(`${IDP}/oidc/authorize**`);
  await expect(page).toHaveURL(/code_challenge_method=S256/);
  await page.getByLabel("Email", { exact: true }).fill(email);
  if (o.groups) await page.getByLabel("Groups (comma separated)").fill(o.groups);
  if (o.mode) await page.locator(`input[name=mode][value=${o.mode}]`).check();
  await page.getByRole("button", { name: "Sign in" }).click();
}
const lastFailure = async () => (await sql()`select data->>'reason' as reason from ee_org_audit_logs where org_id = ${orgId} and action = 'sso_sign_in_failed' order by occurred_at desc limit 1`)[0]?.reason as string | undefined;

test("an OpenID Connect connection is set up with a client secret that is never shown again", async () => {
  const { page } = owner;
  const w = watch(page);
  projectId = await signupUi(page, `owner@${D}`, "Oidc app");
  orgId = await createOrgUi(page, "Oidc Co");
  await page.getByRole("button", { name: "Move a project in" }).click();
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page.locator(".tbl")).toContainText("Oidc app");
  await orgTab(page, orgId, "scim");
  await page.getByRole("button", { name: "Map a group" }).click();
  await page.getByRole("dialog").getByLabel("Group name").fill("rd-admins");
  await page.getByRole("dialog").getByLabel("Role").selectOption("admin");
  await page.getByRole("dialog").getByRole("button", { name: "Save mapping" }).click();
  await expect(page.locator(".tbl")).toContainText("rd-admins");
  await orgTab(page, orgId, "sso");
  await page.getByRole("button", { name: "Add domain" }).click();
  await page.getByRole("dialog").getByLabel("Domain", { exact: true }).fill(D);
  await page.getByRole("dialog").getByRole("button", { name: "Add domain" }).click();
  const card = page.locator(".card", { hasText: D });
  await publishTxt(page, (await card.locator(".copyfield code").nth(0).textContent())!, (await card.locator(".copyfield code").nth(1).textContent())!);
  await card.getByRole("button", { name: "Check DNS" }).click();
  await expect(card.getByText("Verified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New connection" }).click();
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: "OpenID Connect" }).click();
  await d.getByLabel("Name").fill("Test OIDC");
  await d.getByLabel("Issuer URL").fill(`${IDP}/oidc`);
  await d.getByLabel("Client ID").fill("revenuedot-test");
  await d.getByLabel("Client secret").fill("s3cret-value");
  await d.getByLabel("Groups claim").fill("groups");
  await d.getByRole("button", { name: "Create connection" }).click();
  const redirect = await page.getByRole("dialog").locator(".copyfield code").first().textContent();
  expect(redirect).toMatch(/\/sso\/oidc\/ssoc_[a-z0-9]+\/callback$/);
  connId = /\/sso\/oidc\/(ssoc_[a-z0-9]+)\//.exec(redirect!)![1]!;
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator("tr", { hasText: "Test OIDC" }).getByRole("switch").click();
  await expect(page.locator(".toast")).toHaveText("Test OIDC is on.");
  // The secret is stored sealed and never returned.
  const conn = await (await page.request.get(`/v2/organizations/${orgId}/sso/connections/${connId}`)).json();
  expect(conn.oidc).toMatchObject({ issuer: `${IDP}/oidc`, client_id: "revenuedot-test", has_client_secret: true });
  expect(JSON.stringify(conn)).not.toContain("s3cret-value");
  const [row] = await sql()`select secret from ee_sso_connections where id = ${connId}`;
  expect(row!.secret).toMatch(/^v1:/);
  w.expectClean();
});

test("sign-in creates the account, maps the groups claim to a role and keeps the deep link", async ({ browser }) => {
  const x = await person(browser);
  const w = watch(x.page);
  await x.page.goto(`/projects/${projectId}/product-catalog/entitlements`);
  await x.page.waitForURL(/\/login\?next=/);
  await x.page.getByLabel("Email", { exact: true }).fill(`olivia@${D}`);
  await x.page.getByRole("button", { name: "Continue with SSO" }).click();
  await answer(x.page, `olivia@${D}`, { groups: "rd-admins" });
  await x.page.waitForURL(new RegExp(`/projects/${projectId}/product-catalog/entitlements`));
  await expect(x.page.locator(".page h1")).toHaveText("Entitlements");
  const me = await (await x.page.request.get("/auth/me")).json();
  expect(me.projects).toEqual([expect.objectContaining({ id: projectId, role: "admin" })]);
  await shot(x.page, "oidc-signed-in");
  w.expectClean();
  await x.context.close();
});

test("an unverified email or a wrong nonce is refused", async ({ browser }) => {
  for (const mode of ["unverified", "nonce"]) {
    const x = await person(browser);
    await x.page.goto(`/sso/connections/${connId}/start`);
    await answer(x.page, `pat@${D}`, { mode });
    await x.page.waitForURL(/\/login\?sso_error=/);
    await expect(x.page.getByRole("alert")).toContainText("Single sign-on failed");
    expect(await lastFailure()).toMatch(mode === "nonce" ? /nonce/ : /email_verified|verified/);
    expect((await x.page.request.get("/auth/me")).status()).toBe(401);
    await x.context.close();
  }
});

test("a callback opened in another browser is refused (login CSRF)", async ({ browser }) => {
  const attacker = await person(browser);
  await attacker.page.goto(`/sso/connections/${connId}/start`);
  await attacker.page.waitForURL(`${IDP}/oidc/authorize**`);
  await attacker.page.getByLabel("Email", { exact: true }).fill(`mallory@${D}`);
  // Capture the callback URL instead of following it, then open it in the victim's browser.
  await attacker.page.route(`**/sso/oidc/${connId}/callback**`, (route) => route.abort());
  const [request] = await Promise.all([
    attacker.page.waitForRequest((r) => r.url().includes(`/sso/oidc/${connId}/callback`)),
    attacker.page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  const victim = await person(browser);
  await victim.page.goto(request.url());
  await victim.page.waitForURL(/\/login\?sso_error=/);
  await expect(victim.page.getByRole("alert")).toContainText("started in another browser");
  expect((await victim.page.request.get("/auth/me")).status()).toBe(401);
  await attacker.context.close(); await victim.context.close();
});
