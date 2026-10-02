// RevenueDot Enterprise (ee/LICENSE). SAML single sign-on in the browser against the local test identity provider:
// domain verification, a connection from IdP metadata, SP-initiated sign-in with JIT and group roles, every rejected
// assertion (tampered, wrong key, unsigned, wrapped, expired, wrong audience, replayed), IdP-initiated sign-in off and
// on, and enforced SSO with the owner's break-glass. Spec: prd/enterprise/PRD.md §5, §7.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DOMAIN, IDP, PW, closeSql, createOrgUi, dark, loginUi, orgTab, person, phone, publishTxt, shot, signupUi, sql, watch } from "./fixtures";

test.describe.configure({ mode: "serial" });

const D = `saml-${DOMAIN}`;
const OWNER = `owner@${D}`;
let owner: { context: BrowserContext; page: Page };
let orgId = "", projectId = "", connId = "";

test.beforeAll(async ({ browser }) => { owner = await person(browser); });
test.afterAll(async () => { await owner.context.close(); await closeSql(); });

/** Signs in through the test identity provider from the RevenueDot sign-in page. */
async function ssoFromLogin(page: Page, email: string, o: { groups?: string; mode?: string } = {}) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL(`${IDP}/saml/sso**`);
  await answerIdp(page, email, o);
}
async function answerIdp(page: Page, email: string, o: { groups?: string; mode?: string } = {}) {
  await expect(page.getByRole("heading", { name: "Sign in to the test identity provider" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  if (o.groups) await page.getByLabel("Groups (comma separated)").fill(o.groups);
  if (o.mode) await page.locator(`input[name=mode][value=${o.mode}]`).check();
  await page.getByRole("button", { name: "Sign in" }).click();
}
const lastFailure = async () => (await sql()`select data->>'reason' as reason from ee_org_audit_logs where org_id = ${orgId} and action = 'sso_sign_in_failed' order by occurred_at desc limit 1`)[0]?.reason as string | undefined;

test("setup: an organization with a project and a group mapping", async () => {
  const { page } = owner;
  projectId = await signupUi(page, OWNER, "Scanner");
  orgId = await createOrgUi(page, "Saml Co");
  await page.getByRole("button", { name: "Move a project in" }).click();
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page.locator(".tbl")).toContainText("Scanner");
  await orgTab(page, orgId, "scim");
  await page.getByRole("button", { name: "Map a group" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Group name").fill("Engineers");
  await d.getByLabel("Role").selectOption("developer");
  await d.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.locator(".tbl")).toContainText("Engineers");
});

test("domain verification: a wrong or missing TXT record says so, the right one verifies", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "sso");
  await expect(page.getByText("No connection yet")).toBeVisible();
  await page.getByRole("button", { name: "Add domain" }).click();
  await page.getByRole("dialog").getByLabel("Domain", { exact: true }).fill("gmail.com");
  await page.getByRole("button", { name: "Add domain" }).last().click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/public/i);
  await page.getByRole("dialog").getByLabel("Domain", { exact: true }).fill(D);
  await page.getByRole("button", { name: "Add domain" }).last().click();
  const card = page.locator(".card", { hasText: D });
  await expect(card.getByText("Pending")).toBeVisible();
  const txtName = await card.locator(".copyfield code").nth(0).textContent();
  const txtValue = await card.locator(".copyfield code").nth(1).textContent();
  expect(txtName).toBe(`_revenuedot-sso.${D}`);
  await card.getByRole("button", { name: "Check DNS" }).click();
  await expect(card.locator(".status")).toContainText("was not found");
  await publishTxt(page, txtName!, "something-else");
  await card.getByRole("button", { name: "Check DNS" }).click();
  await expect(card.locator(".status")).toContainText('it is "something-else"');
  await publishTxt(page, txtName!, txtValue!);
  await card.getByRole("button", { name: "Check DNS" }).click();
  await expect(card.getByText("Verified", { exact: true })).toBeVisible();
  const [row] = await sql()`select org_id, verified_at from ee_sso_domains where domain = ${D}`;
  expect(row!.org_id).toBe(orgId);
  expect(row!.verified_at).not.toBeNull();
  w.expectClean();
});

test("a SAML connection is created from the identity provider's metadata and turned on", async () => {
  const { page } = owner;
  const w = watch(page);
  const metadata = await (await page.request.get(`${IDP}/saml/metadata`)).text();
  await page.getByRole("button", { name: "New connection" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("Test IdP");
  await d.getByLabel("Identity provider metadata (XML)").fill("<not xml");
  await d.getByRole("button", { name: "Create connection" }).click();
  await expect(d.getByRole("alert")).toContainText("metadata");
  await d.getByLabel("Identity provider metadata (XML)").fill(metadata);
  await d.getByLabel("Groups attribute").fill("groups");
  await d.getByRole("button", { name: "Create connection" }).click();
  await expect(page.getByRole("dialog", { name: /Set up Test IdP/ })).toBeVisible();
  const acs = await page.getByRole("dialog").locator(".copyfield code").first().textContent();
  expect(acs).toMatch(/\/sso\/saml\/ssoc_[a-z0-9]+\/acs$/);
  connId = /\/sso\/saml\/(ssoc_[a-z0-9]+)\/acs/.exec(acs!)![1]!;
  await shot(page, "sso-sp-values");
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.locator("tr", { hasText: "Test IdP" });
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  // Off: signing in says so.
  const anon = await page.context().browser()!.newContext();
  const p = await anon.newPage();
  await p.goto(`/sso/connections/${connId}/start`);
  await expect(p.getByRole("alert")).toContainText("turned off");
  await anon.close();
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await shot(page, "sso-tab");
  await phone(page, "sso-tab");
  await dark(page, "sso-tab");
  w.expectClean();
});

test("SP-initiated sign-in creates the account just in time and applies the group's role", async ({ browser }) => {
  const alice = await person(browser);
  const w = watch(alice.page);
  await ssoFromLogin(alice.page, `alice@${D}`, { groups: "Engineers, Everyone" });
  await alice.page.waitForURL(new RegExp(`/projects/${projectId}/overview`));
  const me = await (await alice.page.request.get("/auth/me")).json();
  expect(me.user.email).toBe(`alice@${D}`);
  expect(me.projects).toEqual([expect.objectContaining({ id: projectId, role: "developer" })]);
  const [u] = await sql()`select u.password_hash, u.email_verified_at, m.source, m.sso_groups, s.source as granted from users u join ee_org_members m on m.user_id = u.id and m.org_id = ${orgId} join ee_membership_sources s on s.user_id = u.id and s.project_id = ${projectId} where u.email = ${`alice@${D}`}`;
  expect(u).toMatchObject({ password_hash: null, source: "sso", sso_groups: ["Engineers", "Everyone"], granted: "idp" });
  expect(u!.email_verified_at).not.toBeNull();
  expect((await sql()`select count(*)::int as n from ee_sso_sessions where org_id = ${orgId}`)[0]!.n).toBe(1);
  // A deep link survives the round trip.
  await alice.page.request.post("/auth/logout");
  await alice.page.goto(`/projects/${projectId}/product-catalog/products`);
  await alice.page.waitForURL(/\/login\?next=/);
  await alice.page.getByLabel("Email", { exact: true }).fill(`alice@${D}`);
  await alice.page.getByRole("button", { name: "Continue with SSO" }).click();
  await answerIdp(alice.page, `alice@${D}`, { groups: "Engineers" });
  await alice.page.waitForURL(new RegExp(`/projects/${projectId}/product-catalog/products`));
  w.expectClean();
  await alice.context.close();
});

for (const [mode, label] of [["tamper", "email changed after signing"], ["attacker", "signed with an unknown key"], ["unsigned", "unsigned"], ["wrap", "signature wrapping"], ["expired", "expired"], ["audience", "wrong audience"]] as const) {
  test(`a ${label} assertion is refused with a clear message and no session`, async ({ browser }) => {
    const x = await person(browser);
    await ssoFromLogin(x.page, `eve@${D}`, { mode });
    await x.page.waitForURL(/\/login\?sso_error=/);
    await expect(x.page.getByRole("alert")).toHaveText("Single sign-on failed. Try again, or ask your administrator to check the connection.");
    if (mode === "tamper") await shot(x.page, "sso-refused");
    expect((await x.page.request.get("/auth/me")).status()).toBe(401);
    expect(await lastFailure()).toBeTruthy();
    expect((await sql()`select count(*)::int as n from users where email = ${`eve@${D}`} or email = ${`mallory@${D}`}`)[0]!.n).toBe(0);
    await x.context.close();
  });
}

test("IdP-initiated sign-in is refused until the connection allows it; then a replayed assertion is refused", async ({ browser }) => {
  const acs = `${new URL(owner.page.url()).origin}/sso/saml/${connId}/acs`;
  const x = await person(browser);
  await x.page.goto(`${IDP}/saml/idp-initiated?acs=${encodeURIComponent(acs)}`);
  await answerIdp(x.page, `bob@${D}`);
  await x.page.waitForURL(/\/login\?sso_error=/);
  expect(await lastFailure()).toContain("IdP-initiated");
  // Allow it in the connection's settings.
  const { page } = owner;
  await orgTab(page, orgId, "sso");
  await page.getByRole("button", { name: "Actions for Test IdP" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("dialog").getByText("Allow sign-in started from the identity provider").click();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("tr", { hasText: "Test IdP" })).toContainText("IdP-initiated");
  await x.page.goto(`${IDP}/saml/idp-initiated?acs=${encodeURIComponent(acs)}&next=/organizations`);
  await answerIdp(x.page, `bob@${D}`);
  await x.page.waitForURL(/\/organizations/);
  expect((await (await x.page.request.get("/auth/me")).json()).user.email).toBe(`bob@${D}`);
  // The same assertion again is a replay.
  const y = await person(browser);
  await y.page.goto(`${IDP}/saml/idp-initiated?acs=${encodeURIComponent(acs)}`);
  await answerIdp(y.page, `bob@${D}`, { mode: "replay" });
  await y.page.waitForURL(/\/login\?sso_error=/);
  expect(await lastFailure()).toContain("replay");
  await x.context.close(); await y.context.close();
});

test("an account someone registered in advance with a work address loses its password when the real person signs in with SSO", async ({ browser }) => {
  // Before SSO, someone signs up with the CEO's address and never confirms it.
  const squatter = await person(browser);
  await signupUi(squatter.page, `ceo@${D}`, "Squat");
  const ceo = await person(browser);
  const w = watch(ceo.page);
  await ssoFromLogin(ceo.page, `ceo@${D}`);
  await ceo.page.waitForURL(/\/projects\//);
  expect((await (await ceo.page.request.get("/auth/me")).json()).user.email).toBe(`ceo@${D}`);
  // The squatter's session is gone and the password no longer signs in.
  await squatter.page.goto("/account");
  await squatter.page.waitForURL(/\/login/);
  await loginUi(squatter.page, `ceo@${D}`);
  await expect(squatter.page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  expect((await sql()`select password_hash from users where email = ${`ceo@${D}`}`)[0]!.password_hash).toBeNull();
  w.expectClean();
  for (const x of [squatter, ceo]) await x.context.close();
});

test("enforced SSO: password sign-in is refused with a way to SSO, password sessions lose access, the owner keeps a password", async ({ browser }) => {
  // carol signs up with a password before enforcement and opens the project through an invite-free membership (group).
  const carol = await person(browser);
  await signupUi(carol.page, `carol@${D}`, "Carol's");
  await sql()`insert into memberships (user_id, project_id, role) select id, ${projectId}, 'viewer' from users where email = ${`carol@${D}`}`;
  expect((await carol.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(200);
  // Carol is also an organization admin, with that same password session.
  await sql()`update ee_org_members set role = 'admin' where org_id = ${orgId} and user_id = (select id from users where email = ${`carol@${D}`})`;
  await orgTab(carol.page, orgId, "members");
  await expect(carol.page.getByRole("button", { name: "Add member" })).toBeVisible();
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "sso");
  await page.locator(".panel", { hasText: "Require single sign-on" }).getByRole("switch").click();
  await expect(page.getByRole("dialog")).toContainText(D);
  await page.getByRole("button", { name: "Require single sign-on" }).click();
  await expect(page.locator(".toast")).toHaveText("Single sign-on is now required.");
  expect((await sql()`select sso_enforced from ee_organizations where id = ${orgId}`)[0]!.sso_enforced).toBe(true);
  // carol's existing password session no longer opens the organization's project.
  const denied = await carol.page.request.get(`/v2/projects/${projectId}/products`);
  expect(denied.status()).toBe(403);
  expect((await denied.json()).message).toContain("requires single sign-on");
  // Nor Organization settings: the old session cannot turn the requirement off.
  await carol.page.goto(`/organizations/${orgId}/sso`);
  await expect(carol.page.getByRole("alert")).toContainText("requires single sign-on");
  await shot(carol.page, "sso-required-org-settings");
  expect((await carol.page.request.post(`/v2/organizations/${orgId}`, { data: { sso_enforced: false } })).status()).toBe(403);
  expect((await sql()`select sso_enforced from ee_organizations where id = ${orgId}`)[0]!.sso_enforced).toBe(true);
  // Her password no longer signs her in; the page offers SSO and it works.
  const c2 = await person(browser);
  await loginUi(c2.page, `carol@${D}`);
  await expect(c2.page.getByRole("alert")).toContainText("requires single sign-on");
  await shot(c2.page, "sso-required-login");
  await c2.page.getByRole("button", { name: "Continue with SSO" }).click();
  await answerIdp(c2.page, `carol@${D}`);
  await c2.page.waitForURL(/\/projects\//);
  expect((await c2.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(200);
  // Password reset is refused too (same answer, no email sent).
  const reset = await c2.page.request.post("/auth/password/forgot", { data: { email: `carol@${D}` } });
  expect(reset.status()).toBe(200);
  // The owner (break-glass) still signs in with a password and keeps access.
  const o2 = await person(browser);
  await loginUi(o2.page, OWNER);
  await o2.page.waitForURL(/\/projects\//);
  expect((await o2.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(200);
  // The only enabled connection cannot be turned off while SSO is required.
  const off = page.waitForResponse((r) => r.url().includes(`/sso/connections/${connId}`) && r.request().method() === "POST");
  await page.locator("tr", { hasText: "Test IdP" }).getByRole("switch").click();
  expect((await off).status()).toBe(422);
  await expect(page.locator("tr", { hasText: "Test IdP" }).getByRole("switch")).toHaveAttribute("aria-checked", "true");
  expect((await sql()`select enabled from ee_sso_connections where id = ${connId}`)[0]!.enabled).toBe(true);
  w.expectClean();
  for (const x of [carol, c2, o2]) await x.context.close();
  void PW;
});

test("the organization log shows sign-ins and refusals", async () => {
  const { page } = owner;
  await orgTab(page, orgId, "audit-log");
  await expect(page.locator(".tbl")).toContainText("SSO sign-in");
  await expect(page.locator(".tbl")).toContainText("SSO sign-in failed");
  await phone(page, "org-audit-sso");
});
