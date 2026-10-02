// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (k), the whole dashboard in a real browser. A developer signs up through the UI on a project seeded
// with realistic data (apps/dashboard/e2e/seed.ts through the public API, plus Test Store lifecycles: renewals, a
// cancellation, a refund, trials), then creates, edits and deletes every kind of object the dashboard manages by clicking
// through it, and checks each change through the v2 API or SQL and again after a reload. Every route of
// apps/dashboard/src/routes.tsx (plus sign-in, sign-up, password reset, email verification, invite and account pages) is
// opened and must show its heading and the project's data. Then every page is checked at phone width (375x812) and in
// dark mode (the in-app theme switch and prefers-color-scheme): no horizontal overflow and readable text contrast,
// with screenshots in the run folder. Console errors, page errors and failed API requests fail the journey anywhere.
// Nothing leaves this machine: Slack, the S3 bucket and Stripe answer from the capture server.
//   JOURNEY_PORT_BASE=5614 pnpm tsx scripts/e2e/journeys/run.ts dashboard-ui
// DUI_ONLY=<comma-separated section names> runs only those sections after the setup (for debugging).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, sdkClient } from "./lib/context.ts";
import { PORTS, ROOT, linksOf } from "./lib/stack.ts";
import { seedProject } from "../../../apps/dashboard/e2e/seed.ts";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";

type PW = typeof import("@playwright/test");
type Page = import("@playwright/test").Page;
type BrowserContext = import("@playwright/test").BrowserContext;
type Locator = import("@playwright/test").Locator;
const pw = () => createRequire(join(ROOT, "apps/dashboard/package.json"))("@playwright/test") as PW;

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const slug = (s: string) => s.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "root";

/** WCAG contrast of each visible text element against its painted background (run in the page). */
function contrastProbe(limit: number) {
  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA | null => {
    let m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; }
    m = /^color\(srgb ([^)]+)\)$/.exec(c);
    if (m) { const p = m[1]!.split(/[\s/]+/).filter(Boolean).map(Number); return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1]; }
    return null;
  };
  const lum = ([r, g, b]: RGBA) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top: RGBA, under: RGBA): RGBA => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  const bad: Array<{ text: string; ratio: number; need: number; fg: string; bg: string; path: string }> = [];
  let checked = 0;
  const pathOf = (el: Element) => { const parts: string[] = []; for (let e: Element | null = el; e && parts.length < 4; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.classList.length ? "." + [...e.classList].slice(0, 2).join(".") : "")); return parts.join(" > "); };
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (checked >= limit) break;
    if (!(el instanceof HTMLElement)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim();
    if (!own) continue;
    if (el.closest("figure, iframe, svg, [aria-hidden=true], [disabled], [aria-disabled=true], option, .sr-only")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible" || Number(cs.opacity) === 0) continue;
    // Painted background: composite every layer from the root down to this element.
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let bg: RGBA = [255, 255, 255, 1];
    let opacity = 1;
    let image = false;
    for (const e of chain) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== "none") image = true;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) bg = over(c, bg);
      opacity *= Number(s.opacity);
    }
    if (image) continue;
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity], bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    checked++;
    if (ratio + 0.005 < need) bad.push({ text: own.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need, fg: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`, path: pathOf(el) });
  }
  return { checked, bad };
}

const journey: Journey = {
  name: "dashboard-ui",
  title: "The dashboard in a real browser: every page, every object created, edited and deleted, phone width, dark mode",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const { chromium, expect } = pw();
    const only = (process.env.DUI_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // Sections that make objects later sections use run whenever a later one is picked.
    const NEEDS: Record<string, string[]> = {
      products: ["apps"], entitlements: ["apps", "products"], offerings: ["apps", "web", "products"], paywalls: ["apps", "web", "products", "offerings"],
      targeting: ["apps", "web", "products", "offerings"], experiments: ["apps", "web", "products", "offerings"], "customer-actions": ["apps", "web", "products", "offerings"],
      retention: ["apps", "products"], funnel: ["apps", "web", "products", "offerings"], "web-discount": ["web"], "invite-flow": [], roles: ["apps", "products", "invite-flow"], validation: ["apps", "products"],
      "customer-page": ["apps", "web", "products", "offerings", "targeting", "experiments", "customer-actions"], "customer-center": [], support: [], "ads-rewards": ["customer-page"], "store-import": ["apps", "web"], "empty-states": [], pages: ["*"], "desktop-dark": ["*"], "desktop-light": ["*"], "phone-light": ["*"], "phone-dark": ["*"], theme: [],
    };
    const wanted = new Set(only.flatMap((n) => [n, ...(NEEDS[n] ?? [])]));
    const runs = (name: string) => !only.length || wanted.has("*") || wanted.has(name);
    const browser = await chromium.launch();

    // ---------- watchers: console errors, page errors and failed API requests, for every page of the run ----------
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    /** "METHOD path" patterns and the status a step provokes on purpose (a validation answer, a 404 after delete). */
    let expected: Array<{ re: RegExp; status: number }> = [];
    const isExpected = (method: string, path: string, status: number) => expected.some((e) => e.status === status && e.re.test(`${method} ${path}`));
    const watch = (page: Page) => {
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const url = m.location()?.url ?? "";
        const st = /status of (\d{3})/.exec(m.text());
        if (st && url.startsWith(ctx.base)) {
          // The failed response itself is judged by the response watcher below (expected or not).
          return;
        }
        consoleErrors.push(`${page.url().replace(ctx.base, "")}: ${m.text()}${url ? ` (${url.replace(ctx.base, "")})` : ""}`);
      });
      page.on("pageerror", (e) => consoleErrors.push(`${page.url().replace(ctx.base, "")}: pageerror ${e.message}`));
      page.on("response", (r) => {
        const u = new URL(r.url());
        if (u.origin !== ctx.base || r.status() < 400) return;
        const method = r.request().method();
        if (isExpected(method, u.pathname, r.status())) return;
        failedRequests.push(`${method} ${u.pathname}${u.search} → ${r.status()} (on ${page.url().replace(ctx.base, "")})`);
      });
      page.on("requestfailed", (r) => {
        const u = new URL(r.url());
        if (u.origin !== ctx.base) return;
        const f = r.failure()?.errorText ?? "";
        if (/ERR_ABORTED/.test(f)) return; // navigation away while a request was in flight
        failedRequests.push(`${r.method()} ${u.pathname} failed: ${f}`);
      });
    };
    const shots = (dir: string) => { const d = join(ctx.out, dir); mkdirSync(d, { recursive: true }); return d; };
    const newContext = async (opts: Parameters<typeof browser.newContext>[0] = {}) => {
      const cx = await browser.newContext({ viewport: DESKTOP, acceptDownloads: true, ...opts });
      await cx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
      cx.on("page", watch);
      return cx;
    };

    /** A section: failures (a missing button, a timeout) are recorded and the journey goes on with the next one. */
    let page!: Page;
    const step = async (name: string, fn: () => Promise<void>) => {
      if (!runs(name.split(":")[0]!) && !name.startsWith("signed-out pages")) return;
      c.begin(name);
      const n0 = failedRequests.length, e0 = consoleErrors.length;
      try { await fn(); } catch (e) {
        c.check("the section ran to the end", false, String(e instanceof Error ? e.message : e).split("\n").slice(0, 6).join(" | "));
        await page?.screenshot({ path: join(shots("failures"), `${slug(name)}.png`) }).catch(() => {});
      }
      expected = [];
      c.check("no failed API requests", failedRequests.length === n0, failedRequests.slice(n0, n0 + 8));
      c.check("no console errors", consoleErrors.length === e0, consoleErrors.slice(e0, e0 + 8));
    };
    const allow = (re: RegExp, status: number) => { expected.push({ re, status }); };

    // Slack's incoming webhooks answer "ok" (text); the delivery code checks for it.
    const slack = (c: { host: string }, res: import("node:http").ServerResponse) => {
      if (c.host !== "hooks.slack.com") return false;
      res.setHeader("content-type", "text/plain"); res.end("ok"); return true;
    };
    ctx.capture.handlers.push(slack);
    try {
      const cx = await newContext();
      page = await cx.newPage();
      const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible({ timeout: 15_000 });
      const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });
      const settle = async () => { await page.waitForLoadState("networkidle").catch(() => {}); };
      const go = async (path: string) => { await page.goto(ctx.base + path); await settle(); };
      /** Picks the option whose text matches (labels that carry generated ids). */
      const selectByText = async (select: Locator, re: RegExp) => {
        const value = await select.evaluate((el, src) => [...(el as HTMLSelectElement).options].find((o) => new RegExp(src).test(o.text))?.value ?? null, re.source);
        if (value === null) throw new Error(`no option matches ${re}`);
        await select.selectOption(value);
      };

      // ---------- 1. signed-out pages and sign-up through the form ----------
      const email = `dashboard-${ctx.stamp}@journeys.test`;
      const password = `dash-${ctx.stamp}-pw`;
      let projectId = "";
      await step("signed-out pages: home, sign in, forgot password", async () => {
        await go("/");
        c.check("/ sends a signed-out visitor to /login", page.url().endsWith("/login"), page.url());
        await expect(page.getByRole("heading", { name: "Sign in to RevenueDot" })).toBeVisible();
        c.check("/login shows the sign-in form", await page.getByLabel("Email", { exact: true }).isVisible() && await page.getByLabel("Password").isVisible());
        await page.getByRole("link", { name: "Forgot password?" }).click();
        await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
        c.check("/forgot-password shows its form", await page.getByRole("button", { name: "Send reset link" }).isVisible(), page.url());
      });
      c.begin("sign-up through the form");
      {
        const n0 = failedRequests.length, e0 = consoleErrors.length;
        await go("/signup");
        await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
        await page.getByLabel("Your name").fill("Dana Dashboard");
        await page.getByLabel("Email", { exact: true }).fill(email);
        await page.getByLabel("Password").fill(password);
        await page.getByLabel("First project").fill("Pocket Scanner");
        await page.getByRole("button", { name: "Create account" }).click();
        await page.waitForURL(/\/projects\/[^/]+\/overview/, { timeout: 20_000 }).catch(() => {});
        projectId = /\/projects\/([^/]+)\//.exec(page.url())?.[1] ?? "";
        c.must("the sign-up form lands on the new project's Overview", projectId, page.url());
        const [row] = await ctx.sql`SELECT p.name, m.role FROM projects p JOIN memberships m ON m.project_id = p.id JOIN users u ON u.id = m.user_id WHERE u.email = ${email}`;
        c.eq("users, projects and memberships rows for the new account", row && { name: row.name, role: row.role }, { name: "Pocket Scanner", role: "admin" });
        c.check("no failed API requests", failedRequests.length === n0, failedRequests.slice(n0));
        c.check("no console errors", consoleErrors.length === e0, consoleErrors.slice(e0));
      }
      const cookieOf = async () => `rd_session=${(await cx.cookies()).find((k) => k.name === "rd_session")?.value}`;
      let cookie = await cookieOf();
      const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
        const r = await fetch(ctx.base + path, { method, headers: { cookie, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined });
        const t = await r.text();
        let body: any = t; try { body = t ? JSON.parse(t) : null; } catch { /* text */ }
        return { status: r.status, body };
      };
      const P = `/v2/projects/${projectId}`;
      const v2 = async (method: string, path: string, json?: unknown) => {
        const r = await call(method, P + path, json);
        if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
        return r.body;
      };
      const B = `/projects/${projectId}`;

      await step("verify-email: the link from the email confirms the address", async () => {
        c.eq("a new account starts unverified", (await call("GET", "/auth/me")).body.user.email_verified, false);
        c.eq("a new verification email is requested", (await call("POST", "/auth/email/verify/resend")).status, 200);
        const vmail = await until(async () => ctx.mails.find((m) => m.to.includes(email) && /confirm|verif/i.test(m.subject)));
        const vlink = vmail ? linksOf(vmail).find((l) => /verify-email/.test(l)) : undefined;
        c.must("the verification email arrived over SMTP with a link to this server", vlink?.startsWith(ctx.base));
        await page.goto(vlink!); await settle();
        await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
        c.eq("/auth/me says the email is verified", (await call("GET", "/auth/me")).body.user.email_verified, true);
      });

      // ---------- 2. realistic data through the public API ----------
      c.begin("seeded project data");
      const seed = await seedProject(ctx.base, cookie, projectId, { customers: 40 });
      const scenarios: Array<[string, string, string, number?]> = [
        ["renewing_reader", "pro_monthly", "renewal", 65], ["cancelled_carla", "pro_monthly", "cancel"], ["refunded_rafa", "pro_annual", "refund"],
        ["trial_tom", "pro_annual", "trial"], ["converted_cleo", "pro_weekly", "trial_conversion"], ["billing_bea", "pro_monthly", "billing_issue"], ["expired_eli", "pro_weekly", "expire"],
      ];
      for (const [user, product, scenario, offset] of scenarios) {
        const r = await call("POST", `${P}/test_purchases`, { app_user_id: user, product_id: product, scenario, ...(offset ? { offset_days: offset } : {}) });
        c.check(`test purchase scenario ${scenario} for ${user}`, r.status === 201, r.body);
      }
      await call("POST", `${P}/customers/refunded_rafa/attributes`, { attributes: [{ name: "$email", value: "rafa@example.com" }, { name: "$displayName", value: "Rafa" }] });
      const [counts] = await ctx.sql`SELECT (SELECT count(*)::int FROM customers WHERE project_id = ${projectId}) AS customers, (SELECT count(*)::int FROM transactions WHERE project_id = ${projectId}) AS transactions`;
      c.check("the project has 45+ customers and their transactions", counts!.customers >= 45 && counts!.transactions >= 60, counts);
      const named = seed.customers.find((x) => !x.startsWith("$RCAnonymousID") && x !== "support_vip_1")!;

      // Ids made in the sections below and used by the page sweep.
      const ids: Record<string, string> = {};

      // ---------- 3. create, edit and delete through the UI ----------
      await step("project-settings: rename and transfer behaviour", async () => {
        await go(`${B}/settings`);
        await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();
        await page.getByLabel("Project name").fill("Pocket Scanner Pro");
        await page.getByLabel("Transferring purchases seen on multiple app user IDs").selectOption("keep");
        await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click();
        await toast("Project settings saved.");
        const p = await v2("GET", "");
        c.has("v2 project has the new name and transfer behaviour", p, { name: "Pocket Scanner Pro", transfer_behavior: "keep" });
        await page.reload(); await settle();
        c.check("after a reload the form shows the saved values", await page.getByLabel("Project name").inputValue() === "Pocket Scanner Pro" && await page.getByLabel("Transferring purchases seen on multiple app user IDs").inputValue() === "keep");
        await expect(page.locator(".crumb-project")).toHaveText("Pocket Scanner Pro");
        // Back to the default so later restores behave as usual.
        await page.getByLabel("Transferring purchases seen on multiple app user IDs").selectOption("transfer");
        await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click();
        await toast("Project settings saved.");
        c.eq("transfer behaviour set back to transfer", (await v2("GET", "")).transfer_behavior, "transfer");
      });

      await step("apps: add, rename and delete", async () => {
        await go(`${B}/apps`);
        await page.getByRole("button", { name: "Add app" }).first().click();
        let d = dialog("Add an app");
        await d.getByRole("button", { name: /App Store/ }).click();
        await d.getByLabel("App name").fill("Pocket Scanner iOS");
        await d.getByLabel("Bundle ID").fill("com.example.pocketscanner");
        await d.getByRole("button", { name: "Add app" }).click();
        await page.waitForURL(/\/apps\/app/);
        ids.iosApp = page.url().split("/").pop()!.split("#")[0]!;
        await expect(page.getByRole("heading", { name: "Pocket Scanner iOS" })).toBeVisible();
        c.has("v2 app store app created", await v2("GET", `/apps/${ids.iosApp}`), { name: "Pocket Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.pocketscanner" } });
        await page.getByLabel("App name").fill("Pocket Scanner for iPhone");
        await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Save changes" }).click();
        await toast("Changes saved.");
        c.eq("v2 app renamed", (await v2("GET", `/apps/${ids.iosApp}`)).name, "Pocket Scanner for iPhone");
        await page.reload(); await settle();
        await expect(page.getByRole("heading", { name: "Pocket Scanner for iPhone" })).toBeVisible();

        await go(`${B}/apps`);
        await page.getByRole("button", { name: "Add app" }).first().click();
        d = dialog("Add an app");
        await d.getByRole("button", { name: /Google Play/ }).click();
        await d.getByLabel("App name").fill("Pocket Scanner Android");
        await d.getByLabel("Package name").fill("com.example.pocketscanner");
        await d.getByRole("button", { name: "Add app" }).click();
        await page.waitForURL(/\/apps\/app/);
        const playId = page.url().split("/").pop()!.split("#")[0]!;
        c.eq("v2 Google Play app created", (await v2("GET", `/apps/${playId}`)).type, "play_store");
        await page.getByRole("button", { name: "Delete app" }).click();
        await dialog("Delete Pocket Scanner Android?").getByRole("button", { name: "Delete app" }).click();
        await page.waitForURL(/\/apps$/);
        c.eq("v2 answers 404 for the deleted app", (await call("GET", `${P}/apps/${playId}`)).status, 404);
        await page.reload(); await settle();
        c.check("the apps list no longer shows it after a reload", !(await page.locator("body").innerText()).includes("Pocket Scanner Android"));
      });

      await step("web: Stripe provider, web config, web product", async () => {
        await go(`${B}/web`);
        await page.getByRole("button", { name: "Add web provider" }).first().click();
        const d = dialog("Add an app");
        await d.getByLabel("App name").fill("Pocket Scanner Web");
        await d.getByRole("button", { name: "Add app" }).click();
        await page.waitForURL(/\/apps\/app/);
        ids.stripeApp = page.url().split("/").pop()!.split("#")[0]!;
        const keySection = page.getByRole("region", { name: "Stripe account" });
        await keySection.getByLabel("Restricted key").fill(FAKE_STRIPE_KEY);
        await keySection.getByRole("button", { name: "Check credentials" }).click();
        await expect(keySection.getByText(/Valid credentials/)).toBeVisible();
        await page.getByRole("button", { name: "Save changes" }).click();
        await toast("Changes saved.");
        c.check("the credential check went to the capture server's fake Stripe, not stripe.com", ctx.capture.of("api.stripe.com").length > 0);
        await go(`${B}/web`);
        await page.locator(".step.next").getByRole("button", { name: "Add web config" }).click();
        const w = dialog("Web config");
        await w.getByLabel("App name").fill("Pocket Scanner");
        await w.getByLabel("Terms URL").fill("https://scanner.example/terms");
        await w.getByLabel("Privacy URL").fill("https://scanner.example/privacy");
        await w.getByLabel("Support email").fill("help@scanner.example");
        await w.getByLabel("Deep link scheme").fill("pocketscanner");
        await w.getByRole("button", { name: "Save web config" }).click();
        await toast("Web config saved.");
        c.has("v2 web config saved", await v2("GET", `/apps/${ids.stripeApp}/web_config`), { saved: true, app_name: "Pocket Scanner", app_scheme: "pocketscanner" });
        await page.locator(".step.next").getByRole("button", { name: "Create web product" }).click();
        const pd = dialog("Create web product");
        await pd.getByLabel("Name").fill("Web monthly");
        await pd.getByLabel("Price", { exact: true }).fill("7.99");
        await pd.getByLabel("Billing period").selectOption("P1M");
        await pd.getByRole("button", { name: "Create product" }).click();
        await toast("Web monthly created in Stripe.");
        const wp = (await v2("GET", `/apps/${ids.stripeApp}/web_products`)).items;
        c.check("v2 lists the web product with its Stripe price", wp.length === 1 && /price_/.test(JSON.stringify(wp[0])), wp);
        ids.webProduct = wp[0]?.product?.id;
      });

      await step("products: create, edit, archive and delete", async () => {
        await go(`${B}/product-catalog/products`);
        const newProduct = async (app: string, sid: string, type: string, duration: string | null, name: string) => {
          await page.getByRole("button", { name: "New product" }).first().click();
          await page.getByRole("menuitem", { name: "Create from scratch" }).click();
          const d = dialog("New product");
          await d.getByLabel("App", { exact: true }).selectOption({ label: app });
          await d.getByLabel("Store identifier").fill(sid);
          await d.getByRole("radio", { name: new RegExp(`^${type} `) }).locator("xpath=..").click();
          if (duration) await d.getByLabel("Duration").selectOption(duration);
          await d.getByLabel("Display name").fill(name);
          await d.getByRole("button", { name: "Create product" }).click();
          await expect(d).toBeHidden();
        };
        await newProduct("Pocket Scanner for iPhone (App Store)", "pocket.pro.monthly", "Subscription", "P1M", "Pocket Pro monthly");
        await toast("Product pocket.pro.monthly created");
        await newProduct("Pocket Scanner for iPhone (App Store)", "pocket.temp", "Non-consumable", null, "Temporary unlock");
        const prods = (await v2("GET", "/products?limit=100")).items;
        const pm = prods.find((p: any) => p.store_identifier === "pocket.pro.monthly");
        c.has("v2 product created with app, type and duration", pm, { app_id: ids.iosApp, type: "subscription", subscription: { duration: "P1M" }, display_name: "Pocket Pro monthly" });
        ids.iosProduct = pm?.id;
        await page.getByRole("button", { name: "Actions for pocket.pro.monthly" }).click();
        await page.getByRole("menuitem", { name: "Edit" }).click();
        await dialog("Edit product").getByLabel("Display name").fill("Pocket Pro (monthly)");
        await dialog("Edit product").getByRole("button", { name: "Save" }).click();
        await toast("Product saved");
        c.eq("v2 product renamed", (await v2("GET", `/products/${ids.iosProduct}`)).display_name, "Pocket Pro (monthly)");
        await page.reload(); await settle();
        await expect(page.getByText("Pocket Pro (monthly)").first()).toBeVisible();
        await page.getByRole("button", { name: "Actions for pocket.temp" }).click();
        await page.getByRole("menuitem", { name: "Archive" }).click();
        await toast("pocket.temp archived");
        c.eq("v2 product archived", (await v2("GET", "/products?limit=100")).items.find((p: any) => p.store_identifier === "pocket.temp")?.state, "inactive");
        await page.getByRole("button", { name: "All", exact: true }).click();
        await page.getByRole("button", { name: "Actions for pocket.temp" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this product?").getByRole("button", { name: "Delete product" }).click();
        await toast("pocket.temp deleted");
        const [gone] = await ctx.sql`SELECT count(*)::int AS n FROM products WHERE project_id = ${projectId} AND store_identifier = 'pocket.temp'`;
        c.eq("products row deleted (SQL)", gone!.n, 0);
      });

      await step("entitlements: create, edit, attach and detach products, delete", async () => {
        await go(`${B}/product-catalog/entitlements`);
        await page.getByRole("button", { name: "New entitlement" }).first().click();
        let d = dialog("New entitlement");
        await d.getByLabel("Identifier").fill("scanner_plus");
        await d.getByLabel("Display name").fill("Scanner Plus");
        await d.getByRole("button", { name: "Create entitlement" }).click();
        await expect(page.getByRole("heading", { name: "scanner_plus", exact: true })).toBeVisible();
        ids.entitlement = page.url().split("/").pop()!;
        await page.getByRole("button", { name: "Attach" }).click();
        d = dialog("Attach products to scanner_plus");
        await d.getByLabel(/pocket\.pro\.monthly/).check();
        await d.getByLabel(/pro_annual/).first().check();
        await d.getByRole("button", { name: /^Attach 2 products/ }).click();
        await toast("2 products attached to scanner_plus");
        let ent = await v2("GET", `/entitlements/${ids.entitlement}?expand=product`);
        c.eq("v2 entitlement has both products attached", ent.products.items.map((p: any) => p.store_identifier).sort(), ["pocket.pro.monthly", "pro_annual"]);
        await page.getByRole("button", { name: "Detach pro_annual" }).click();
        await dialog("Detach this product?").getByRole("button", { name: "Detach" }).click();
        await toast("pro_annual detached");
        ent = await v2("GET", `/entitlements/${ids.entitlement}?expand=product`);
        c.eq("v2 entitlement keeps one product after the detach", ent.products.items.map((p: any) => p.store_identifier), ["pocket.pro.monthly"]);
        await page.reload(); await settle();
        c.check("after a reload the page lists only the attached product", await page.getByRole("button", { name: "Detach pocket.pro.monthly" }).isVisible() && !(await page.getByRole("button", { name: "Detach pro_annual" }).isVisible()));
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await dialog("Edit entitlement").getByLabel("Display name").fill("Scanner Plus access");
        await dialog("Edit entitlement").getByRole("button", { name: "Save" }).click();
        await toast("Entitlement saved");
        c.eq("v2 entitlement renamed", (await v2("GET", `/entitlements/${ids.entitlement}`)).display_name, "Scanner Plus access");
        // A second one to delete.
        await go(`${B}/product-catalog/entitlements`);
        await page.getByRole("button", { name: "New entitlement" }).first().click();
        d = dialog("New entitlement");
        await d.getByLabel("Identifier").fill("temp_access");
        await d.getByLabel("Display name").fill("Temporary");
        await d.getByRole("button", { name: "Create entitlement" }).click();
        await expect(page.getByRole("heading", { name: "temp_access", exact: true })).toBeVisible();
        const tempId = page.url().split("/").pop()!;
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await dialog("Delete this entitlement?").getByRole("button", { name: "Delete entitlement" }).click();
        await page.waitForURL(/\/entitlements$/);
        c.eq("v2 answers 404 for the deleted entitlement", (await call("GET", `${P}/entitlements/${tempId}`)).status, 404);
      });

      const pkg = (n: number) => page.getByRole("region", { name: `Package ${n}` });
      await step("offerings: create with packages, edit, delete", async () => {
        await go(`${B}/product-catalog/offerings/new`);
        await page.getByLabel("Identifier", { exact: true }).fill("spring");
        await page.getByLabel("Display name").fill("Spring plans");
        await page.getByRole("button", { name: "Add package" }).click();
        await pkg(1).getByLabel("Identifier *").selectOption({ label: "Monthly" });
        await pkg(1).getByLabel("Product for Test Store").selectOption({ label: "Pro monthly · pro_monthly" });
        await pkg(1).getByLabel("Product for Pocket Scanner for iPhone").selectOption({ label: "Pocket Pro (monthly) · pocket.pro.monthly" });
        await page.getByRole("button", { name: "New package" }).click();
        await pkg(2).getByLabel("Identifier *").selectOption({ label: "Annual" });
        await pkg(2).getByLabel("Product for Test Store").selectOption({ label: "Pro yearly · pro_annual" });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await toast("Offering spring created");
        await expect(page.getByRole("heading", { name: "spring", exact: true })).toBeVisible();
        ids.offering = page.url().split("/").pop()!;
        let o = (await v2("GET", "/offerings?expand=items.package.product")).items.find((x: any) => x.lookup_key === "spring");
        c.check("v2 offering spring has the two packages with their products", o && o.packages.items.map((p: any) => p.lookup_key).join() === "$rc_monthly,$rc_annual" && o.packages.items[0].products.items.length === 2, o?.packages);
        await page.getByRole("link", { name: "Edit" }).click();
        await pkg(2).getByLabel("Description *").fill("Annual, best value");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await toast("Offering saved");
        o = (await v2("GET", "/offerings?expand=items.package.product")).items.find((x: any) => x.lookup_key === "spring");
        c.eq("v2 package description edited", o?.packages.items.find((p: any) => p.lookup_key === "$rc_annual")?.display_name, "Annual, best value");
        await page.reload(); await settle();
        await expect(page.getByText("Annual, best value").first()).toBeVisible();
        // The web offering for the funnel: one package with the Stripe product.
        await go(`${B}/product-catalog/offerings/new`);
        await page.getByLabel("Identifier", { exact: true }).fill("web");
        await page.getByLabel("Display name").fill("Go Pro on the web");
        await page.getByRole("button", { name: "Add package" }).click();
        await pkg(1).getByLabel("Identifier *").selectOption({ label: "Monthly" });
        await selectByText(pkg(1).getByLabel("Product for Pocket Scanner Web"), /Web monthly/);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await toast("Offering web created");
        // One to delete.
        await go(`${B}/product-catalog/offerings/new`);
        await page.getByLabel("Identifier", { exact: true }).fill("temp_sale");
        await page.getByLabel("Display name").fill("Temporary sale");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await toast("Offering temp_sale created");
        await go(`${B}/product-catalog/offerings`);
        await page.getByRole("button", { name: "Actions for temp_sale" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this offering?").getByRole("button", { name: "Delete offering" }).click();
        await toast("temp_sale deleted");
        c.check("v2 offerings no longer list temp_sale", !(await v2("GET", "/offerings?limit=100")).items.some((x: any) => x.lookup_key === "temp_sale"));
      });

      await step("virtual-currencies: create with a grant, edit, delete", async () => {
        await go(`${B}/product-catalog/virtual-currencies`);
        await page.getByRole("button", { name: "New currency" }).first().click();
        await page.getByLabel("Code").fill("GEM");
        await page.getByLabel("Name").fill("Gems");
        await page.getByRole("button", { name: "Add a grant" }).click();
        await page.getByLabel("Product 1", { exact: true }).selectOption({ label: "100 coins" });
        await page.getByLabel("Amount 1", { exact: true }).fill("100");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "GEM", exact: true })).toBeVisible();
        const vc = (await v2("GET", "/virtual_currencies")).items.find((x: any) => x.code === "GEM");
        c.check("v2 currency GEM with 100 per coins_100", vc && vc.name === "Gems" && JSON.stringify(vc.product_grants ?? vc).includes("100"), vc);
        await page.getByRole("button", { name: "Actions for GEM" }).click();
        await page.getByRole("menuitem", { name: "Edit" }).click();
        await page.getByLabel("Name").fill("Shiny gems");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "Shiny gems", exact: true })).toBeVisible();
        c.eq("v2 currency renamed", (await v2("GET", "/virtual_currencies")).items.find((x: any) => x.code === "GEM")?.name, "Shiny gems");
        await page.reload(); await settle();
        await expect(page.getByRole("cell", { name: "Shiny gems", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Actions for GEM" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.getByRole("button", { name: "Delete currency" }).click();
        await expect(page.getByText("No in-app currencies yet")).toBeVisible();
        c.eq("v2 lists no currencies after the delete", (await v2("GET", "/virtual_currencies")).items.length, 0);
      });

      await step("api-keys: create a secret key, use it, revoke it", async () => {
        await go(`${B}/api-keys`);
        await page.getByRole("button", { name: "New secret key" }).click();
        let d = dialog("New secret API key");
        await d.getByLabel("Name").fill("Journey backend");
        await d.getByRole("button", { name: "Create key" }).click();
        d = dialog("Copy your secret key now");
        const key = (await d.locator(".codeblock pre").first().textContent())!.trim();
        c.check("the secret key is shown once with the sk_ prefix", /^sk_/.test(key));
        await d.getByRole("button", { name: "I have copied it" }).click();
        const use = await fetch(`${ctx.base}${P}/apps`, { headers: { authorization: `Bearer ${key}` } });
        c.eq("the new key reads v2", use.status, 200);
        const [row] = await ctx.sql`SELECT count(*)::int AS n FROM api_keys WHERE project_id = ${projectId} AND name = 'Journey backend'`;
        c.eq("api_keys row stored (SQL)", row!.n, 1);
        await page.reload(); await settle();
        await expect(page.getByRole("row", { name: /Journey backend/ })).toBeVisible();
        await page.getByRole("button", { name: "Actions for Journey backend" }).click();
        await page.getByRole("menuitem", { name: "Revoke key" }).click();
        await dialog("Revoke Journey backend?").getByRole("button", { name: "Revoke key" }).click();
        await toast(/Journey backend revoked/);
        const after = await fetch(`${ctx.base}${P}/apps`, { headers: { authorization: `Bearer ${key}` } });
        c.eq("the revoked key answers 401", after.status, 401);
      });

      const hookUrl = `http://localhost:${PORTS.capture}/hooks/dashboard-ui`;
      await step("webhooks: create, test event, edit, delete", async () => {
        await go(`${B}/integrations/webhooks/new`);
        await page.getByLabel("Name").fill("Journey listener");
        await page.getByLabel("Webhook URL").fill(hookUrl);
        await page.getByRole("button", { name: "Add webhook" }).click();
        const d = dialog("Copy the signing secret now");
        c.check("signing secret shown once", /^whsec_/.test((await d.locator(".codeblock pre").first().textContent())!.trim()));
        await d.getByRole("button", { name: "I have copied it" }).click();
        await page.waitForURL(/\/integrations\/webhooks\/wh_/);
        ids.webhook = page.url().split("/").pop()!;
        c.has("v2 webhook stored", await v2("GET", `/integrations/webhooks/${ids.webhook}`), { name: "Journey listener", url: hookUrl });
        await page.getByRole("button", { name: "Send test event" }).click();
        await toast(/Test event queued/);
        const hit = await until(async () => ctx.capture.requests.find((r) => r.path === "/hooks/dashboard-ui"), { timeoutMs: 30_000 });
        c.check("the test event reached the capture server", hit && JSON.parse(hit.body).event?.type === "TEST", hit?.body?.slice(0, 200));
        await expect(page.getByRole("row", { name: /TEST.*delivered/i })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("link", { name: "Edit" }).click();
        await page.getByLabel("Name").fill("Journey listener (edited)");
        await page.getByRole("button", { name: "Save changes" }).click();
        await toast("Webhook saved.");
        c.eq("v2 webhook renamed", (await v2("GET", `/integrations/webhooks/${ids.webhook}`)).name, "Journey listener (edited)");
        await page.reload(); await settle();
        await expect(page.getByRole("heading", { name: "Journey listener (edited)" })).toBeVisible();
        // A second webhook, deleted.
        await go(`${B}/integrations/webhooks/new`);
        await page.getByLabel("Name").fill("Short-lived");
        await page.getByLabel("Webhook URL").fill(`http://localhost:${PORTS.capture}/hooks/short`);
        await page.getByRole("button", { name: "Add webhook" }).click();
        await dialog("Copy the signing secret now").getByRole("button", { name: "I have copied it" }).click();
        await page.waitForURL(/\/integrations\/webhooks\/wh_/);
        const tmp = page.url().split("/").pop()!;
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: "Delete webhook" }).click();
        await dialog(/Delete Short-lived/).getByRole("button", { name: "Delete webhook" }).click();
        await page.waitForURL(/\/integrations\/webhooks$/);
        c.eq("v2 answers 404 for the deleted webhook", (await call("GET", `${P}/integrations/webhooks/${tmp}`)).status, 404);
      });

      await step("partner-integration: Slack connect, test event, off, disconnect", async () => {
        await go(`${B}/integrations/slack`);
        await expect(page.getByRole("heading", { name: "Slack", exact: true })).toBeVisible();
        await page.getByLabel("Incoming webhook URL").fill("https://hooks.slack.com/services/T0JOURNEY/B0JOURNEY/madeupjourneytoken");
        await page.getByRole("group", { name: "Environment" }).getByRole("button", { name: "Both" }).click();
        await page.getByRole("button", { name: "Connect Slack" }).click();
        await expect(page.getByText("Slack is connected.")).toBeVisible();
        const s = (await v2("GET", "/integrations/partners")).items.find((x: any) => x.type === "slack");
        c.check("v2 Slack integration stored with the URL as a secret", s && s.enabled === true && s.secrets?.webhook_url?.configured === true && !JSON.stringify(s).includes("madeupjourneytoken"), s);
        const since = Date.now();
        await page.getByRole("button", { name: "Send test event" }).click();
        await dialog("Send a test event").getByRole("button", { name: "Send test event" }).click();
        const hit = await until(async () => ctx.capture.requests.find((r) => r.host === "hooks.slack.com" && r.at >= since), { timeoutMs: 30_000 });
        c.check("the Slack test message went to the capture server (hooks.slack.com never called)", hit && /test customer/i.test(hit.body), hit?.body?.slice(0, 200));
        await expect(page.getByRole("row", { name: /TEST.*delivered/ })).toBeVisible({ timeout: 45_000 });
        const statusRow = page.locator(".kv").filter({ hasText: "Integration ID" });
        c.check("the Status line says the test was delivered, without a reload", await expect(statusRow).toContainText("Delivered", { timeout: 20_000 }).then(() => true, () => false), await statusRow.innerText().catch(() => ""));
        await page.getByRole("switch", { name: "On" }).click();
        await expect(page.getByText(/Slack is off/).first()).toBeVisible();
        c.eq("v2 Slack integration turned off", (await v2("GET", "/integrations/partners")).items.find((x: any) => x.type === "slack")?.enabled, false);
        await page.reload(); await settle();
        await expect(page.getByText(/Slack is off/).first()).toBeVisible();
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: /Disconnect/ }).click();
        await dialog("Disconnect Slack?").getByRole("button", { name: "Disconnect" }).click();
        await toast("Slack disconnected.");
        await page.waitForURL(/\/integrations$/);
        await expect(page.getByRole("link", { name: /^Slack/ })).toContainText("Set up");
        c.eq("v2 lists no Slack integration after disconnecting", (await v2("GET", "/integrations/partners")).items.filter((x: any) => x.type === "slack").length, 0);
      });

      await step("data-export: create and delete", async () => {
        const make = async (name: string) => {
          await go(`${B}/integrations/exports/new`);
          await page.getByLabel("Name", { exact: true }).fill(name);
          await page.getByLabel("Bucket", { exact: true }).fill("journey-bucket");
          await page.getByLabel("Path prefix").fill("rd");
          await page.getByLabel("Endpoint").fill(`http://localhost:${PORTS.capture}`);
          await page.getByLabel("Access key ID").fill("AKIAJOURNEY");
          await page.getByLabel("Secret access key").fill("journey-secret-key");
          await page.getByRole("button", { name: "Create export" }).click();
          await expect(page.getByRole("heading", { name })).toBeVisible();
          return page.url().split("/").pop()!;
        };
        const tmp = await make("Warehouse (temporary)");
        const x = (await v2("GET", "/integrations/exports")).items.find((e: any) => e.id === tmp);
        c.check("v2 export stored without the secret", x && x.config.bucket === "journey-bucket" && !JSON.stringify(x).includes("journey-secret-key"), x);
        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: "Delete export" }).click();
        await dialog("Delete Warehouse (temporary)?").getByRole("button", { name: "Delete export" }).click();
        await page.waitForURL(/\/integrations\/exports$/);
        const [n] = await ctx.sql`SELECT count(*)::int AS n FROM export_jobs WHERE project_id = ${projectId}`;
        c.check("the export is gone (v2 and SQL)", !(await v2("GET", "/integrations/exports")).items.some((e: any) => e.id === tmp) && n!.n === 0, n);
        ids.export = await make("Nightly warehouse");
      });

      await step("paywalls: template, edit text, publish, unpublish, delete", async () => {
        const sdk = sdkClient(ctx, seed.testKey);
        await go(`${B}/paywalls/templates`);
        await page.getByRole("button", { name: "Use template Trial timeline" }).click();
        const d = dialog("Use “Trial timeline”");
        await d.getByLabel("Offering").selectOption(seed.offeringId);
        await d.getByLabel("Terms URL").fill("https://scanner.example/terms");
        await d.getByLabel("Privacy URL").fill("https://scanner.example/privacy");
        await d.getByRole("button", { name: "Create paywall" }).click();
        await page.waitForURL(/\/paywalls\/pw/);
        const pwId = page.url().split("/").pop()!;
        const phone = page.getByRole("figure", { name: "Paywall preview" });
        await phone.getByText("How your free trial works").click();
        await page.getByRole("region", { name: "Properties" }).getByRole("textbox").first().fill("Scan every page, free for a week");
        await expect(phone).toContainText("Scan every page, free for a week");
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByText(/^Published\. Apps get it/)).toBeVisible();
        const off = (await sdk.offerings("paywall_viewer")).body.offerings?.find((o: any) => o.identifier === "default");
        c.check("the SDK's default offering carries the published paywall with the edited text", off?.has_paywall_components === true && Object.values(off.paywall_components?.components_localizations?.en_US ?? {}).includes("Scan every page, free for a week"), off?.has_paywall_components);
        await page.reload(); await settle();
        await expect(page.getByRole("figure", { name: "Paywall preview" })).toContainText("Scan every page, free for a week");
        await page.getByRole("button", { name: "Paywall actions" }).click();
        await page.getByRole("menuitem", { name: "Unpublish" }).click();
        await dialog("Unpublish this paywall?").getByRole("button", { name: "Unpublish" }).click();
        await expect.poll(async () => (await v2("GET", `/paywalls/${pwId}`)).published_at ?? null).toBeNull();
        const off2 = (await sdk.offerings("paywall_viewer")).body.offerings?.find((o: any) => o.identifier === "default");
        c.eq("after unpublishing the SDK gets no paywall", off2?.has_paywall_components, false);
        await page.getByRole("button", { name: "Paywall actions" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this paywall?").getByRole("button", { name: "Delete paywall" }).click();
        await page.waitForURL(/\/paywalls$/);
        c.eq("v2 answers 404 for the deleted paywall", (await call("GET", `${P}/paywalls/${pwId}`)).status, 404);
        // One that stays, for the page sweep.
        await go(`${B}/paywalls/templates`);
        await page.getByRole("button", { name: "Use template Annual first" }).click();
        const d2 = dialog("Use “Annual first”");
        await d2.getByLabel("Offering").selectOption(ids.offering!);
        await d2.getByLabel("Terms URL").fill("https://scanner.example/terms");
        await d2.getByLabel("Privacy URL").fill("https://scanner.example/privacy");
        await d2.getByRole("button", { name: "Create paywall" }).click();
        await page.waitForURL(/\/paywalls\/pw/);
        ids.paywall = page.url().split("/").pop()!;
      });

      await step("targeting: audience, rule with a placement, turn on, edit, delete", async () => {
        const sdk = sdkClient(ctx, seed.testKey);
        await go(`${B}/targeting`);
        await page.getByRole("tab", { name: "Audiences" }).click();
        await page.getByRole("button", { name: "New audience" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Gold plan");
        await page.getByLabel("Field 1.1").selectOption("custom");
        await page.getByLabel("Attribute 1.1").fill("plan");
        await page.getByLabel("Operator 1.1").selectOption("is");
        await page.getByLabel("Value 1.1").fill("gold");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "Gold plan", exact: true })).toBeVisible();
        const aud = (await v2("GET", "/audiences")).items.find((a: any) => a.name === "Gold plan");
        c.eq("v2 audience rules", aud?.rules, { groups: [{ conditions: [{ field: "customAttribute:plan", operator: "is", value: "gold" }] }] });
        await page.getByRole("button", { name: "Actions for Gold plan" }).click();
        await page.getByRole("menuitem", { name: "Edit" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Gold plan customers");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "Gold plan customers", exact: true })).toBeVisible();
        c.check("v2 audience renamed", (await v2("GET", "/audiences")).items.some((a: any) => a.name === "Gold plan customers"));

        const gold = `gold_gina_${ctx.stamp}`;
        await sdk.customerInfo(gold);
        await call("POST", `${P}/customers/${gold}/attributes`, { attributes: [{ name: "plan", value: "gold" }] });
        await page.getByRole("tab", { name: "Rules" }).click();
        await page.getByRole("button", { name: "New rule" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Gold sees spring");
        await page.getByLabel("Audience").selectOption({ label: "Gold plan customers" });
        await page.getByLabel("Current offering").selectOption({ label: "Spring plans (spring)" });
        await page.getByRole("button", { name: "Add a placement" }).click();
        await page.getByLabel("Placement 1", { exact: true }).fill("onboarding_end");
        await page.getByLabel("Placement offering 1").selectOption({ label: "winback" });
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "Gold sees spring", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Actions for Gold sees spring" }).click();
        await page.getByRole("menuitem", { name: "Turn on" }).click();
        await expect(page.getByText("Live", { exact: true })).toBeVisible();
        const rule = (await v2("GET", "/targeting_rules")).items.find((r: any) => r.name === "Gold sees spring");
        c.has("v2 rule is live with its placement", rule, { state: "active", offering_id: ids.offering });
        const v = (await sdk.offerings(gold)).body;
        c.check("the SDK gives the gold customer the spring offering and the placement", v.current_offering_id === "spring" && v.placements?.offering_ids_by_placement?.onboarding_end === "winback", { current: v.current_offering_id, placements: v.placements });
        c.eq("another customer still gets the default offering", (await sdk.offerings("support_vip_1")).body.current_offering_id, "default");
        await page.getByRole("button", { name: "Actions for Gold sees spring" }).click();
        await page.getByRole("menuitem", { name: "Edit" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Gold customers see spring");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("cell", { name: "Gold customers see spring", exact: true })).toBeVisible();
        c.check("v2 rule renamed", (await v2("GET", "/targeting_rules")).items.some((r: any) => r.name === "Gold customers see spring"));
        await page.reload(); await settle();
        await expect(page.getByRole("cell", { name: "Gold customers see spring", exact: true })).toBeVisible();
        // A rule and an audience to delete.
        await page.getByRole("button", { name: "New rule" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Doomed rule");
        await page.getByRole("button", { name: "Save" }).click();
        await page.getByRole("button", { name: "Actions for Doomed rule" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this rule?").getByRole("button", { name: "Delete rule" }).click();
        await expect(page.getByRole("cell", { name: "Doomed rule", exact: true })).toHaveCount(0);
        c.check("v2 rule deleted", !(await v2("GET", "/targeting_rules")).items.some((r: any) => r.name === "Doomed rule"));
        await page.getByRole("tab", { name: "Audiences" }).click();
        await page.getByRole("button", { name: "New audience" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Doomed audience");
        await page.getByLabel("Field 1.1").selectOption("country");
        await page.getByLabel("Value 1.1").fill("FR");
        await page.getByRole("button", { name: "Save" }).click();
        await page.getByRole("button", { name: "Actions for Doomed audience" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this audience?").getByRole("button", { name: "Delete audience" }).click();
        await expect(page.getByRole("cell", { name: "Doomed audience", exact: true })).toHaveCount(0);
        c.check("v2 audience deleted", !(await v2("GET", "/audiences")).items.some((a: any) => a.name === "Doomed audience"));
      });

      await step("experiments: create, start, stop", async () => {
        await go(`${B}/experiments`);
        await page.getByRole("button", { name: "New experiment" }).click();
        await page.getByLabel("Name", { exact: true }).fill("Spring vs default");
        await page.getByLabel("Control (a)").selectOption({ label: "default" });
        await page.getByLabel("Treatment (b)").selectOption({ label: "spring" });
        await page.getByRole("button", { name: "Create" }).click();
        await page.waitForURL(/\/experiments\/prexp/);
        ids.experiment = page.url().split("/").pop()!;
        c.eq("v2 experiment created as a draft", (await v2("GET", `/experiments/${ids.experiment}`)).status, "draft");
        await page.getByRole("button", { name: "Start" }).click();
        await expect(page.getByText("Running", { exact: true })).toBeVisible();
        c.eq("v2 experiment running", (await v2("GET", `/experiments/${ids.experiment}`)).status, "running");
        const sdk = sdkClient(ctx, seed.testKey);
        for (let i = 0; i < 6; i++) { await sdk.customerInfo(`exp_${ctx.stamp}_${i}`); await sdk.offerings(`exp_${ctx.stamp}_${i}`); }
        await page.getByLabel("Environment").selectOption("sandbox");
        await expect(page.getByRole("cell", { name: /Control/ })).toBeVisible();
        const res = await v2("GET", `/experiments/${ids.experiment}/results?environment=sandbox`);
        c.check("results count the six enrolled customers", res.variants.items.reduce((s: number, x: any) => s + x.customers, 0) >= 6, res.variants);
        await page.getByRole("button", { name: "Stop" }).click();
        await dialog("Stop this experiment?").getByRole("button", { name: "Stop" }).click();
        await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
        c.eq("v2 experiment stopped", (await v2("GET", `/experiments/${ids.experiment}`)).status, "stopped");
        await page.reload(); await settle();
        await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
      });

      await step("customer-actions: grant, revoke, offering override, attribute", async () => {
        await go(`${B}/customers/${encodeURIComponent(named)}`);
        await expect(page.getByRole("heading", { name: named })).toBeVisible();
        await page.getByRole("button", { name: "Grant entitlement" }).click();
        const g = dialog("Grant an entitlement");
        await g.getByLabel("Entitlement").selectOption({ label: "No ads (ad_free)" });
        await g.getByText("1 week").click();
        await g.getByRole("button", { name: "Grant access" }).click();
        await toast(/Granted No ads until/);
        const sum = await v2("GET", `/customer_summaries?ids=${encodeURIComponent(named)}`);
        c.eq("v2 customer summary lists the granted entitlement", sum.items[0]?.granted_entitlements?.length, 1);
        const sdk = sdkClient(ctx, seed.testKey);
        c.check("the SDK's customer info has ad_free active", !!(await sdk.customerInfo(named)).body.subscriber?.entitlements?.ad_free);
        await page.reload(); await settle();
        await expect(page.getByText("Granted · expires")).toBeVisible();
        await page.getByRole("button", { name: "Revoke grant" }).click();
        await dialog("Revoke No ads?").getByRole("button", { name: "Revoke grant" }).click();
        await toast("Revoked the granted No ads.");
        const info = (await sdk.customerInfo(named)).body.subscriber?.entitlements?.ad_free;
        c.check("after revoking the SDK's ad_free entitlement has expired", !info || new Date(info.expires_date).getTime() <= Date.now() + 1000, info);
        await page.getByRole("button", { name: "More customer actions" }).click();
        await page.getByRole("menuitem", { name: "Offering override" }).click();
        await dialog("Offering override").getByLabel("Offering").selectOption({ label: "Spring plans (spring)" });
        await dialog("Offering override").getByRole("button", { name: "Save" }).click();
        await toast("This customer now sees Spring plans.");
        c.eq("the SDK's current offering for the customer is the override", (await sdk.offerings(named)).body.current_offering_id, "spring");
        await page.getByRole("button", { name: "Set →" }).click();
        const a = dialog("Set an attribute");
        await a.getByLabel("Name").fill("favourite_tool");
        await a.getByLabel("Value").fill("batch scan");
        await a.getByRole("button", { name: "Save" }).click();
        await toast("Saved favourite_tool.");
        const attrs = (await v2("GET", `/customers/${encodeURIComponent(named)}/attributes`)).items;
        c.check("v2 customer attribute favourite_tool = batch scan", attrs.some((x: any) => x.name === "favourite_tool" && x.value === "batch scan"), attrs);
        await page.reload(); await settle();
        await expect(page.locator("section.panel").filter({ has: page.locator(".ph b", { hasText: /^Attributes$/ }) })).toContainText("batch scan");
      });

      await step("saved-charts: save, reopen, remove", async () => {
        await go(`${B}/charts/revenue?range=90d&res=month`);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const d = dialog("Save this chart");
        await d.getByLabel("Name").fill("Quarterly revenue");
        await d.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("Chart saved")).toBeVisible();
        const saved = (await v2("GET", "/saved_charts")).items;
        c.check("v2 saved chart with its view", saved.length === 1 && saved[0].name === "Quarterly revenue" && saved[0].chart_name === "revenue" && saved[0].view?.range === "90d", saved);
        await go(`${B}/charts/mrr`);
        const rail = page.getByRole("complementary", { name: "Charts" });
        await rail.getByRole("link", { name: "Quarterly revenue" }).click();
        await expect(page).toHaveURL(/\/charts\/revenue\?.*range=90d/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quarterly revenue");
        await rail.getByRole("button", { name: "Remove saved chart Quarterly revenue" }).click();
        await expect(rail.getByRole("link", { name: "Quarterly revenue" })).toHaveCount(0);
        c.eq("v2 lists no saved charts after removing", (await v2("GET", "/saved_charts")).items.length, 0);
      });

      await step("customer-lists: filter, save audience, CSV export", async () => {
        await go(`${B}/customers`);
        const rail = page.getByRole("navigation", { name: "Customer lists" });
        await rail.getByRole("button", { name: "Active subscribers" }).click();
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await page.getByRole("button", { name: "Add a condition" }).click();
        await page.getByLabel("Field 1.1").selectOption("country");
        await page.getByLabel("Operator 1.1").selectOption("is");
        await page.getByLabel("Value 1.1").fill("US");
        await page.getByRole("button", { name: "Apply filter" }).click();
        await expect(page.getByTestId("filter-count")).toHaveText("1");
        await page.getByRole("button", { name: "Save audience" }).click();
        const sd = dialog("Save audience");
        await sd.getByLabel("Name").fill("Active in the US");
        await sd.getByRole("button", { name: "Save audience" }).click();
        await toast('Audience "Active in the US" saved');
        const aud = (await v2("GET", "/audiences")).items.find((a: any) => a.name === "Active in the US");
        c.eq("v2 audience from the customer list", aud?.rules, { groups: [{ conditions: [{ field: "status", operator: "isAnyOf", value: "active,trialing" }, { field: "country", operator: "is", value: "US" }] }] });
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export all" }).click()]);
        const csv = readFileSync((await download.path())!, "utf8").split("\r\n").filter(Boolean);
        const list = await v2("GET", `/customer_lists?list=${aud.id}&limit=1`);
        c.check("the CSV download has the header and one row per customer in the audience", csv[0]?.startsWith("app_user_id,email,subscription_status") && csv.length - 1 === list.summary.customers, { header: csv[0], rows: csv.length - 1, customers: list.summary.customers, file: download.suggestedFilename() });
        await page.reload(); await settle();
        await expect(rail.getByRole("button", { name: "Active in the US" })).toBeVisible();
      });

      await step("win-back: create, test email, start, edit, delete", async () => {
        await go(`${B}/lifecycle/winback/new`);
        await page.getByLabel("Name", { exact: true }).fill("Lapsed scanners");
        await page.getByLabel("Subject").fill("Come back to Pocket Scanner");
        await page.getByRole("button", { name: "Save draft" }).click();
        await toast("Campaign saved as a draft");
        await expect(page).toHaveURL(/\/winback\/wbc_/);
        ids.winback = page.url().split("/").pop()!;
        c.has("v2 campaign saved as a draft", await v2("GET", `/winback_campaigns/${ids.winback}`), { name: "Lapsed scanners", status: "draft", email: { subject: "Come back to Pocket Scanner" } });
        await page.getByRole("button", { name: "Send test" }).click();
        await dialog("Send a test email").getByLabel("Send to").fill("winback-check@journeys.test");
        await dialog("Send a test email").getByRole("button", { name: "Send test" }).click();
        await toast("Test email sent to winback-check@journeys.test");
        const mail = await until(async () => ctx.mails.find((m) => m.to.includes("winback-check@journeys.test")));
        c.eq("the test email arrived over SMTP", mail?.subject, "[Test] Come back to Pocket Scanner");
        await page.getByRole("button", { name: "Start" }).click();
        await toast(/Campaign started/);
        c.eq("v2 campaign active", (await v2("GET", `/winback_campaigns/${ids.winback}`)).status, "active");
        await page.getByLabel("Subject").fill("We kept your scans for you");
        await page.getByRole("button", { name: /^Save/ }).first().click();
        await toast(/saved/i);
        c.eq("v2 campaign subject edited", (await v2("GET", `/winback_campaigns/${ids.winback}`)).email.subject, "We kept your scans for you");
        await page.reload(); await settle();
        c.eq("the editor shows the saved subject after a reload", await page.getByLabel("Subject").inputValue(), "We kept your scans for you");
        // A draft to delete.
        await go(`${B}/lifecycle/winback/new`);
        await page.getByLabel("Name", { exact: true }).fill("Doomed campaign");
        await page.getByRole("button", { name: "Save draft" }).click();
        await toast("Campaign saved as a draft");
        await expect(page).toHaveURL(/\/winback\/wbc_/);
        const tmp = page.url().split("/").pop()!;
        await page.getByRole("button", { name: /Delete/ }).first().click();
        await dialog("Delete this campaign?").getByRole("button", { name: "Delete campaign" }).click();
        await page.waitForURL(/\/winback$/);
        c.eq("v2 answers 404 for the deleted campaign", (await call("GET", `${P}/winback_campaigns/${tmp}`)).status, 404);
      });

      await step("refund-control: add a policy and save", async () => {
        await go(`${B}/lifecycle/refund-control`);
        await page.getByRole("button", { name: "Add policy: Recent renewal" }).click();
        const items = await page.locator(".policy-list > li").count();
        await page.getByLabel("Refund preference for Recent renewal").selectOption({ label: "Prefer full refund" });
        const unsaved = page.getByRole("region", { name: "Unsaved changes" });
        await unsaved.getByRole("button", { name: "Save" }).click();
        await toast("Refund policies saved");
        const saved = await v2("GET", "/refund_control");
        const pol = saved.policies.find((p: any) => p.name === "Recent renewal");
        c.has("v2 refund policy saved", pol, { template: "recent_renewal", preference: "prefer_refund" });
        await page.reload(); await settle();
        c.eq("the policy is there after a reload", await page.getByLabel("Refund preference for Recent renewal").inputValue(), "prefer_refund");
        c.check("policy list kept its length", await page.locator(".policy-list > li").count() === items, items);
        await page.getByRole("button", { name: "Delete Recent renewal" }).click();
        await unsaved.getByRole("button", { name: "Save" }).click();
        await toast("Refund policies saved");
        c.check("v2 refund policy deleted", !(await v2("GET", "/refund_control")).policies.some((p: any) => p.name === "Recent renewal"));
      });

      await step("retention: Apple message, Customer Center offer", async () => {
        await go(`${B}/lifecycle/retention`);
        await page.getByRole("button", { name: "New message" }).click();
        const md = dialog("New message");
        await md.getByLabel("Header").fill("Before you go");
        await md.getByLabel("Body").fill("Keep unlimited scans synced across your devices.");
        await md.getByRole("button", { name: "Add message" }).click();
        await toast("Message added");
        const rm = await v2("GET", `/apps/${ids.iosApp}/retention_messaging`);
        c.check("v2 retention message stored for the App Store app", rm.messages?.length === 1 && rm.messages[0].header === "Before you go", rm.messages);
        await page.getByRole("tab", { name: "Customer Center" }).click();
        await page.getByRole("button", { name: "New offer: Cancellation Retention Discount" }).click();
        const od = dialog("New cancellation offer");
        await od.getByLabel("Name", { exact: true }).fill("Monthly saver");
        await od.getByLabel("Product 1", { exact: true }).selectOption("pocket.pro.monthly");
        await od.getByLabel("Offer ID 1").fill("monthly_50off");
        await od.getByRole("button", { name: "Create offer" }).click();
        await toast("Offer created");
        const offer = (await v2("GET", "/retention_offers")).items.find((o: any) => o.name === "Monthly saver");
        c.has("v2 retention offer", offer, { trigger: "cancel", store: "app_store", product_mapping: { "pocket.pro.monthly": "monthly_50off" }, active: true });
        await page.getByRole("row").filter({ hasText: "Monthly saver" }).getByRole("switch").click();
        await toast("Monthly saver is off");
        c.eq("v2 offer turned off", (await v2("GET", "/retention_offers")).items.find((o: any) => o.name === "Monthly saver")?.active, false);
        await page.reload(); await settle();
        await expect(page.getByRole("row").filter({ hasText: "Monthly saver" })).toBeVisible();
        await page.getByRole("button", { name: "Actions for Monthly saver" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete this offer?").getByRole("button", { name: "Delete offer" }).click();
        await expect(page.getByRole("row").filter({ hasText: "Monthly saver" })).toHaveCount(0);
        c.check("v2 offer deleted", !(await v2("GET", "/retention_offers")).items.some((o: any) => o.name === "Monthly saver"));
      });

      await step("funnel: create, edit a step, publish", async () => {
        await go(`${B}/funnels`);
        await page.getByRole("button", { name: "Create web funnel" }).click();
        await page.getByRole("menuitem", { name: "Start from the starter funnel" }).click();
        const d = dialog("New funnel from the starter");
        await d.getByLabel("Name").fill("Scanner quiz");
        await d.getByRole("button", { name: "Create funnel" }).click();
        await page.waitForURL(/\/funnels\/fnl_/);
        ids.funnel = page.url().split("/").pop()!.split("?")[0]!;
        const steps = page.getByRole("region", { name: "Steps" });
        const props = page.getByRole("region", { name: "Properties" });
        const preview = page.frameLocator('iframe[title="Funnel preview"]');
        await props.getByLabel("Title", { exact: true }).fill("What do you scan most?");
        await expect(preview.getByRole("heading", { name: "What do you scan most?" })).toBeVisible();
        await steps.locator(".fb-pick", { hasText: "Unlock your full plan" }).click();
        await props.getByLabel("Offering").selectOption("web");
        await page.getByRole("button", { name: "Save draft" }).click();
        await toast("Draft saved.");
        let f = await v2("GET", `/funnels/${ids.funnel}`);
        c.eq("v2 funnel draft has the edited first step", f.draft?.steps?.[0]?.title, "What do you scan most?");
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await toast("Published. The public page shows this version now.");
        f = await v2("GET", `/funnels/${ids.funnel}`);
        c.has("v2 funnel published", f, { status: "published", problems: [] });
        const pub = await fetch(f.url);
        c.check("the public funnel page answers 200 with the edited question", pub.status === 200 && (await pub.text()).includes("What do you scan most?"), { status: pub.status, url: f.url });
        await page.reload(); await settle();
        await expect(page.locator(".pe-meta .tag").first()).toHaveText(/published/i);
      });

      await step("web-discount: create and delete", async () => {
        await go(`${B}/web-discounts`);
        await page.getByRole("button", { name: "Create discount" }).first().click();
        const d = dialog("Create discount");
        await d.getByLabel("Name").fill("Autumn sale");
        await d.getByLabel("Percent off").fill("25");
        await d.getByLabel("Codes").fill("AUTUMN25");
        await d.getByRole("button", { name: "Create discount" }).click();
        await toast("Discount created with 1 code.");
        const disc = (await v2("GET", "/discounts")).items.find((x: any) => x.identifier === "autumn_sale");
        c.has("v2 discount", disc, { type: "percentage", percentage: 25 });
        const ext = (await v2("GET", "/web_discounts")).items.find((x: any) => x.identifier === "autumn_sale");
        c.check("the discount is a coupon in the (fake) Stripe account", !!ext?.stripe?.[0]?.coupon_id, ext?.stripe);
        await page.reload(); await settle();
        const row = page.getByRole("table", { name: "Discounts" }).locator("tbody tr").filter({ hasText: "Autumn sale" });
        await expect(row).toContainText("AUTUMN25");
        await row.getByRole("button", { name: /Actions for/ }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await dialog("Delete Autumn sale?").getByRole("button", { name: "Delete discount" }).click();
        await expect(page.getByRole("table", { name: "Discounts" }).locator("tbody tr").filter({ hasText: "Autumn sale" })).toHaveCount(0);
        c.check("v2 discount deleted", !(await v2("GET", "/discounts")).items.some((x: any) => x.identifier === "autumn_sale"));
      });

      let inviteLink = "";
      await step("members: invite, accept, change role, remove, revoke", async () => {
        const mate = `mate-${ctx.stamp}@journeys.test`;
        const other = `other-${ctx.stamp}@journeys.test`;
        await go(`${B}/settings/collaborators`);
        const invite = async (to: string, role: string) => {
          await page.getByRole("button", { name: "Invite", exact: true }).click();
          const d = dialog("Invite to this project");
          await d.getByLabel("Email").fill(to);
          await d.getByLabel("Role").selectOption({ label: role });
          await d.getByRole("button", { name: "Send invite" }).click();
          await toast(`Invite sent to ${to}.`);
        };
        await invite(mate, "Developer");
        await invite(other, "Viewer");
        const inv = (await v2("GET", "/invites")).items;
        c.check("v2 lists both invites with their roles", inv.some((i: any) => i.email === mate && i.role === "developer") && inv.some((i: any) => i.email === other && i.role === "viewer"), inv);
        const mail = await until(async () => ctx.mails.find((m) => m.to.includes(mate)));
        inviteLink = linksOf(mail!).find((l) => /\/invite\?/.test(l)) ?? "";
        c.check("the invite email links to this server's invite page", inviteLink.startsWith(ctx.base), linksOf(mail!));
        // The teammate accepts in their own browser.
        const mcx = await newContext();
        const mp = await mcx.newPage();
        await mp.goto(inviteLink);
        const projectName = (await v2("GET", "")).name;
        await expect(mp.getByRole("heading", { name: `Join ${projectName}` })).toBeVisible();
        await mp.getByLabel("Your name").fill("Mo Mate");
        await mp.getByLabel("Password").fill(`mate-${ctx.stamp}-pw`);
        await mp.getByRole("button", { name: "Create account and join" }).click();
        await mp.waitForURL(new RegExp(`/projects/${projectId}/overview`));
        await mcx.close();
        const [mm] = await ctx.sql`SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${mate} AND m.project_id = ${projectId}`;
        c.eq("the teammate is a developer member (SQL)", mm?.role, "developer");
        await page.reload(); await settle();
        const members = page.locator("section.panel").filter({ hasText: "Members" });
        await members.getByLabel(`Role of ${mate}`).selectOption("viewer");
        await toast("Mo Mate is now a viewer.");
        const [vr] = await ctx.sql`SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${mate} AND m.project_id = ${projectId}`;
        c.eq("the membership role is now viewer (SQL)", vr?.role, "viewer");
        c.eq("v2 collaborators show the viewer as read_only", (await v2("GET", "/collaborators")).items.find((x: any) => x.email === mate)?.role, "read_only");
        await page.getByRole("button", { name: `Actions for the invite to ${other}` }).click();
        await page.getByRole("menuitem", { name: "Revoke invite" }).click();
        await dialog(`Revoke the invite for ${other}?`).getByRole("button", { name: "Revoke invite" }).click();
        await toast(`Invite for ${other} revoked.`);
        c.check("v2 invite revoked", !(await v2("GET", "/invites")).items.some((i: any) => i.email === other && i.status === "pending"));
        await page.getByRole("button", { name: `Actions for ${mate}` }).click();
        await page.getByRole("menuitem", { name: "Remove from project" }).click();
        await dialog("Remove Mo Mate?").getByRole("button", { name: "Remove" }).click();
        await toast(`${mate} was removed.`);
        const [left] = await ctx.sql`SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${mate} AND m.project_id = ${projectId}`;
        c.eq("the membership row is gone (SQL)", left!.n, 0);
        await page.reload(); await settle();
        await expect(members.getByRole("row", { name: new RegExp(mate) })).toHaveCount(0);
      });

      // ---------- 3b. edge cases: invites while signed in as someone else, roles, validation, new features, empty states ----------
      let devCookie = "", viewerCookie = "";
      const devEmail = `existing-${ctx.stamp}@journeys.test`, devPw = `existing-${ctx.stamp}-pw`;
      const viewerEmail = `fresh-${ctx.stamp}@journeys.test`, viewerPw = `fresh-${ctx.stamp}-pw`;
      /** A browser where the owner is signed in with a session of its own (signing out there must not end the main one). */
      const ownerContext = async () => {
        const ocx = await newContext();
        const r = await ocx.request.post(`${ctx.base}/auth/login`, { data: { email, password } });
        if (!r.ok()) throw new Error(`owner sign-in: ${r.status()}`);
        return ocx;
      };
      const asCookie = async (cxx: BrowserContext) => `rd_session=${(await cxx.cookies()).find((k) => k.name === "rd_session")?.value ?? ""}`;
      const contextWith = async (ck: string) => { const x = await newContext(); await x.addCookies([{ name: "rd_session", value: ck.split("=")[1]!, url: ctx.base }]); return x; };
      const inviteLinkFor = async (to: string) => {
        const m = await until(async () => [...ctx.mails].reverse().find((x) => x.to.includes(to) && linksOf(x).some((l) => /\/invite\?/.test(l))));
        return m ? linksOf(m).find((l) => /\/invite\?/.test(l))! : "";
      };

      await step("invite-flow: an invite opened while signed in as someone else", async () => {
        const projectName = (await v2("GET", "")).name;
        // A person who already has an account is invited as a Developer.
        const su = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: devEmail, password: devPw, name: "Eve Existing", project_name: "Eve's app" }) });
        c.eq("the invited person already has an account (sign-up 201)", su.status, 201);
        await v2("POST", "/invites", { email: devEmail, role: "developer" });
        const link = await inviteLinkFor(devEmail);
        c.must("the invite email arrived with a link", link);
        const ocx = await ownerContext();
        const op = await ocx.newPage();
        await op.goto(link); await op.waitForLoadState("networkidle").catch(() => {});
        await expect(op.getByText(`You are signed in as ${email}. This invite is for ${devEmail}.`)).toBeVisible();
        await op.getByRole("button", { name: `Sign in as ${devEmail}` }).click();
        await op.waitForURL(/\/login\?next=.*email=/, { timeout: 15_000 });
        c.eq("the sign-in form is filled in with the invited address", await op.getByLabel("Email", { exact: true }).inputValue(), devEmail);
        await op.getByLabel("Password").fill(devPw);
        await op.getByRole("button", { name: "Sign in" }).click();
        await op.waitForURL(/\/invite\?/, { timeout: 15_000 });
        await expect(op.getByRole("heading", { name: `Join ${projectName}` })).toBeVisible();
        await op.getByRole("button", { name: "Accept invite" }).click();
        await op.waitForURL(new RegExp(`/projects/${projectId}/overview`), { timeout: 15_000 });
        const [m] = await ctx.sql`SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${devEmail} AND m.project_id = ${projectId}`;
        c.eq("SQL: the existing account joined as a developer", m?.role, "developer");
        devCookie = await asCookie(ocx);
        c.eq("the owner's own session still works", (await call("GET", "/auth/me")).status, 200);
        await ocx.close();

        // A person with no account yet: switching accounts goes straight to the invite's sign-up form.
        await v2("POST", "/invites", { email: viewerEmail, role: "viewer" });
        const link2 = await inviteLinkFor(viewerEmail);
        const ocx2 = await ownerContext();
        const op2 = await ocx2.newPage();
        await op2.goto(link2); await op2.waitForLoadState("networkidle").catch(() => {});
        await op2.getByRole("button", { name: `Sign in as ${viewerEmail}` }).click();
        await op2.waitForURL(/\/invite\?/, { timeout: 15_000 });
        await expect(op2.getByRole("button", { name: "Create account and join" })).toBeVisible();
        c.check("signed out, the invite page offers the sign-up form for the invited address", (await op2.locator("body").innerText()).includes(viewerEmail));
        await op2.getByLabel("Your name").fill("Vic Viewer");
        await op2.getByLabel("Password").fill(viewerPw);
        await op2.getByRole("button", { name: "Create account and join" }).click();
        await op2.waitForURL(new RegExp(`/projects/${projectId}/overview`), { timeout: 15_000 });
        const [vm] = await ctx.sql`SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${viewerEmail} AND m.project_id = ${projectId}`;
        c.eq("SQL: the new account joined as a viewer", vm?.role, "viewer");
        viewerCookie = await asCookie(ocx2);
        await ocx2.close();
      });

      await step("roles: a Viewer and a Developer are refused what their role does not allow, and told why", async () => {
        const DENIED = /does not allow this|Only project admins/;
        // Viewer: reads every page, every write is refused with the reason.
        allow(/^POST \/v2\/projects\/[^/]+\/products$/, 403);
        allow(/^POST \/v2\/projects\/[^/]+\/customers\/[^/]+\/actions\/grant_entitlement$/, 403);
        allow(/^POST \/v2\/projects\/[^/]+\/invites$/, 403);
        allow(/^POST \/v2\/projects\/[^/]+\/api_keys$/, 403);
        const vcx = await contextWith(viewerCookie);
        const vp = await vcx.newPage();
        await vp.goto(`${ctx.base}${B}/overview`); await vp.waitForLoadState("networkidle").catch(() => {});
        await expect(vp.getByRole("heading", { name: "Overview" })).toBeVisible();
        await vp.goto(`${ctx.base}${B}/product-catalog/products`); await vp.waitForLoadState("networkidle").catch(() => {});
        await vp.getByRole("button", { name: "New product" }).first().click();
        await vp.getByRole("menuitem", { name: "Create from scratch" }).click();
        let d = vp.getByRole("dialog", { name: "New product" });
        await d.getByLabel("App", { exact: true }).selectOption({ label: "Pocket Scanner for iPhone (App Store)" });
        await d.getByLabel("Store identifier").fill("viewer.try");
        await d.getByRole("radio", { name: /^Non-consumable / }).locator("xpath=..").click();
        await d.getByRole("button", { name: "Create product" }).click();
        await expect(d.getByRole("alert").filter({ hasText: DENIED })).toBeVisible();
        c.check("Viewer: New product is refused with the reason in the dialog, nothing created", !(await v2("GET", "/products?limit=100")).items.some((p: any) => p.store_identifier === "viewer.try"));
        await vp.keyboard.press("Escape");
        const grants0 = (await v2("GET", `/customer_summaries?ids=${encodeURIComponent(named)}`)).items[0]?.granted_entitlements?.length ?? 0;
        await vp.goto(`${ctx.base}${B}/customers/${encodeURIComponent(named)}`); await vp.waitForLoadState("networkidle").catch(() => {});
        await vp.getByRole("button", { name: "Grant entitlement" }).click();
        d = vp.getByRole("dialog", { name: "Grant an entitlement" });
        await d.getByLabel("Entitlement").selectOption({ label: "No ads (ad_free)" });
        await d.getByRole("button", { name: "Grant access" }).click();
        await expect(d.getByRole("alert").filter({ hasText: DENIED })).toBeVisible();
        c.eq("Viewer: Grant entitlement is refused, no grant stored", (await v2("GET", `/customer_summaries?ids=${encodeURIComponent(named)}`)).items[0]?.granted_entitlements?.length ?? 0, grants0);
        await vp.keyboard.press("Escape");
        await vp.goto(`${ctx.base}${B}/settings/collaborators`); await vp.waitForLoadState("networkidle").catch(() => {});
        const vInvite = vp.getByRole("button", { name: "Invite", exact: true });
        c.check("Viewer: Invite is disabled and says only admins can invite", await vInvite.isDisabled() && (await vInvite.getAttribute("title")) === "Only admins can invite people");
        await vcx.close();

        // Developer: changes the catalog, but cannot make secret API keys or manage people.
        const dcx = await contextWith(devCookie);
        const dp = await dcx.newPage();
        await dp.goto(`${ctx.base}${B}/api-keys`); await dp.waitForLoadState("networkidle").catch(() => {});
        await dp.getByRole("button", { name: "New secret key" }).click();
        d = dp.getByRole("dialog", { name: "New secret API key" });
        await d.getByLabel("Name").fill("Developer try");
        await d.getByRole("button", { name: "Create key" }).click();
        await expect(d.getByRole("alert").filter({ hasText: DENIED })).toBeVisible();
        const [kk] = await ctx.sql`SELECT count(*)::int AS n FROM api_keys WHERE project_id = ${projectId} AND name = 'Developer try'`;
        c.eq("Developer: New secret key is refused with the reason, no key stored (SQL)", kk!.n, 0);
        await dp.keyboard.press("Escape");
        await dp.goto(`${ctx.base}${B}/settings/collaborators`); await dp.waitForLoadState("networkidle").catch(() => {});
        const dInvite = dp.getByRole("button", { name: "Invite", exact: true });
        c.check("Developer: Invite is disabled and says only admins can invite", await dInvite.isDisabled() && (await dInvite.getAttribute("title")) === "Only admins can invite people");
        // The server refuses it too, whatever the page shows.
        const dInv = await fetch(`${ctx.base}${P}/invites`, { method: "POST", headers: { cookie: devCookie, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ email: `devnope-${ctx.stamp}@journeys.test`, role: "viewer" }) });
        c.eq("Developer: POST /invites answers 403 (only admins manage people)", dInv.status, 403);
        await dp.goto(`${ctx.base}${B}/product-catalog/entitlements`); await dp.waitForLoadState("networkidle").catch(() => {});
        await dp.getByRole("button", { name: "New entitlement" }).first().click();
        d = dp.getByRole("dialog", { name: "New entitlement" });
        await d.getByLabel("Identifier").fill("dev_made");
        await d.getByLabel("Display name").fill("Made by a developer");
        await d.getByRole("button", { name: "Create entitlement" }).click();
        await expect(d).toBeHidden();
        const made = (await v2("GET", "/entitlements?limit=100")).items.find((e: any) => e.lookup_key === "dev_made");
        c.check("Developer: New entitlement works (v2)", !!made, made);
        if (made) await v2("DELETE", `/entitlements/${made.id}`);
        await dcx.close();
      });

      await step("validation: forms refuse bad input and say what to fix", async () => {
        allow(/^POST \/v2\/projects\/[^/]+\/products$/, 409);
        allow(/^POST \/v2\/projects\/[^/]+\/entitlements$/, 409);
        const before = (await v2("GET", "/products?limit=100")).items.length;
        await go(`${B}/product-catalog/products`);
        await page.getByRole("button", { name: "New product" }).first().click();
        await page.getByRole("menuitem", { name: "Create from scratch" }).click();
        let d = dialog("New product");
        await d.getByLabel("App", { exact: true }).selectOption({ label: "Pocket Scanner for iPhone (App Store)" });
        await d.getByRole("button", { name: "Create product" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Enter the product's identifier in the store." })).toBeVisible();
        await d.getByLabel("Store identifier").fill("has space");
        await d.getByRole("button", { name: "Create product" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Store identifiers cannot contain spaces." })).toBeVisible();
        await d.getByLabel("Store identifier").fill("pocket.pro.monthly");
        await d.getByRole("radio", { name: /^Subscription / }).locator("xpath=..").click();
        await d.getByLabel("Duration").selectOption("P1M");
        await d.getByRole("button", { name: "Create product" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "already has a product with this identifier" })).toBeVisible();
        await d.getByRole("button", { name: "Cancel" }).click();
        c.eq("products: an empty, a spaced and a duplicate identifier each named the problem; nothing was created", (await v2("GET", "/products?limit=100")).items.length, before);
        await go(`${B}/product-catalog/entitlements`);
        await page.getByRole("button", { name: "New entitlement" }).first().click();
        d = dialog("New entitlement");
        await d.getByLabel("Identifier").fill("pro");
        await d.getByRole("button", { name: "Create entitlement" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Enter a display name" })).toBeVisible();
        await d.getByLabel("Display name").fill("Pro again");
        await d.getByRole("button", { name: "Create entitlement" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "An entitlement with this identifier already exists." })).toBeVisible();
        await d.getByRole("button", { name: "Cancel" }).click();
        c.eq("entitlements: a missing name and a taken identifier were refused; one pro entitlement", (await v2("GET", "/entitlements?limit=100")).items.filter((e: any) => e.lookup_key === "pro").length, 1);
        const hooks0 = (await v2("GET", "/integrations/webhooks")).items.length;
        await go(`${B}/integrations/webhooks/new`);
        await page.getByLabel("Webhook URL").fill("not a url");
        await page.getByRole("button", { name: "Add webhook" }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Name the webhook" })).toBeVisible();
        await expect(page.getByRole("alert").filter({ hasText: "Enter the full URL of your endpoint" })).toBeVisible();
        c.eq("webhooks: a missing name and a bad URL were refused, nothing saved", (await v2("GET", "/integrations/webhooks")).items.length, hooks0);
        await go(`${B}/settings/collaborators`);
        await page.getByRole("button", { name: "Invite", exact: true }).click();
        d = dialog("Invite to this project");
        await d.getByLabel("Email").fill("not-an-email");
        await d.getByRole("button", { name: "Send invite" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Enter a valid email address." })).toBeVisible();
        await d.getByRole("button", { name: "Cancel" }).click();
        await go("/projects/new");
        await page.getByRole("button", { name: "Create project" }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Give the project a name." })).toBeVisible();
        c.check("invite and new project: an invalid email and an empty name were refused with the reason", true);
      });

      await step("customer-page: the current offering matches the SDK, and currency balances adjust", async () => {
        allow(/^POST \/v2\/projects\/[^/]+\/customers\/[^/]+\/virtual_currencies\/transactions$/, 400);
        allow(/^POST \/v2\/projects\/[^/]+\/customers\/[^/]+\/virtual_currencies\/transactions$/, 409);
        allow(/^POST \/v2\/projects\/[^/]+\/customers\/[^/]+\/virtual_currencies\/transactions$/, 422);
        const sdk = sdkClient(ctx, seed.testKey);
        for (const who of [named, "support_vip_1", "renewing_reader"]) {
          await go(`${B}/customers/${encodeURIComponent(who)}`);
          const panel = page.locator("section.panel").filter({ has: page.locator(".ph b", { hasText: /^Current offering$/ }) });
          await panel.locator(".erow").first().waitFor({ timeout: 15_000 });
          const shown = (await panel.locator(".erow .mono").first().innerText()).trim();
          const label = (await panel.locator(".erow .tag").first().innerText()).trim();
          const sdkCurrent = (await sdk.offerings(who)).body.current_offering_id;
          c.eq(`${who}: the customer page's current offering (${label}) is the one the SDK serves`, shown, sdkCurrent);
        }
        await v2("POST", "/virtual_currencies", { code: "GLD", name: "Gold" });
        await go(`${B}/customers/${encodeURIComponent(named)}`);
        const vc = page.locator("section.panel").filter({ has: page.locator(".ph b", { hasText: /^In-app currencies$/ }) });
        await expect(vc).toContainText("Gold");
        await vc.getByRole("button", { name: "Adjust →" }).click();
        const d = dialog("Adjust a balance");
        await d.getByLabel("Amount").fill("0");
        await d.getByRole("button", { name: "Save" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Enter a whole number other than 0" })).toBeVisible();
        await d.getByLabel("Amount").fill("-5");
        await d.getByRole("button", { name: "Save" }).click();
        await expect(d.getByRole("alert").filter({ hasText: /below zero/ })).toBeVisible();
        await d.getByLabel("Amount").fill("25");
        await d.getByRole("button", { name: "Save" }).click();
        await toast("Credited 25 GLD. New balance: 25.");
        await expect(vc).toContainText("25");
        const bal = (await v2("GET", `/customers/${encodeURIComponent(named)}/virtual_currencies`)).items.find((b: any) => b.currency_code === "GLD");
        c.eq("v2 balance after the credit", bal?.balance, 25);
        const sdkVc = await sdk.call("GET", `/v1/subscribers/${encodeURIComponent(named)}/virtual_currencies`);
        c.eq("the SDK's balance after the credit", sdkVc.body?.virtual_currencies?.GLD?.balance, 25);
        await vc.getByRole("button", { name: "Adjust →" }).click();
        await dialog("Adjust a balance").getByLabel("Amount").fill("-10");
        await dialog("Adjust a balance").getByRole("button", { name: "Save" }).click();
        await toast("Debited 10 GLD. New balance: 15.");
        await page.reload(); await settle();
        await expect(vc).toContainText("15");
        c.eq("v2 balance after the debit, and after a reload the page shows it", (await v2("GET", `/customers/${encodeURIComponent(named)}/virtual_currencies`)).items.find((b: any) => b.currency_code === "GLD")?.balance, 15);
      });

      await step("ads-rewards: reward rules added, edited, reordered, switched off and deleted; a test reward granted, in the browser", async () => {
        const rules = async () => (await v2("GET", "/ads/reward_rules")).items as any[];
        await go(`${B}/ads/rewards`);
        await expect(page.getByText("No reward rules yet")).toBeVisible();
        await page.getByRole("button", { name: "Add your first rule" }).click();
        let d = dialog("New reward rule");
        await d.getByRole("button", { name: "Add rule" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Name the rule." })).toBeVisible();
        await d.getByLabel("Name").fill("Gold for level ends");
        await d.getByLabel("Currency").selectOption("GLD");
        await d.getByLabel("Amount per reward").fill("5");
        await d.getByRole("button", { name: "Add rule" }).click();
        await toast(/Rule added/);
        await page.getByRole("button", { name: "New rule" }).click();
        d = dialog("New reward rule");
        await d.getByLabel("Name").fill("Day pass");
        await d.getByRole("group", { name: "Grant" }).getByRole("button", { name: "Temporary access" }).click();
        await d.getByLabel("Entitlement").selectOption("ad_free");
        await d.getByRole("button", { name: "Add rule" }).click();
        await expect(dialog("New reward rule")).toBeHidden();
        await expect.poll(async () => (await rules()).length).toBe(2);
        let r = await rules();
        c.check("v2: two rules in the order they were added (currency 5 GLD, then a day of ad_free)", r.length === 2 && r[0].name === "Gold for level ends" && r[0].kind === "virtual_currency" && r[0].amount === 5 && r[0].currency_code === "GLD" && r[1].name === "Day pass" && r[1].kind === "entitlement" && r[1].duration_minutes === 1440, r.map((x) => ({ n: x.name, k: x.kind, a: x.amount, m: x.duration_minutes })));
        await page.getByRole("button", { name: "Move Day pass up" }).click();
        await expect.poll(async () => (await rules()).map((x) => x.name)).toEqual(["Day pass", "Gold for level ends"]);
        await page.getByRole("button", { name: "Edit Gold for level ends" }).click();
        d = dialog("Edit reward rule");
        await d.getByLabel("Amount per reward").fill("7");
        await d.getByRole("button", { name: "Save rule" }).click();
        await toast("Rule saved.");
        c.eq("v2: the edited amount", (await rules()).find((x) => x.name === "Gold for level ends")?.amount, 7);
        // The test reward runs the rules: Day pass is first and matches any reward.
        await page.getByRole("button", { name: "Send a test reward" }).click();
        d = dialog("Send a test reward");
        await d.getByRole("button", { name: "Send test reward" }).click();
        await expect(d.getByRole("alert").filter({ hasText: "Enter the app user ID" })).toBeVisible();
        await d.getByLabel("App user ID").fill(named);
        await d.getByRole("button", { name: "Send test reward" }).click();
        await toast(new RegExp(`Granted .* to ${named.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}\\.`));
        const sdk = sdkClient(ctx, seed.testKey);
        c.check("the SDK's customer info has ad_free from the Day pass rule", !!(await sdk.customerInfo(named)).body.subscriber?.entitlements?.ad_free);
        await expect(page.getByRole("row").filter({ hasText: named }).first()).toBeVisible();
        await page.getByRole("listitem").filter({ hasText: "Day pass" }).getByRole("switch").click();
        await expect.poll(async () => (await rules()).find((x) => x.name === "Day pass")?.enabled).toBe(false);
        await page.getByRole("button", { name: "Delete Day pass" }).click();
        await dialog("Delete Day pass?").getByRole("button", { name: "Delete rule" }).click();
        await toast("Rule deleted.");
        r = await rules();
        c.check("v2: Day pass switched off, then deleted; Gold for level ends stays", r.length === 1 && r[0].name === "Gold for level ends", r.map((x) => x.name));
        await page.reload(); await settle();
        await expect(page.getByRole("list", { name: "Reward rules in priority order" })).toContainText("Gold for level ends");
      });

      await step("store-import: products made in Stripe's dashboard imported in the browser (fake Stripe)", async () => {
        // A product with a monthly and a yearly price, made "in Stripe's dashboard" (the capture server's Stripe account).
        const st = ctx.capture.stripe;
        const sid = ctx.stamp.slice(-8);
        const now = Math.floor(Date.now() / 1000);
        const prodId = `prod_plus_${sid}`, m = `price_plus_m_${sid}`, y = `price_plus_y_${sid}`;
        st.products.set(prodId, { id: prodId, object: "product", active: true, created: now, livemode: false, name: "Pocket Scanner Plus", description: null, metadata: {}, default_price: y });
        for (const [id, amount, interval] of [[m, 499, "month"], [y, 3999, "year"]] as const) {
          st.prices.set(id, { id, object: "price", active: true, created: now, livemode: false, currency: "usd", product: prodId, unit_amount: amount, type: "recurring", lookup_key: null, metadata: {}, billing_scheme: "per_unit", recurring: { interval, interval_count: 1, trial_period_days: null, usage_type: "licensed" } });
        }
        // The dialog opens on the first app, the App Store app with no App Store Connect key: the server answers 422 and the
        // dialog says what is missing.
        allow(/^GET \/v2\/projects\/[^/]+\/apps\/[^/]+\/store_products$/, 422);
        await go(`${B}/product-catalog/products`);
        await page.getByRole("button", { name: "Import products", exact: true }).click();
        const d = page.getByRole("dialog", { name: /Import products/ });
        await expect(d.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
        c.check("an app without store credentials explains what to add", /key|credential|service account/i.test(await d.getByRole("alert").first().innerText()), await d.getByRole("alert").first().innerText());
        await selectByText(d.getByLabel("App", { exact: true }), /Pocket Scanner Web/);
        await expect(d.getByRole("row", { name: new RegExp(m) })).toBeVisible({ timeout: 20_000 });
        await d.getByPlaceholder("Search store products").fill("Plus");
        await expect(d.locator("tbody tr")).toHaveCount(2);
        await d.getByLabel("Select all").check();
        await d.getByRole("button", { name: "Import 2 products" }).click();
        await expect(d.getByText("Imported 2 products from Stripe.")).toBeVisible();
        await d.getByRole("button", { name: "Done" }).click();
        await expect(d).toBeHidden();
        const prods = (await v2("GET", `/products?app_id=${ids.stripeApp}&limit=100`)).items as any[];
        const pm = prods.find((p) => p.store_identifier === m), py = prods.find((p) => p.store_identifier === y);
        c.check("v2: both Stripe prices are subscription products of the Stripe app, monthly and yearly", pm?.type === "subscription" && pm.subscription?.duration === "P1M" && py?.type === "subscription" && py.subscription?.duration === "P1Y", { pm, py });
        await page.getByRole("button", { name: "Import products", exact: true }).click();
        await selectByText(d.getByLabel("App", { exact: true }), /Pocket Scanner Web/);
        await expect(d.getByRole("row", { name: new RegExp(m) })).toContainText("In catalog");
        c.check("opened again, the imported prices show In catalog and cannot be picked", await d.getByLabel(`Select ${m}`).isDisabled());
        await d.getByRole("button", { name: "Cancel" }).click();
      });

      await step("customer-center: the editor saves what the SDK receives, refuses bad values, and resets", async () => {
        allow(/^(PUT|POST|PATCH) \/v2\/projects\/[^/]+\/customer_center_config$/, 422);
        allow(/^(PUT|POST|PATCH) \/v2\/projects\/[^/]+\/customer_center_config$/, 400);
        const sdk = sdkClient(ctx, seed.testKey);
        const cc = async () => (await sdk.call("GET", `/v1/customercenter/${encodeURIComponent(named)}`)).body?.customer_center;
        await go(`${B}/lifecycle/customer-center`);
        await expect(page.getByRole("heading", { name: "Customer Center", exact: true })).toBeVisible();
        const active = page.getByRole("region", { name: "Customers with active subscriptions" });
        const list = active.getByRole("list", { name: /paths in order/ });
        const titles = async () => (await list.locator(".cc-path-b b").allInnerTexts()).map((t) => t.trim());
        const before = await titles();
        await active.getByRole("button", { name: "Add path" }).click();
        await page.getByRole("menuitem", { name: "Custom URL" }).click();
        await page.getByLabel("Button text", { exact: true }).fill("Help center");
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("alert").first()).toContainText("needs a full URL");
        await page.getByLabel("URL", { exact: true }).fill("javascript:alert(1)");
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByRole("alert").first()).toContainText(/url/i);
        await page.getByLabel("URL", { exact: true }).fill("https://scanner.example/help");
        await page.getByRole("tab", { name: "Appearance" }).click();
        await page.locator("#cc-light-accent_color").fill("#F4A9");
        await expect(page.getByText("Use a hex colour such as #1A1A1A.")).toBeVisible();
        await page.locator("#cc-light-accent_color").fill("#F4A900");
        await expect(page.getByText("Use a hex colour such as #1A1A1A.")).toHaveCount(0);
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Customer Center saved")).toBeVisible();
        const saved = await cc();
        const help = saved?.screens?.MANAGEMENT?.paths?.find((p: any) => p.title === "Help center");
        c.has("the SDK's Customer Center has the Help center path", help, { type: "CUSTOM_URL", url: "https://scanner.example/help" });
        c.eq("the SDK's Customer Center has the accent colour", saved?.appearance?.light?.accent_color, "#F4A900");
        await page.reload(); await settle();
        await page.getByRole("tab", { name: "Configuration" }).click();
        await expect.poll(titles).toEqual([...before, "Help center"]);
        await page.getByRole("button", { name: "Reset configuration" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Reset configuration" }).click();
        await expect(page.getByText("Customer Center reset to the default")).toBeVisible();
        const reset = await cc();
        c.check("after Reset the SDK gets the default paths and no accent", !reset?.screens?.MANAGEMENT?.paths?.some((p: any) => p.title === "Help center") && !reset?.appearance?.light?.accent_color, reset?.appearance);
      });

      await step("support: ticket settings from the form, an SDK ticket opened, closed and reopened in the browser", async () => {
        const SUP = `help-${ctx.stamp}@scanner-support.test`;
        const msg = `The scan export button does nothing (${ctx.stamp}).`;
        await go(`${B}/lifecycle/support?tab=customer_center`);
        await page.getByLabel("Support email").fill("not-an-address");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Enter the email address tickets should go to." })).toBeVisible();
        await page.getByLabel("Support email").fill(SUP);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await toast("Support settings saved");
        const cfg = await v2("GET", "/customer_center_config");
        c.eq("v2: tickets go to the saved support address", cfg.config?.support?.email ?? cfg.customer_center?.support?.email, SUP);
        const sdk = sdkClient(ctx, seed.testKey);
        const mail0 = ctx.mails.length;
        const tk = await sdk.call("POST", "/v1/customercenter/support/create-ticket", { app_user_id: named, customer_email: `buyer-${ctx.stamp}@example.com`, issue_description: msg });
        c.check("the SDK's create-ticket is accepted (sent: true)", tk.status === 200 && tk.body?.sent === true, tk.body);
        c.must("the ticket was emailed to the support address (SMTP)", await until(async () => ctx.mails.slice(mail0).find((m) => m.to.includes(SUP))));
        await go(`${B}/lifecycle/support?tab=tickets`);
        const row = page.getByRole("row").filter({ hasText: msg });
        await expect(row).toBeVisible();
        await row.getByText(msg).click();
        await expect(page.getByLabel("Full message")).toHaveText(msg);
        await page.getByRole("button", { name: "Close ticket" }).click();
        await toast("Ticket closed");
        const st = async () => (await ctx.sql`SELECT status FROM support_tickets WHERE project_id = ${projectId} AND description = ${msg}`)[0]?.status;
        c.eq("SQL: Close ticket closed it", await st(), "closed");
        await page.getByRole("button", { name: "Reopen ticket" }).click();
        await toast("Ticket reopened");
        c.eq("SQL: Reopen ticket opened it again", await st(), "open");
      });

      await step("empty-states: a new project made through the UI shows empty states, and deleting it through the UI", async () => {
        await go("/projects/new");
        await page.getByLabel("Project name").fill("Empty shelf");
        await page.getByRole("button", { name: "Create project" }).click();
        await page.waitForURL(/\/projects\/[^/]+\/overview/, { timeout: 15_000 });
        const np = /\/projects\/([^/]+)\//.exec(page.url())![1]!;
        c.check("the new project opens on its Overview", np !== projectId, np);
        const [prow] = await ctx.sql`SELECT p.name, m.role FROM projects p JOIN memberships m ON m.project_id = p.id JOIN users u ON u.id = m.user_id WHERE p.id = ${np} AND u.email = ${email}`;
        c.eq("SQL: the project and an admin membership exist", prow && { name: prow.name, role: prow.role }, { name: "Empty shelf", role: "admin" });
        const NB = `/projects/${np}`;
        const lists = ["customers", "product-catalog/offerings", "product-catalog/products", "product-catalog/entitlements", "product-catalog/virtual-currencies", "paywalls", "targeting", "experiments", "funnels", "apps", "integrations/webhooks", "integrations/exports", "lifecycle/winback", "web-discounts", "lifecycle/support?tab=tickets"];
        const noEmpty: string[] = [];
        const broken: unknown[] = [];
        for (const l of [ "overview", ...lists]) {
          await go(`${NB}/${l}`);
          await page.waitForTimeout(200);
          const body = await page.locator("body").innerText();
          const h1 = (await page.locator("h1").first().innerText({ timeout: 5000 }).catch(() => "")).trim();
          const err = await page.locator(".banner.err").count();
          const bad = /Could not load|could not be loaded|Something went wrong/i;
          if (!h1 || err || bad.test(body) || /loading…/i.test(body)) broken.push({ l, h1, err, error: bad.exec(body)?.[0] });
          if (l !== "overview" && !(await page.locator(".empty, .pw-empty, .wb-empty").count())) noEmpty.push(l);
        }
        c.check("every page of the empty project opens with its heading, no error and no endless loading", broken.length === 0, broken);
        c.check("every list page of the empty project says it is empty and what to do", noEmpty.length === 0, noEmpty);
        await go(`${NB}/settings`);
        await page.getByRole("button", { name: "Delete project" }).first().click();
        const dd = dialog("Delete Empty shelf?");
        c.check("Delete stays disabled until the name is typed", await dd.getByRole("button", { name: "Delete project" }).isDisabled());
        await dd.getByLabel("Type Empty shelf to confirm").fill("Empty shelf");
        await dd.getByRole("button", { name: "Delete project" }).click();
        await toast("Empty shelf deleted.");
        await page.waitForURL(/\/projects\/[^/]+\/overview/, { timeout: 15_000 });
        c.eq("SQL: the project is gone", (await ctx.sql`SELECT count(*)::int AS n FROM projects WHERE id = ${np}`)[0]!.n, 0);
        c.check("the dashboard returns to the remaining project", page.url().includes(`${B}/overview`), page.url());
      });

      await step("account: change name and alert emails", async () => {
        await go("/account");
        await expect(page.getByRole("heading", { name: "Account settings" })).toBeVisible();
        await page.getByLabel("Your name").fill("Dana D. Dashboard");
        await page.getByRole("button", { name: "Save" }).click();
        await toast("Name saved.");
        const sw = page.getByRole("switch", { name: "Email me about problems with my projects" });
        await sw.click();
        await toast("Alert emails are off.");
        const me = (await call("GET", "/auth/me")).body;
        c.has("/auth/me has the new name and alert emails off", me.user, { name: "Dana D. Dashboard", alert_emails: false });
        await page.reload(); await settle();
        c.check("after a reload the page shows both", await page.getByLabel("Your name").inputValue() === "Dana D. Dashboard" && await sw.getAttribute("aria-checked") === "false");
        await sw.click();
        await toast("Alert emails are on.");
      });

      // ---------- 4. every page, signed in, desktop, light ----------
      const integrationTypes: string[] = (await v2("GET", "/integrations/catalog")).items.map((t: any) => t.type);
      await go(`${B}/charts`);
      const chartHrefs: string[] = await page.getByRole("complementary", { name: "Charts" }).getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")!)).catch(() => []);
      /** A page: its h1 (or, for the editors, which have none, the document title) and data that must be on it. */
      interface R { path: string; h1?: string | RegExp; title?: string; texts?: string[]; ready?: string }
      const routes: R[] = [
        { path: `${B}/overview`, h1: "Overview", texts: ["Recent transactions"], ready: '[aria-label="Key metrics"]:not([aria-busy=true])' },
        ...chartHrefs.map((h) => ({ path: h, h1: /\S/, ready: ".cpanel:not([aria-busy])" })),
        { path: `${B}/customers`, h1: "Customers", texts: ["support_vip_1", "Active subscribers"] },
        { path: `${B}/customers/support_vip_1`, h1: "support_vip_1", texts: ["Priya (support)", "pro"] },
        { path: `${B}/customers/refunded_rafa`, h1: "refunded_rafa", texts: ["Pro yearly", "Was issued a refund", "rafa@example.com"] },
        { path: `${B}/customers/renewing_reader`, h1: "renewing_reader", texts: ["Pro monthly", "Renewed", "$29.97"] },
        { path: `${B}/customers/trial_tom`, h1: "trial_tom", texts: ["Started a trial"] },
        { path: `${B}/product-catalog/offerings`, h1: "Offerings", texts: ["default", "spring", "winback"] },
        { path: `${B}/product-catalog/offerings/new`, h1: "New offering" },
        { path: `${B}/product-catalog/offerings/${seed.offeringId}`, h1: "default", texts: ["$rc_monthly", "pro_monthly"] },
        { path: `${B}/product-catalog/offerings/${seed.offeringId}/edit`, h1: /default/, texts: ["Packages", "Weekly", "Monthly"] },
        { path: `${B}/product-catalog/products`, h1: "Products", texts: ["pro_monthly", "pocket.pro.monthly", "coins_100"] },
        { path: `${B}/product-catalog/products/${(await v2("GET", "/products?limit=100")).items.find((p: any) => p.store_identifier === "pro_monthly").id}`, h1: "Pro monthly", texts: ["pro_monthly", "pro"] },
        { path: `${B}/product-catalog/entitlements`, h1: "Entitlements", texts: ["pro", "ad_free", "scanner_plus"] },
        { path: `${B}/product-catalog/entitlements/${seed.entitlementId}`, h1: "pro", texts: ["pro_monthly", "lifetime"] },
        { path: `${B}/product-catalog/virtual-currencies`, h1: "In-app currencies" },
        { path: `${B}/web-discounts`, h1: "Web discounts" },
        { path: `${B}/paywalls`, h1: "Paywalls", texts: ["spring"] },
        { path: `${B}/paywalls/templates`, h1: "Select template", texts: ["Trial timeline"] },
        { path: `${B}/paywalls/${ids.paywall}`, title: "Annual first · Spring plans", texts: ["Layers", "Unlock Pocket Scanner Pro", "Annual, best value"] },
        { path: `${B}/targeting`, h1: "Targeting", texts: ["Gold customers see spring"] },
        { path: `${B}/experiments`, h1: "Experiments", texts: ["Spring vs default"] },
        { path: `${B}/experiments/${ids.experiment}`, h1: "Spring vs default", texts: ["Stopped", "Control"] },
        { path: `${B}/funnels`, h1: "Funnels and Purchase Links", texts: ["Scanner quiz"] },
        { path: `${B}/funnels/${ids.funnel}`, title: "Scanner quiz", texts: ["What do you scan most?", "Ready to publish"] },
        { path: `${B}/funnels/${ids.funnel}?tab=analytics`, title: "Scanner quiz", texts: ["Views", "1. What do you scan most?"] },
        { path: `${B}/web`, h1: "Web", texts: ["Pocket Scanner Web"] },
        { path: `${B}/ads`, h1: /Ads/ },
        { path: `${B}/ads/rewards`, h1: "Rewards" },
        { path: `${B}/lifecycle/customer-center`, h1: "Customer Center" },
        { path: `${B}/lifecycle/support`, h1: "Support", texts: ["Zendesk"] },
        { path: `${B}/lifecycle/support?tab=tickets`, h1: "Support" },
        { path: `${B}/lifecycle/retention`, h1: "Retention Offers", texts: ["Before you go"] },
        { path: `${B}/lifecycle/retention?tab=customer_center`, h1: "Retention Offers" },
        { path: `${B}/lifecycle/refund-control`, h1: "Refund Control" },
        { path: `${B}/lifecycle/winback`, h1: /Win-back/, texts: ["Lapsed scanners"] },
        { path: `${B}/lifecycle/winback/new`, h1: /./ },
        { path: `${B}/lifecycle/winback/${ids.winback}`, h1: /./, texts: ["We kept your scans for you"] },
        { path: `${B}/benchmarks`, h1: "Benchmarks" },
        { path: `${B}/ai`, h1: /\S/ },
        { path: "/projects/new", h1: "Create a project" },
        { path: `${B}/apps`, h1: "Apps", texts: ["Pocket Scanner for iPhone", "Test Store", "Pocket Scanner Web"] },
        { path: `${B}/apps/${ids.iosApp}`, h1: "Pocket Scanner for iPhone", texts: ["App Store", "In-app purchase key"] },
        { path: `${B}/apps/${seed.appId}`, h1: /Test Store/, texts: ["Send a test purchase"] },
        { path: `${B}/apps/${ids.stripeApp}`, h1: "Pocket Scanner Web" },
        { path: `${B}/api-keys`, h1: "API keys", texts: ["test_"] },
        { path: `${B}/integrations`, h1: "Integrations", texts: ["Webhooks", "Slack"] },
        { path: `${B}/integrations/webhooks`, h1: "Webhooks", texts: ["Journey listener (edited)"] },
        { path: `${B}/integrations/webhooks/new`, h1: "New webhook" },
        { path: `${B}/integrations/webhooks/${ids.webhook}`, h1: "Journey listener (edited)", texts: ["TEST"] },
        { path: `${B}/integrations/webhooks/${ids.webhook}/edit`, h1: /Edit Journey listener/ },
        { path: `${B}/integrations/exports`, h1: "Scheduled data exports", texts: ["Nightly warehouse"] },
        { path: `${B}/integrations/exports/new`, h1: "New data export" },
        { path: `${B}/integrations/exports/${ids.export}`, h1: "Nightly warehouse", texts: ["journey-bucket"] },
        { path: `${B}/integrations/admob`, h1: "Google AdMob" },
        { path: `${B}/integrations/zendesk`, h1: "Zendesk" },
        ...integrationTypes.filter((t) => !["admob", "zendesk"].includes(t)).map((t) => ({ path: `${B}/integrations/${t}`, h1: /\S/ })),
        { path: `${B}/settings`, h1: "Project settings", texts: [projectId] },
        { path: `${B}/settings/collaborators`, h1: "Project settings", texts: [email] },
        { path: `${B}/settings/audit-logs`, h1: "Project settings", texts: ["Dashboard user", "Funnel created", "Collaborator updated"] },
        { path: `${B}/settings/domains`, h1: "Project settings" },
        { path: `${B}/settings/ai`, h1: "Project settings" },
        { path: "/account", h1: "Account settings", texts: [email] },
      ];
      const visit = async (r: R) => {
        await page.goto(ctx.base + r.path);
        await settle();
        if (r.ready) await page.locator(r.ready).first().waitFor({ timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(150);
      };
      const ERR = /Could not load|could not be loaded|Something went wrong/i;
      await step("pages: every route, desktop, light", async () => {
        await go("/");
        c.check("/ opens the signed-in person's project", page.url().endsWith(`${B}/overview`), page.url());
        c.check(`the chart rail lists every chart (${chartHrefs.length})`, chartHrefs.length >= 40, chartHrefs.length);
        for (const r of routes) {
          await visit(r);
          const h1 = (await page.locator("h1").first().innerText({ timeout: r.h1 ? 10_000 : 1000 }).catch(() => "")).trim();
          const title = (await page.title()).replace(/ · RevenueDot$/, "");
          const body = (await page.locator("body").innerText()).toLowerCase();
          const missing = (r.texts ?? []).filter((t) => !body.includes(t.toLowerCase()));
          const errBanner = await page.locator(".banner.err").count();
          const notFound = await page.locator(".empty h3").filter({ hasText: /does not exist|not found|No integration called/i }).count();
          const okH1 = r.h1 === undefined ? true : typeof r.h1 === "string" ? h1 === r.h1 || h1.startsWith(r.h1) : r.h1.test(h1);
          const okTitle = r.title === undefined || title === r.title;
          c.check(`${r.path.replace(B, "") || "/"} shows "${(h1 || title).slice(0, 40)}" and its data`, okH1 && okTitle && !missing.length && !errBanner && !notFound && !ERR.test(body) && !/loading…/.test(body),
            { h1, title, want: String(r.h1 ?? r.title), missing, errBanner, notFound, error: ERR.exec(body)?.[0], loading: /loading…/.test(body) });
        }
      });

      // ---------- 5. dark mode and phone width ----------
      const layout = async (label: string, dir: string | null, list: R[] = routes) => {
        const bad: unknown[] = [];
        const lowContrast: unknown[] = [];
        let checked = 0;
        for (const r of list) {
          await visit(r);
          const o = await page.evaluate(() => {
            const s = document.querySelector(".scroll");
            return { doc: document.scrollingElement!.scrollWidth - window.innerWidth, inner: s ? s.scrollWidth - s.clientWidth : 0 };
          });
          if (o.doc > 1 || o.inner > 1) bad.push({ path: r.path.replace(B, ""), ...o });
          const k = await page.evaluate(contrastProbe, 400);
          checked += k.checked;
          if (k.bad.length) lowContrast.push({ path: r.path.replace(B, ""), bad: k.bad.slice(0, 4) });
          if (dir) await page.screenshot({ path: join(shots(dir), `${slug(r.path.replace(B, "") || "home")}.png`) });
        }
        c.check(`${label}: no page scrolls sideways (document or the app's scroll area)`, bad.length === 0, bad.slice(0, 10));
        c.check(`${label}: text contrast meets WCAG AA on every page (${checked} text elements)`, lowContrast.length === 0, lowContrast.slice(0, 8));
      };

      await step("theme: the in-app switch turns the dashboard dark", async () => {
        await go(`${B}/overview`);
        const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await page.getByRole("button", { name: "Toggle light and dark" }).click();
        c.eq("the switch sets data-theme=dark", await page.evaluate(() => document.documentElement.dataset.theme), "dark");
        const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        c.check("the page background turns #0A0A0A", bg0 === "rgb(255, 255, 255)" && bg1 === "rgb(10, 10, 10)", { bg0, bg1 });
        await page.reload(); await settle();
        c.eq("the choice is kept after a reload", await page.evaluate(() => document.documentElement.dataset.theme), "dark");
        await page.screenshot({ path: join(shots("desktop-dark"), "overview.png") });
      });
      await step("desktop-dark: every page, in-app dark theme", async () => { await layout("desktop dark", "desktop-dark"); });
      await step("theme: switch back to light", async () => {
        await go(`${B}/overview`);
        await page.getByRole("button", { name: "Toggle light and dark" }).click();
        c.eq("data-theme=light", await page.evaluate(() => document.documentElement.dataset.theme), "light");
        c.eq("white background again", await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(255, 255, 255)");
        await page.evaluate(() => { try { localStorage.removeItem("rd-theme"); } catch { /* */ } delete document.documentElement.dataset.theme; });
      });
      await step("desktop-light: contrast on every page", async () => { await layout("desktop light", null); });
      await page.setViewportSize(PHONE);
      await step("phone-light: every page at 375x812", async () => { await layout("phone light", "phone-light"); });
      await page.emulateMedia({ colorScheme: "dark" });
      await step("phone-dark: every page at 375x812, prefers-color-scheme dark", async () => {
        await go(`${B}/overview`);
        c.eq("the system dark preference darkens the page without the switch", await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(10, 10, 10)");
        await layout("phone dark", "phone-dark");
      });
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize(DESKTOP);

      // ---------- 6. sign out; the signed-out pages with real tokens ----------
      await step("signed-out: sign out, deep link, reset password, used invite", async () => {
        await go(`${B}/overview`);
        // Sign out once the Overview has loaded (requests still in flight when the session ends answer 401).
        await page.locator('[aria-label="Key metrics"]:not([aria-busy=true])').waitFor();
        await page.locator("svg.sp").first().waitFor();
        await settle();
        await page.getByRole("button", { name: (await v2("GET", "")).name }).first().click();
        await page.getByRole("menuitem", { name: "Sign out" }).click();
        await page.waitForURL(/\/login/);
        c.eq("signing out ends the session", (await call("GET", "/auth/me")).status, 401);
        await go(`${B}/customers`);
        c.check("a project page sends a signed-out visitor to sign in and back", /\/login\?next=/.test(page.url()), page.url());
        await go(`/forgot-password?email=${encodeURIComponent(email)}`);
        await page.getByRole("button", { name: "Send reset link" }).click();
        await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
        const resetMail = await until(async () => ctx.mails.find((m) => m.to.includes(email) && /reset|password/i.test(m.subject)));
        const rlink = resetMail ? linksOf(resetMail).find((l) => /reset-password/.test(l)) : undefined;
        c.must("the reset email arrived with a link", rlink);
        await page.goto(rlink!); await settle();
        await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
        c.check("/reset-password names the account", (await page.locator("body").innerText()).includes(email));
        await page.getByLabel("New password", { exact: true }).fill(`${password}-2`);
        await page.getByLabel("Repeat the new password").fill(`${password}-2`);
        await page.getByRole("button", { name: "Set password and sign in" }).click();
        await page.waitForURL(/\/projects\/[^/]+\/overview/);
        cookie = await cookieOf();
        c.eq("the new password signs in", (await fetch(`${ctx.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: `${password}-2` }) })).status, 200);
        // The signed-out pages at phone width, light and dark.
        const signedOut: R[] = [{ path: "/login", h1: "Sign in to RevenueDot" }, { path: "/signup", h1: "Create your account" }, { path: "/forgot-password", h1: "Reset your password" }];
        // The journey ends this session through the API, not the UI: leave the dashboard first, or the Overview the reset
        // just opened is still loading and its requests answer 401 (the journey's doing, not the dashboard's).
        await page.goto("about:blank");
        await page.request.post(`${ctx.base}/auth/logout`);
        await cx.clearCookies();
        await page.setViewportSize(PHONE);
        await layout("signed-out pages, phone light", "phone-light", signedOut);
        await page.emulateMedia({ colorScheme: "dark" });
        await layout("signed-out pages, phone dark", "phone-dark", signedOut);
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize(DESKTOP);
        // A used invite link says so.
        allow(/GET \/auth\/invites\//, 404); allow(/GET \/auth\/invites\//, 410); allow(/GET \/auth\/invites\//, 400);
        const ocx = await newContext();
        const op = await ocx.newPage();
        await op.goto(inviteLink);
        await op.waitForLoadState("networkidle").catch(() => {});
        await expect(op.getByRole("heading", { name: "This invite does not work" })).toBeVisible();
        c.check("/invite with a used link explains it and offers the dashboard", await op.getByRole("link", { name: "Open the dashboard" }).isVisible());
        await ocx.close();
      });

      c.check("no console errors anywhere in the run", consoleErrors.length === 0, consoleErrors.slice(0, 20));
      c.check("no failed API requests anywhere in the run", failedRequests.length === 0, failedRequests.slice(0, 20));
    } finally {
      ctx.capture.handlers.splice(ctx.capture.handlers.indexOf(slack), 1);
      await browser.close();
    }
  },
};
export default journey;
