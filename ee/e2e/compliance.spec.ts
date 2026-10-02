// RevenueDot Enterprise (ee/LICENSE). Data location, audit retention and compliance exports in the browser: a region
// recorded on a self-hosted server, a shorter retention purging old rows (confirmed in SQL and in the log), and signed
// audit log and access review downloads whose signatures verify with the public key the page shows.
// Spec: prd/enterprise/PRD.md §8, §9, §10.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { DOMAIN, closeSql, createOrgUi, dark, orgTab, person, phone, shot, signupUi, sql, watch } from "./fixtures";

test.describe.configure({ mode: "serial" });
// Playwright's trace recorder fetches responses a second time, which would log every export twice.
test.use({ trace: "off" });

const D = `comp-${DOMAIN}`;
let owner: { context: BrowserContext; page: Page };
let orgId = "", projectId = "";

test.beforeAll(async ({ browser }) => { owner = await person(browser); });
test.afterAll(async () => { await owner.context.close(); await closeSql(); });

test("setup", async () => {
  const { page } = owner;
  projectId = await signupUi(page, `owner@${D}`, "Ledger");
  orgId = await createOrgUi(page, "Compliance Co");
  await page.getByRole("button", { name: "Move a project in" }).click();
  await page.getByRole("button", { name: "Move project" }).click();
  await expect(page.locator(".tbl")).toContainText("Ledger");
});

test("data location: a self-hosted server records the region without moving or refusing anything", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "data-location");
  await expect(page.getByText("This server runs where you host it")).toBeVisible();
  await page.getByLabel("Region of Ledger").selectOption("eu");
  await expect(page.locator(".toast")).toHaveText("Ledger is now stored in European Union.");
  expect((await sql()`select region from ee_org_projects where project_id = ${projectId}`)[0]!.region).toBe("eu");
  await page.getByLabel("Default for new projects").selectOption("eu");
  await expect(page.locator(".toast")).toHaveText("New projects default to European Union.");
  // Not enforced here: the project's API still answers.
  expect((await page.request.get(`/v2/projects/${projectId}/products`)).status()).toBe(200);
  await shot(page, "data-location");
  await phone(page, "data-location");
  await dark(page, "data-location");
  w.expectClean();
});

test("retention: shortening it asks first, then the hourly job deletes older rows of the organization and its projects", async () => {
  const { page } = owner;
  const w = watch(page);
  const old = new Date(Date.now() - 400 * 86400_000), recent = new Date(Date.now() - 5 * 86400_000);
  const uid = (await sql()`select id from users where email = ${`owner@${D}`}`)[0]!.id;
  await sql()`insert into audit_logs (id, project_id, action_type, target_type, target_identifier, actor_type, actor_identifier, occurred_at) values
    (${`old_${orgId}`}, ${projectId}, 'product_created', 'product', 'p_old', 'user', ${uid}, ${old}),
    (${`new_${orgId}`}, ${projectId}, 'product_created', 'product', 'p_new', 'user', ${uid}, ${recent})`;
  await sql()`insert into ee_org_audit_logs (id, org_id, action, actor_type, actor_id, target_type, target_id, occurred_at) values (${`oold_${orgId}`}, ${orgId}, 'member_added', 'user', ${uid}, 'user', ${uid}, ${old})`;
  // Nothing is purged while retention is "forever".
  await page.request.post("/__tick");
  expect((await sql()`select count(*)::int as n from audit_logs where project_id = ${projectId} and id like ${"%_" + orgId}`)[0]!.n).toBe(2);
  await orgTab(page, orgId, "audit-log");
  await expect(page.getByLabel("Keep audit logs for")).toHaveValue("");
  await page.getByLabel("Keep audit logs for").selectOption("365");
  await expect(page.getByRole("dialog")).toContainText("cannot be undone");
  await shot(page, "retention-confirm");
  await page.getByRole("button", { name: "Delete older entries" }).click();
  await expect(page.locator(".toast")).toHaveText("Audit logs are kept for 1 year.");
  await page.request.post("/__tick");
  await expect.poll(async () => (await sql()`select id from audit_logs where project_id = ${projectId} and id like ${"%_" + orgId}`).map((r) => r.id)).toEqual([`new_${orgId}`]);
  expect((await sql()`select count(*)::int as n from ee_org_audit_logs where id = ${`oold_${orgId}`}`)[0]!.n).toBe(0);
  await page.reload();
  await expect(page.locator(".tbl")).toContainText("Audit logs purged");
  await phone(page, "audit-log");
  w.expectClean();
});

test("exports: signed CSV and JSON downloads verify with the page's public key", async () => {
  const { page } = owner;
  const w = watch(page);
  await orgTab(page, orgId, "exports");
  const publicKey = (await page.locator(".copyfield code").first().textContent())!;
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download audit log" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^revenuedot-audit-logs-org_.*\.csv$/);
  const bytes = readFileSync((await csv.path())!);
  const sig = (await page.locator(".kv div", { hasText: /^[A-Za-z0-9+/=]{80,}$/ }).first().textContent())!;
  expect(verify(null, bytes, spki, Buffer.from(sig, "base64"))).toBe(true);
  expect(verify(null, Buffer.concat([bytes, Buffer.from(" ")]), spki, Buffer.from(sig, "base64"))).toBe(false);
  await expect(page.locator(".kv")).toContainText(createHash("sha256").update(bytes).digest("hex"));
  expect(bytes.toString("utf8").split("\r\n")[0]).toBe("occurred_at,scope,project_id,project_name,action,actor_type,actor_id,actor_email,target_type,target_id,details");
  expect(bytes.toString("utf8")).toContain("project_region_changed");
  await shot(page, "exports-done");
  await page.getByRole("button", { name: "JSON" }).click();
  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download access review" }).click()]);
  const jb = readFileSync((await json.path())!);
  const body = JSON.parse(jb.toString("utf8"));
  expect(body).toMatchObject({ object: "compliance_export", kind: "access_review", organization: { id: orgId, name: "Compliance Co" } });
  expect(body.rows.find((r: { email: string }) => r.email === `owner@${D}`)).toMatchObject({ organization_role: "owner", project_role: "admin", project_name: "Ledger" });
  const sig2 = (await page.locator(".kv div", { hasText: /^[A-Za-z0-9+/=]{80,}$/ }).first().textContent())!;
  expect(verify(null, jb, spki, Buffer.from(sig2, "base64"))).toBe(true);
  expect((await sql()`select count(*)::int as n from ee_org_audit_logs where org_id = ${orgId} and action = 'compliance_export_created'`)[0]!.n).toBe(2);
  await phone(page, "exports");
  await dark(page, "exports");
  w.expectClean();
});
