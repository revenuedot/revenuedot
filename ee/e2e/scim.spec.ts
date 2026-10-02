// RevenueDot Enterprise (ee/LICENSE). SCIM provisioning seen from the browser: an admin creates a token and a group
// mapping in the dashboard; the identity provider (this test, over SCIM 2.0) creates a user and a group; the person
// signs in with SSO and sees the project; deactivating them ends their session and access at once; reactivation
// restores it; a revoked token stops working. Spec: prd/enterprise/PRD.md §6, §7.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { DOMAIN, IDP, closeSql, createOrgUi, orgTab, person, phone, dark, publishTxt, shot, signupUi, sql, watch } from "./fixtures";

test.describe.configure({ mode: "serial" });

const D = `scim-${DOMAIN}`;
const SAM = `sam@${D}`;
let owner: { context: BrowserContext; page: Page };
let orgId = "", projectId = "", token = "", baseUrl = "", samId = "";
let scim: APIRequestContext;

test.beforeAll(async ({ browser, playwright }) => {
  owner = await person(browser);
  scim = await playwright.request.newContext();
});
test.afterAll(async () => { await owner.context.close(); await scim.dispose(); await closeSql(); });

const call = (method: string, path: string, data?: unknown) =>
  scim.fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, data: data === undefined ? undefined : JSON.stringify(data) });

async function ssoSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL(`${IDP}/saml/sso**`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("setup: organization, project, verified domain and an SSO connection", async () => {
  const { page } = owner;
  projectId = await signupUi(page, `owner@${D}`, "Scim app");
  orgId = await createOrgUi(page, "Scim Co");
  await page.getByRole("button", { name: "Move a project in" }).click();
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page.locator(".tbl")).toContainText("Scim app");
  const add = await (await page.request.post(`/v2/organizations/${orgId}/sso/domains`, { data: { domain: D } })).json();
  await publishTxt(page, add.txt_record.name, add.txt_record.value);
  expect((await (await page.request.post(`/v2/organizations/${orgId}/sso/domains/${D}/actions/verify`)).json()).verified).toBe(true);
  const metadata = await (await page.request.get(`${IDP}/saml/metadata`)).text();
  const conn = await page.request.post(`/v2/organizations/${orgId}/sso/connections`, { data: { kind: "saml", name: "Test IdP", enabled: true, jit: false, saml: { metadata_xml: metadata } } });
  expect(conn.status()).toBe(201);
});

test("an admin creates a SCIM token (shown once) and maps a group to a role", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "scim");
  await expect(page.getByText("No mappings yet")).toBeVisible();
  await page.getByRole("button", { name: "New token" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Okta");
  await page.getByRole("dialog").getByRole("button", { name: "Create token" }).click();
  const fields = page.getByRole("dialog").locator(".copyfield code");
  baseUrl = (await fields.nth(0).textContent())!;
  token = (await fields.nth(1).textContent())!;
  expect(baseUrl).toMatch(/\/scim\/v2$/);
  expect(token).toMatch(/^rdscim_[0-9a-f]{64}$/);
  await shot(page, "scim-token-once");
  await page.getByRole("button", { name: "I copied it" }).click();
  await expect(page.locator(".tbl").first()).toContainText("Okta");
  const [t] = await sql()`select token_hash, prefix from ee_scim_tokens where org_id = ${orgId}`;
  expect(t!.token_hash).not.toContain(token.slice(7));
  await page.getByRole("button", { name: "Map a group" }).click();
  await page.getByRole("dialog").getByLabel("Group name").fill("Support");
  await page.getByRole("dialog").getByLabel("Role").selectOption("viewer");
  await page.getByRole("dialog").getByRole("button", { name: "Save mapping" }).click();
  await expect(page.locator(".tbl").last()).toContainText("Support");
  await phone(page, "scim-tab");
  await dark(page, "scim-tab");
  w.expectClean();
});

test("the identity provider provisions a user into a group; the member list and project roles show it", async () => {
  const created = await call("POST", "/Users", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: SAM, externalId: "okta-sam", name: { givenName: "Sam", familyName: "Support" }, emails: [{ value: SAM, primary: true, type: "work" }], active: true });
  expect(created.status()).toBe(201);
  samId = (await created.json()).id;
  expect((await call("POST", "/Users", { userName: SAM.toUpperCase() })).status()).toBe(409);
  expect((await call("POST", "/Users", { userName: "someone@gmail.com" })).status()).toBe(400);
  const group = await call("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Support", members: [{ value: samId }] });
  expect(group.status()).toBe(201);
  const found = await (await call("GET", `/Users?filter=${encodeURIComponent(`userName eq "${SAM}"`)}`)).json();
  expect(found.totalResults).toBe(1);
  const { page } = owner;
  await orgTab(page, orgId, "members");
  await expect(page.locator("tr", { hasText: SAM })).toContainText("SCIM");
  await orgTab(page, orgId, "projects");
  await page.getByRole("button", { name: "Actions for Scim app" }).click();
  await page.getByRole("menuitem", { name: "Members and roles" }).click();
  const row = page.getByRole("dialog").locator("tr", { hasText: SAM });
  await expect(row).toContainText("Identity provider");
  await expect(row.getByRole("combobox")).toHaveValue("viewer");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
});

test("the provisioned person signs in with SSO; deactivation ends the session and access at once; reactivation restores it", async ({ browser }) => {
  const samB = await person(browser);
  const w = watch(samB.page);
  await ssoSignIn(samB.page, SAM);
  await samB.page.waitForURL(new RegExp(`/projects/${projectId}/overview`));
  expect((await samB.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(200);
  // Okta deactivates: PATCH replace with no path.
  const off = await call("PATCH", `/Users/${samId}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] });
  expect(off.status()).toBe(200);
  expect((await off.json()).active).toBe(false);
  expect((await samB.page.request.get("/auth/me")).status()).toBe(401);
  await samB.page.reload();
  await samB.page.waitForURL(/\/login/);
  expect((await sql()`select count(*)::int as n from memberships m join users u on u.id = m.user_id where u.email = ${SAM}`)[0]!.n).toBe(0);
  // Signing in again is refused while deactivated.
  await ssoSignIn(samB.page, SAM);
  await samB.page.waitForURL(/\/login\?sso_error=/);
  await expect(samB.page.getByRole("alert")).toContainText("access to this organization was removed");
  await orgTab(owner.page, orgId, "members");
  await expect(owner.page.locator("tr", { hasText: SAM })).toContainText("Deactivated");
  // Entra reactivates: capitalised op and a string value.
  const on = await call("PATCH", `/Users/${samId}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "True" }] });
  expect(on.status()).toBe(200);
  await ssoSignIn(samB.page, SAM);
  await samB.page.waitForURL(new RegExp(`/projects/${projectId}/overview`));
  // Leaving the group removes the role it gave.
  const leave = await call("PATCH", `/Groups/${(await (await call("GET", `/Groups?filter=${encodeURIComponent('displayName eq "Support"')}`)).json()).Resources[0].id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: `members[value eq "${samId}"]` }] });
  expect(leave.status()).toBe(200);
  expect((await samB.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(404);
  // DELETE ends everything and returns 204.
  expect((await call("DELETE", `/Users/${samId}`)).status()).toBe(204);
  expect((await samB.page.request.get("/auth/me")).status()).toBe(401);
  w.expectClean();
  await samB.context.close();
});

test("a revoked token stops working", async () => {
  const { page } = owner;
  await orgTab(page, orgId, "scim");
  await page.getByRole("button", { name: "Actions for Okta" }).click();
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke token" }).click();
  await expect(page.locator(".toast")).toHaveText("Okta revoked.");
  const r = await call("GET", "/Users");
  expect(r.status()).toBe(401);
  expect((await r.json()).schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
  await orgTab(page, orgId, "audit-log");
  for (const a of ["SCIM token created", "SCIM user created", "SCIM user deactivated", "SCIM user reactivated", "SCIM user deleted", "SCIM token revoked"]) await expect(page.locator(".tbl")).toContainText(a);
});
