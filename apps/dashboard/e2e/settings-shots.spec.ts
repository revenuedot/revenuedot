/**
 * Screenshots of the Project settings tabs and the Auth page on the e2e seed (prd/project-settings, prd/auth), 1440×900,
 * light, plus General and Auth in dark. Compared with RevenueCat's frames 28 (Project Settings) and 30 (Auth). Skipped
 * unless SHOTS is set; it changes the demo project, so run it alone on a fresh server:
 *   cd apps/dashboard && npx vite build && SHOTS=../../docs/assets/settings E2E_PORT=5411 npx playwright test -c e2e/playwright.config.ts e2e/settings-shots
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, type Page } from "@playwright/test";

async function json<T = any>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

test("settings and auth screenshots (SHOTS=<dir>)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=<dir> to save screenshots");
  test.setTimeout(120_000);
  const dir = resolve(process.cwd(), process.env.SHOTS!);
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const shot = async (name: string, path: string) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}.png` });
  };
  await json(page, "POST", "/auth/login", { email: "e2e@revenuedot.test", password: "e2e-password-1" });
  const pid = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  const P = `/v2/projects/${pid}`;

  // Realistic settings on the demo project.
  await json(page, "POST", P, { sandbox_testing_access: "allowlist", sandbox_testers: ["qa_alice", "qa_bob", "$RCAnonymousID:9f3c1a"] });
  await json(page, "POST", `${P}/brand`, {
    color_presets: [
      { key: "ink", name: "Ink", light: "#0A0A0A", dark: "#FAFAFA" }, { key: "gold", name: "Brand gold", light: "#F7B500" },
      { key: "paper", name: "Paper", light: "#FFFFFF", dark: "#111111" }, { key: "sage", name: "Sage", light: "#5F822B", dark: "#9BC75A" },
      { key: "rust", name: "Rust", light: "#C2410C" },
    ],
    gradient_presets: [
      { key: "sunrise", name: "Sunrise", type: "linear", degrees: 135, points: [{ color: "#F7B500", percent: 0 }, { color: "#C2410C", percent: 100 }] },
      { key: "night", name: "Night", type: "radial", points: [{ color: "#262626", percent: 0 }, { color: "#0A0A0A", percent: 100 }] },
    ],
  });
  const customers = (await json(page, "GET", `${P}/customers?limit=3`)).items as { id: string }[];
  for (const [i, c] of customers.slice(0, 2).entries()) await json(page, "POST", `${P}/blocked_customers`, { app_user_id: c.id, note: i ? "Shared account" : "Chargeback abuse" }).catch(() => null);
  await json(page, "POST", `${P}/blocked_customers`, { app_user_id: "fraud_device_4471", note: "Jailbroken receipts" });
  await json(page, "POST", `${P}/verified_metrics/actions/publish`, {
    slug: "scanner", display_name: "Scanner",
    metrics: [{ id: "mrr", visible: true }, { id: "revenue", visible: true }, { id: "active_subscriptions", visible: true }, { id: "active_trials", visible: true }, { id: "new_customers", visible: false }, { id: "active_users", visible: false }],
  });
  await json(page, "POST", `${P}/auth/settings`, { enabled: true, allow_anonymous: false });
  const providers = (await json(page, "GET", `${P}/auth/providers`)).items as unknown[];
  if (!providers.length) {
    await json(page, "POST", `${P}/auth/providers`, { kind: "firebase", firebase_project_id: "scanner-1a2b3", app_user_id_prefix: "" });
    await json(page, "POST", `${P}/auth/providers`, { kind: "oidc", name: "Auth0", issuer: "https://scanner.eu.auth0.com/", audiences: ["sBk2x9Lq0aZ"], app_user_id_claim: "sub", app_user_id_prefix: "auth0:" });
  }

  await shot("settings-general", `/projects/${pid}/settings/general`);
  await shot("settings-brand", `/projects/${pid}/settings/brand`);
  await shot("settings-blocked-customers", `/projects/${pid}/settings/blocked-customers`);
  await shot("settings-verified-metrics", `/projects/${pid}/settings/verified-metrics`);
  await shot("verified-page", `/verified/scanner`);
  const og = await page.request.get(`/verified/scanner/og.png`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${dir}/verified-og.png`, await og.body());
  await shot("auth", `/projects/${pid}/auth`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("settings-general-dark", `/projects/${pid}/settings/general`);
  await shot("auth-dark", `/projects/${pid}/auth`);
  await shot("verified-page-dark", `/verified/scanner`);
});
