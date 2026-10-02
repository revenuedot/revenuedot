// RevenueDot Enterprise (ee/LICENSE). Organizations and custom roles in the browser: an owner creates an organization,
// moves a project in, invites a developer, gives them a custom role, and the role is enforced in the dashboard and the
// API; members, projects and the empty states; phone width and dark mode. Spec: prd/enterprise/PRD.md §3, §4, §11.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DOMAIN, closeSql, createOrgUi, dark, linkFor, orgTab, person, phone, shot, signupUi, sql, watch } from "./fixtures";

test.describe.configure({ mode: "serial" });

let owner: { context: BrowserContext; page: Page };
let orgId = "", projectId = "";
const OWNER = `owner@${DOMAIN}`, DEV = `dev@${DOMAIN}`;

test.beforeAll(async ({ browser }) => { owner = await person(browser); });
test.afterAll(async () => { await owner.context.close(); await closeSql(); });

test("the sign-in page offers single sign-on when the server has it", async ({ page }) => {
  // Without the extension the button is absent: apps/server/test/extensions.test.ts checks /auth/config has no `sso`.
  const w = watch(page);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with SSO" })).toBeVisible();
  // A failed sign-in comes back as a code; the page shows its own text, never words from the link.
  await page.goto(`/login?sso_error=${encodeURIComponent("Your account is locked. Call +1 555 0100.")}`);
  await expect(page.getByRole("alert")).toHaveText("Single sign-on failed. Try again, or ask your administrator to check the connection.");
  await page.goto("/login?sso_error=other_browser");
  await expect(page.getByRole("alert")).toHaveText("This sign-in was started in another browser or has expired. Start it again here.");
  w.expectClean();
});

test("an owner creates an organization and moves a project in", async () => {
  const { page } = owner;
  const w = watch(page);
  projectId = await signupUi(page, OWNER, "Scanner");
  // The project switcher offers Organization settings.
  await page.locator(".proj").click();
  await page.getByRole("menuitem", { name: "Organization settings" }).click();
  await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  await expect(page.getByText("Development licence")).toBeVisible();
  await shot(page, "org-index-empty");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a name.");
  orgId = await createOrgUi(page, "Acme Inc.");
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByRole("button", { name: "Move a project in" }).click();
  await expect(page.getByRole("dialog")).toContainText("Projects where you are an admin");
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page.locator(".tbl")).toContainText("Scanner");
  await shot(page, "org-projects");
  const [row] = await sql()`select org_id, region from ee_org_projects where project_id = ${projectId}`;
  expect(row).toMatchObject({ org_id: orgId, region: "us" });
  await phone(page, "org-projects");
  await dark(page, "org-projects");
  w.expectClean();
});

test("general settings save, with the licence shown", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "general");
  await expect(page.locator(".tag", { hasText: "development" })).toBeVisible();
  await page.getByLabel("Seats bought").fill("25");
  await page.getByLabel("Billing email").fill(`billing@${DOMAIN}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".toast")).toHaveText("Saved.");
  const [o] = await sql()`select seats, billing_email from ee_organizations where id = ${orgId}`;
  expect(o).toEqual({ seats: 25, billing_email: `billing@${DOMAIN}` });
  // Delete is offered only once the projects are moved out.
  await expect(page.getByRole("button", { name: "Delete organization" })).toBeDisabled();
  await phone(page, "org-general");
  await dark(page, "org-general");
  w.expectClean();
});

let dev: { context: BrowserContext; page: Page };
let roleId = "";

test("a custom role is created with the scope picker", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "roles");
  await expect(page.getByText("No custom roles yet")).toBeVisible();
  await page.getByRole("button", { name: "New role" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Name").fill("Catalog viewer");
  await d.getByLabel("Description").fill("Reads products and entitlements");
  await d.getByText("View products", { exact: true }).click();
  // Ticking a write scope ticks its read scope too.
  await d.getByText("Edit entitlements", { exact: true }).click();
  await expect(d.getByRole("checkbox", { name: /View entitlements/ })).toBeChecked();
  await shot(page, "role-editor");
  await d.getByRole("button", { name: "Create role" }).click();
  await expect(page.locator(".tbl")).toContainText("Catalog viewer");
  const [r] = await sql()`select id, scopes from ee_custom_roles where org_id = ${orgId}`;
  roleId = r!.id;
  expect(r!.scopes).toEqual(["project_configuration:entitlements:read", "project_configuration:entitlements:read_write", "project_configuration:products:read"]);
  await phone(page, "org-roles");
  w.expectClean();
});

test("a developer is invited, given the custom role, and the role is enforced in the dashboard and the API", async ({ browser }) => {
  const { page } = owner;
  dev = await person(browser);
  await signupUi(dev.page, DEV, "Dev own project");
  // The owner invites them from the project's Collaborators settings (core).
  await page.goto(`/projects/${projectId}/settings/collaborators`);
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Email").fill(DEV);
  await page.getByRole("button", { name: "Send invite" }).click();
  const link = await linkFor(page, DEV, "/invite?token=");
  await dev.page.goto(link);
  await dev.page.getByRole("button", { name: "Accept invite" }).click();
  await dev.page.waitForURL(new RegExp(`/projects/${projectId}/`));
  // Owner assigns the custom role in Organization settings, Projects, Members and roles.
  await orgTab(page, orgId, "projects");
  await page.getByRole("button", { name: "Actions for Scanner" }).click();
  await page.getByRole("menuitem", { name: "Members and roles" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel(`Role of ${DEV} in Scanner`).selectOption({ label: "Catalog viewer" });
  await expect(page.locator(".toast")).toContainText("is now Catalog viewer");
  await shot(page, "project-members-dialog");
  await d.getByRole("button", { name: "Done" }).click();
  const [m] = await sql()`select role from memberships where project_id = ${projectId} and user_id = (select id from users where email = ${DEV})`;
  expect(m!.role).toBe(roleId);
  // Core Collaborators shows "Custom role", never Admin.
  await page.goto(`/projects/${projectId}/settings/collaborators`);
  await expect(page.locator("tr", { hasText: DEV }).locator(".tag")).toHaveText("Custom role");

  const w = watch(dev.page);
  // Allowed: products and entitlements.
  await dev.page.goto(`/projects/${projectId}/product-catalog/products`);
  await expect(dev.page.locator(".page h1")).toHaveText("Products");
  await expect(dev.page.getByRole("alert")).toHaveCount(0);
  // Forbidden: customers (the page shows the API's message) and every write it lacks.
  await dev.page.goto(`/projects/${projectId}/customers`);
  await expect(dev.page.getByText(/does not allow this/)).toBeVisible();
  await shot(dev.page, "custom-role-forbidden");
  const api = dev.page.request;
  expect((await api.get(`/v2/projects/${projectId}/customers`)).status()).toBe(403);
  expect((await api.post(`/v2/projects/${projectId}/products`, { data: { store_identifier: "x", type: "subscription", app_id: "app" } })).status()).toBe(403);
  expect((await api.post(`/v2/projects/${projectId}/api_keys`, { data: { name: "nope" } })).status()).toBe(403);
  expect((await api.post(`/v2/projects/${projectId}/invites`, { data: { email: `x@${DOMAIN}`, role: "admin" } })).status()).toBe(403);
  const created = await api.post(`/v2/projects/${projectId}/entitlements`, { data: { lookup_key: "pro", display_name: "Pro" } });
  expect(created.status()).toBe(201);
  // Organization pages: a member sees the organization but not admin actions.
  await dev.page.goto(`/organizations/${orgId}/members`);
  await expect(dev.page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  await dev.page.goto(`/organizations/${orgId}/audit-log`);
  await expect(dev.page.getByText("Only owners and admins see the organization log.")).toBeVisible();
  expect((await api.get(`/v2/organizations/${orgId}/audit_logs`)).status()).toBe(403);
  expect((await api.post(`/v2/organizations/${orgId}/roles`, { data: { name: "x", scopes: [] } })).status()).toBe(403);
  w.expectClean();
});

test("an MCP client the custom-role member connects gets only the role's reads", async () => {
  const REDIRECT = "https://claude.example.com/callback";
  const w = watch(dev.page);
  const reg = await dev.page.request.post("/oauth/register", { data: { client_name: "Claude", redirect_uris: [REDIRECT] } });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;
  const verifier = "v".repeat(43);
  const challenge = await dev.page.evaluate(async (v) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), verifier);
  await dev.page.goto(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "e2e" })}`);
  await expect(dev.page.getByRole("heading", { name: /Connect Claude/ })).toBeVisible();
  await dev.page.getByLabel("Project").selectOption(projectId);
  await shot(dev.page, "mcp-consent-custom-role");
  await dev.page.route("https://claude.example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>Connected</p>" }));
  // The answer redirects to the app's callback with the code (read from the redirect; the page never leaves for the internet).
  const answered = dev.page.waitForResponse((r) => r.url().endsWith("/oauth/authorize") && r.request().method() === "POST");
  await dev.page.getByRole("button", { name: "Allow access" }).click();
  const back = (await answered).headers()["location"] ?? "";
  expect(back).toContain(`${REDIRECT}?code=`);
  const tok = await dev.page.request.post("/oauth/token", { form: { grant_type: "authorization_code", code: new URL(back).searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT } });
  expect(tok.status()).toBe(200);
  const key = (await tok.json()).access_token as string;
  const [k] = await sql()`select permissions from api_keys where project_id = ${projectId} and name = 'OAuth: Claude'`;
  expect([...k!.permissions].sort()).toEqual(["project_configuration:entitlements:read", "project_configuration:products:read"]);
  const bearer = { headers: { authorization: `Bearer ${key}` } };
  expect((await dev.page.request.get(`/v2/projects/${projectId}/products`, bearer)).status()).toBe(200);
  expect((await dev.page.request.get(`/v2/projects/${projectId}/customers`, bearer)).status()).toBe(403);
  expect((await dev.page.request.get(`/v2/projects/${projectId}/apps`, bearer)).status()).toBe(403);
  await dev.page.goto(`/projects/${projectId}/overview`);
  w.expectClean();
});

test("members: roles change, an admin is admin of every project, removal ends access", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "members");
  await expect(page.locator(".tbl")).toContainText(DEV);
  await expect(page.locator("tr", { hasText: DEV })).toContainText("From a project");
  await page.getByLabel(`Organization role of ${DEV}`).selectOption("admin");
  await expect(page.locator(".toast")).toContainText("is now an admin");
  // As organization admin the developer can now open customers (admin of every organization project)… but the
  // custom role they were given by hand stays, so the membership keeps its role: check the API.
  const r = await dev.page.request.get(`/v2/projects/${projectId}/customers`);
  expect(r.status()).toBe(403);
  await shot(page, "org-members");
  await phone(page, "org-members");
  await dark(page, "org-members");
  // Removing them from the organization ends access to every organization project, hand-added memberships included.
  await page.getByRole("button", { name: `Actions for ${DEV}` }).click();
  await page.getByRole("menuitem", { name: "Remove from organization" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".tbl")).not.toContainText(DEV);
  expect((await dev.page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(404);
  const rows = await sql()`select 1 from memberships where project_id = ${projectId} and user_id = (select id from users where email = ${DEV})`;
  expect(rows.length).toBe(0);
  await dev.context.close();
  w.expectClean();
});

test("the organization log records every change with who made it", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "audit-log");
  for (const what of ["Organization created", "Project added", "Role created", "Project role changed", "Member role changed", "Member removed"]) {
    await expect(page.locator(".tbl")).toContainText(what);
  }
  await phone(page, "org-audit");
  w.expectClean();
});
