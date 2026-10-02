// RevenueDot Enterprise (ee/LICENSE). Shared helpers for the enterprise browser tests: accounts through the real
// sign-up page, emails from the server's memory, fake DNS records, SQL checks on the test database, console-error and
// phone-width checks.
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";

export const RUN = Date.now().toString(36);
export const PW = `ee-${RUN}-password`;
/** A unique company domain per run, so the shared Railway database never sees the same domain twice. */
export const DOMAIN = `acme-${RUN}.test`;
export const IDP = `http://localhost:${Number(process.env.E2E_IDP_PORT ?? Number(process.env.E2E_PORT ?? 5462) + 1)}`;

let sqlClient: ReturnType<typeof postgres> | null = null;
/** SQL on the test database (DATABASE_URL from ee/e2e/env.sh), to check what the UI did. */
export const sql = () => (sqlClient ??= postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} }));
export async function closeSql() { await sqlClient?.end(); sqlClient = null; }

/** Collects console errors and page errors; `expectClean` fails the test if any appeared. */
export function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    // 4xx answers the page handles (a forbidden page, a refused sign-in) are logged by the browser as resource errors.
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return { errors, expectClean: () => expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]) };
}

export async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: false });
}

/** The page fits 390px without sideways scrolling (and in dark mode when asked); restores the desktop size. */
export async function phone(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  await shot(page, `${name}-390`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function dark(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(150);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg, `${name} has a dark background`).toBe("rgb(10, 10, 10)");
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

export async function signupUi(page: Page, email: string, project = "Scanner") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(email.split("@")[0]!);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByLabel("First project").fill(project);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  return /\/projects\/([^/]+)\//.exec(page.url())![1]!;
}

export async function loginUi(page: Page, email: string, password = PW) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** A fresh browser context (its own cookies), like a second person on another computer. */
export async function person(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  return { context, page: await context.newPage() };
}

/** The newest email to `to` with a link containing `path`, as a path on this site. */
export async function linkFor(page: Page, to: string, path: string): Promise<string> {
  let found: string | null = null;
  await expect.poll(async () => {
    const mails = await (await page.request.get(`/__mail?to=${encodeURIComponent(to)}`)).json() as { text: string }[];
    for (const m of [...mails].reverse()) {
      const u = new RegExp(`https?://[^\\s]+${path.replace(/[?]/g, "\\?")}[^\\s]+`).exec(m.text);
      if (u) { found = new URL(u[0]).pathname + new URL(u[0]).search; return true; }
    }
    return false;
  }, { timeout: 10_000 }).toBe(true);
  return found!;
}

/** Publishes a TXT record in the server's fake DNS (the domain check never reaches a real resolver). */
export async function publishTxt(page: Page, name: string, value: string) {
  await page.request.post("/__dns", { data: { name, TXT: [value] } });
}

/** Creates an organization through the UI and returns its id. */
export async function createOrgUi(page: Page, name: string) {
  await page.goto("/organizations");
  await page.getByLabel("Organization name").fill(name);
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/\/organizations\/org_[^/]+\/projects/);
  return /\/organizations\/(org_[^/]+)\//.exec(page.url())![1]!;
}

/** Opens a tab of the organization settings. */
export async function orgTab(page: Page, orgId: string, tab: string) {
  await page.goto(`/organizations/${orgId}/${tab}`);
  await expect(page.locator(".page h1")).toBeVisible();
}
