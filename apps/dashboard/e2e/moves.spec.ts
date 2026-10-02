/**
 * Export and move in the browser (prd/moves-export/PRD.md): a self-hosted project (the main e2e server) is exported and
 * downloaded, then moved to RevenueDot Cloud (the e2e Cloud server on E2E_PORT + 1, e2e/cloud-server.ts) with the
 * dashboard's own flow: the Cloud account verifies its email and creates an import token on Receive a project, the old
 * server checks (rows per table, nothing written), copies and verifies, then finishes; afterwards the old server forwards
 * the app's SDK calls and the new server has the customers. Each step's state is checked through the API too.
 *   E2E_PORT=5413 pnpm --filter @revenuedot/dashboard e2e -- moves
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 5199);
const CLOUD = `http://localhost:${PORT + 1}`;
const stamp = Date.now();
const owner = { email: `mover-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw` };
const cloudUser = { email: `cloud-${stamp}@revenuedot.test`, password: `e2e-${stamp}-cl` };
let pid = "", testKey = "", token = "";

async function json<T = any>(req: APIRequestContext, method: string, url: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await req.fetch(url, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function fits(page: Page, name: string) {
  // SHOTS=<dir> also saves the page at desktop width (README and docs screenshots).
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const buy = (req: APIRequestContext, user: string) => json(req, "POST", "/v1/receipts", { app_user_id: user, fetch_token: `test_${Date.now()}_${Math.random().toString(16).slice(2)}`, product_id: "pro_monthly", price: 9.99, currency: "USD" }, { authorization: `Bearer ${testKey}` });

/** A tar's member names and bytes. */
function untar(b: Buffer) {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const str = (o: number, l: number) => h.subarray(o, o + l).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 155) ? `${str(345, 155)}/` : "") + str(0, 100);
    const size = parseInt(str(124, 12).trim(), 8);
    out.set(name, b.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function signedIn(page: Page) {
  const req = page.request;
  if (!pid) {
    await json(req, "POST", "/auth/signup", { ...owner, name: "Mover", project_name: "Moving app" });
    pid = (await json(req, "GET", "/auth/me")).projects[0].id;
    const P = `/v2/projects/${pid}`;
    const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
    testKey = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
    const prod = await json(req, "POST", `${P}/products`, { store_identifier: "pro_monthly", app_id: app.id, type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
    const ent = await json(req, "POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
    await json(req, "POST", `${P}/entitlements/${ent.id}/actions/attach_products`, { product_ids: [prod.id] });
    await json(req, "POST", `${P}/integrations/webhooks`, { name: "Backend", url: "http://localhost:9/hook" });
    for (const u of ["ana", "ben", "cy"]) await buy(req, u);
  } else await json(req, "POST", "/auth/login", owner);
}

test("export: the archive downloads as a tar with a manifest, every table and no secrets; a passphrase must match", async ({ page }) => {
  const errors = watch(page);
  await signedIn(page);
  await page.goto(`/projects/${pid}/settings/export`);
  await expect(page.getByRole("tab", { name: "Export and move" })).toHaveAttribute("aria-selected", "true");
  // Secrets need a passphrase typed twice.
  await page.getByText("Include secrets, encrypted with a passphrase").click();
  await page.getByLabel("Passphrase", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Export project" }).click();
  await expect(page.getByRole("alert")).toHaveText("Use a passphrase of at least 12 characters.");
  await page.getByLabel("Passphrase", { exact: true }).fill("a long enough passphrase");
  await page.getByLabel("Passphrase again").fill("a different passphrase!");
  await page.getByRole("button", { name: "Export project" }).click();
  await expect(page.getByRole("alert")).toHaveText("The two passphrases differ.");
  await page.getByText("Include secrets, encrypted with a passphrase").click();
  await page.getByRole("button", { name: "Export project" }).click();
  const row = page.locator("tr[data-export]").first();
  await expect(row.getByText("Ready")).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Left out");
  const href = await row.getByRole("link", { name: "Download" }).getAttribute("href");
  expect(href).toMatch(/\/v2\/exports\/download\/exp_/);
  // The link needs no session (curl works): fetch it from a fresh request context.
  const res = await page.context().request.fetch(href!, { headers: { cookie: "" } });
  expect(res.headers()["content-type"]).toBe("application/x-tar");
  const files = untar(await res.body());
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  expect(manifest).toMatchObject({ format: "revenuedot-export", version: 1, project: { id: pid, name: "Moving app" }, secrets: { included: false } });
  expect(manifest.tables).toHaveLength(69);
  expect(manifest.tables.find((t: { name: string }) => t.name === "customers").rows).toBe(3);
  const all = [...files.values()].map((b) => b.toString("latin1")).join("");
  expect(all).not.toContain("whsec_");
  const api = await json(page.request, "GET", `/v2/projects/${pid}/export`);
  expect(api).toMatchObject({ status: "succeeded", rows: manifest.tables.reduce((n: number, t: { rows: number }) => n + t.rows, 0) });
  await fits(page, "export");
  expect(errors).toEqual([]);
});

async function cloudSession(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: CLOUD, viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await json(page.request, "POST", "/auth/signup", { ...cloudUser, name: "Cloud Owner", project_name: "First Cloud project" });
  return { ctx, page };
}

test("receive on Cloud: an unverified account cannot create a token; after the email link it can, shown once", async ({ browser, page: source }) => {
  const { ctx, page } = await cloudSession(browser);
  const errors = watch(page);
  await page.goto("/projects/receive");
  await expect(page.getByRole("heading", { name: "Receive a project" })).toBeVisible();
  await page.getByRole("button", { name: "Create import token" }).click();
  await expect(page.getByRole("alert")).toContainText("Verify your email address first");
  // The verification email (the e2e servers share one in-memory mailer).
  let link = "";
  await expect.poll(async () => {
    const mails = await (await source.request.get(`/__mail?to=${encodeURIComponent(cloudUser.email)}`)).json() as { text: string }[];
    link = /https?:\/\/\S+\/verify-email\?token=\S+/.exec(mails.map((m) => m.text).join("\n"))?.[0] ?? "";
    return link;
  }).toBeTruthy();
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
  await page.goto("/projects/receive");
  await page.getByRole("button", { name: "Create import token" }).click();
  await expect(page.getByText("Copy the token now: it is shown once")).toBeVisible();
  token = (await page.locator("[data-token]").textContent())!.trim();
  expect(token).toMatch(/^rdi_[0-9a-f]{64}$/);
  await expect(page.locator("pre").filter({ hasText: "npx revenuedot move" })).toContainText(`--to ${CLOUD}`);
  await fits(page, "receive");
  // A reload never shows it again.
  await page.reload();
  await expect(page.locator("[data-token]")).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("move to Cloud: check (nothing written), copy and verify, finish; the old server forwards and the new one has everything", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const errors = watch(page);
  await signedIn(page);
  await page.goto(`/projects/${pid}/settings/export`);
  const panel = page.locator("section", { has: page.getByRole("heading", { name: "Move this project" }) }).or(page.locator("section[aria-labelledby=move-h]"));
  await expect(page.getByText("RevenueDot Cloud", { exact: true })).toBeVisible();
  await page.getByText("Another RevenueDot server", { exact: true }).click();
  await page.getByLabel("Server URL").fill(CLOUD);
  // A bad token is refused before anything runs.
  await page.getByLabel("Import token").fill("not-a-token");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByRole("alert")).toContainText("starts with rdi_");
  await page.getByLabel("Import token").fill(token);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText("Checked", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Nothing was written.")).toBeVisible();
  const plan = page.getByLabel("What the move copies");
  await expect(plan.getByRole("row", { name: /customers 3 0/ })).toBeVisible();
  const cloudReq = (await browser.newContext({ baseURL: CLOUD })).request;
  await json(cloudReq, "POST", "/auth/login", cloudUser);
  expect((await json(cloudReq, "GET", "/auth/me")).projects.map((p: { name: string }) => p.name)).toEqual(["First Cloud project"]);

  await page.getByRole("button", { name: "Copy data" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Verified: all 69 tables and [\d,]+ rows match/)).toBeVisible();
  await fits(page, "move-copied");
  // On Cloud the copy exists but is held: the project is incoming, and its dashboard says so.
  const cloudProjects = (await json(cloudReq, "GET", "/auth/me")).projects;
  expect(cloudProjects.map((p: { id: string }) => p.id)).toContain(pid);
  expect(await json(cloudReq, "GET", `/v2/projects/${pid}/move`)).toMatchObject({ state: "incoming", moved_in_from: expect.stringContaining(`localhost:${PORT}`) });
  // The old server still serves the app.
  expect((await page.request.get(`/v1/subscribers/ana`, { headers: { authorization: `Bearer ${testKey}` } })).headers()["x-revenuedot-moved-to"]).toBeUndefined();

  await page.getByRole("button", { name: "Finish move" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Finish move" }).click();
  await expect(page.getByText("Moved", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Next steps")).toBeVisible();
  await expect(page.locator(".banner.ok").filter({ hasText: "This project moved to" })).toBeVisible();
  await expect(page.locator(".move-banner")).toContainText(CLOUD);

  // The old server forwards the app's SDK calls; a purchase lands on Cloud and unlocks pro.
  const viaOld = await page.request.post("/v1/receipts", { data: { app_user_id: "dee", fetch_token: `test_${Date.now()}_x${Math.random().toString(16).slice(2)}`, product_id: "pro_monthly", price: 9.99, currency: "USD" }, headers: { authorization: `Bearer ${testKey}` } });
  expect(viaOld.status()).toBe(200);
  expect(viaOld.headers()["x-revenuedot-moved-to"]).toBe(CLOUD);
  const dee = await json(cloudReq, "GET", `/v1/subscribers/dee`, undefined, { authorization: `Bearer ${testKey}` });
  expect(Object.keys(dee.subscriber.entitlements)).toEqual(["pro"]);
  // Cloud: live, with all four customers, the webhook and its original signing secret.
  expect(await json(cloudReq, "GET", `/v2/projects/${pid}/move`)).toMatchObject({ state: null });
  const customers = await json(cloudReq, "GET", `/v2/projects/${pid}/customers?limit=10`);
  expect(customers.items.map((c: { id: string }) => c.id).sort()).toEqual(["ana", "ben", "cy", "dee"]);
  const sourceHook = (await json(page.request, "GET", `/v2/projects/${pid}/integrations/webhooks`)).items[0];
  const cloudHook = (await json(cloudReq, "GET", `/v2/projects/${pid}/integrations/webhooks`)).items[0];
  expect(cloudHook).toMatchObject({ id: sourceHook.id, url: sourceHook.url });
  // The old copy is read-only in the dashboard.
  const write = await page.request.post(`/v2/projects/${pid}/entitlements`, { data: { lookup_key: "late", display_name: "Late" } });
  expect(write.status()).toBe(423);
  // The Cloud dashboard opens the moved project.
  const cloudCtx = await browser.newContext({ baseURL: CLOUD, viewport: { width: 1440, height: 1000 } });
  const cp = await cloudCtx.newPage();
  await json(cp.request, "POST", "/auth/login", cloudUser);
  await cp.goto(`/projects/${pid}/customers`);
  await expect(cp.getByText("dee", { exact: true })).toBeVisible();
  await expect(cp.locator(".move-banner")).toHaveCount(0);
  await cloudCtx.close();
  await fits(page, "moved");
  expect(errors).toEqual([]);
  void panel;
});
