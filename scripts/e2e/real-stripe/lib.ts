// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: shared helpers for the real Stripe test-mode runs (store.ts, billing.ts): a Stripe REST client that refuses
// any key that is not a test key, a real Node server on its own Railway development database, a developer sign-up, and
// the Stripe CLI forwarding real webhook events to the server. No fakes: Stripe is called for real, in test mode only.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createDatabase, dropDatabase, hideUrls, postgres, ROOT, startSmtpSink, type Mail } from "../journeys/lib/stack.ts";

export { until, sleep, Checks } from "../journeys/lib/check.ts";
export { createDatabase, dropDatabase, postgres, ROOT };

/** Refuses anything that is not a Stripe test-mode key. */
export function testKey(name: string): string {
  const k = process.env[name] ?? "";
  if (!/^(sk|rk)_test_/.test(k)) throw new Error(`${name} must be set to a Stripe TEST key (sk_test_ or rk_test_); refusing to run`);
  return k;
}

const flat = (o: unknown, prefix = "", out: [string, string][] = []): [string, string][] => {
  if (o === undefined || o === null) return out;
  if (Array.isArray(o)) o.forEach((v, i) => flat(v, `${prefix}[${i}]`, out));
  else if (typeof o === "object") for (const [k, v] of Object.entries(o)) flat(v, prefix ? `${prefix}[${k}]` : k, out);
  else out.push([prefix, String(o)]);
  return out;
};

export class StripeError extends Error { constructor(readonly status: number, readonly body: any, msg: string) { super(msg); } }

/** Stripe REST with a test key: `api("POST", "/v1/customers", { email })`. Throws StripeError on non-2xx. */
export function stripeApi(key: string, headers: Record<string, string> = {}) {
  return async <T = any>(method: string, path: string, params?: unknown): Promise<T> => {
    if (!/^(sk|rk)_test_/.test(key)) throw new Error("not a test key");
    const body = new URLSearchParams(flat(params));
    const url = `https://api.stripe.com${path}${method === "GET" && body.size ? `?${body}` : ""}`;
    const res = await fetch(url, { method, headers: { authorization: `Bearer ${key}`, ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers }, body: method === "GET" ? undefined : body });
    const json: any = await res.json();
    if (!res.ok) throw new StripeError(res.status, json, `${method} ${path}: ${res.status} ${json?.error?.message ?? ""}`);
    return json;
  };
}

export interface Stack {
  base: string; databaseUrl: string; mails: Mail[]; sql: ReturnType<typeof postgres>; logFile: string;
  stop: () => Promise<void>; restart: (env?: Record<string, string>) => Promise<void>;
}

/** A real Node server on a fresh database `name` of the Railway development Postgres, plus an SMTP sink. */
export async function startStack(name: string, port: number, env: Record<string, string> = {}): Promise<Stack> {
  const databaseUrl = await createDatabase(name);
  const smtp = await startSmtpSink(port + 1);
  const base = `http://localhost:${port}`;
  const logDir = join(ROOT, "scripts/e2e/real-stripe/build");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${name}.log`);
  const signingKey = randomBytes(32).toString("base64"), encryptionKey = randomBytes(32).toString("base64");
  let child: ChildProcess | undefined;
  const launch = async (extra: Record<string, string>) => {
    const fd = openSync(logFile, "a");
    child = spawn(process.execPath, ["--import", join(ROOT, "node_modules/tsx/dist/loader.mjs"), join(ROOT, "apps/server/src/entry.node.ts")], {
      cwd: join(ROOT, "apps/server"), stdio: ["ignore", fd, fd], detached: true,
      env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, REVENUEDOT_ALLOW_SIGNUP: "true", REVENUEDOT_SMTP_URL: `smtp://127.0.0.1:${port + 1}`, REVENUEDOT_MAIL_FROM: "RevenueDot <no-reply@real-stripe.test>", REVENUEDOT_PUBLIC_URL: base, REVENUEDOT_API_URL: base, REVENUEDOT_SIGNING_KEY: signingKey, REVENUEDOT_ENCRYPTION_KEY: encryptionKey, DASHBOARD_DIST: join(ROOT, "apps/dashboard/dist"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...env, ...extra },
    });
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(`${base}/v1/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server did not start:\n${hideUrls(readFileSync(logFile, "utf8")).slice(-3000)}`);
  };
  const kill = () => { if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } } };
  await launch({});
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  return {
    base, databaseUrl, mails: smtp.mails, sql, logFile,
    restart: async (extra = {}) => { kill(); await new Promise((r) => setTimeout(r, 1000)); await launch(extra); },
    stop: async () => { kill(); await sql.end(); await smtp.close(); await dropDatabase(name); },
  };
}

export interface Dev { email: string; cookie: string; projectId: string; call: (m: string, p: string, j?: unknown, h?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>; v2: (m: string, p: string, j?: unknown) => Promise<any>; v2r: (m: string, p: string, j?: unknown) => Promise<{ status: number; body: any }> }

export async function signUp(base: string, who: string): Promise<Dev> {
  const email = `${who}-${Date.now()}@real-stripe.test`;
  const r = await fetch(`${base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: `real-${randomBytes(8).toString("hex")}`, name: who, project_name: `${who} app` }) });
  if (r.status !== 201) throw new Error(`sign-up: ${r.status} ${await r.text()}`);
  const cookie = `rd_session=${/rd_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1]}`;
  const call: Dev["call"] = async (method, path, json, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...headers, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json === undefined ? undefined : JSON.stringify(json), redirect: "manual" });
    const t = await res.text(); let body: any = t; try { body = t ? JSON.parse(t) : null; } catch { /* text */ }
    return { status: res.status, body, headers: res.headers };
  };
  const projectId = (await call("GET", "/auth/me")).body.projects[0].id as string;
  const P = `/v2/projects/${projectId}`;
  const v2r = (m: string, p: string, j?: unknown) => call(m, P + p, j);
  const v2 = async (m: string, p: string, j?: unknown) => { const x = await v2r(m, p, j); if (x.status >= 300) throw new Error(`${m} ${P}${p} → ${x.status}: ${JSON.stringify(x.body).slice(0, 400)}`); return x.body; };
  return { email, cookie, projectId, call, v2, v2r };
}

/** The Stripe CLI forwarding every event of the account (the key's) to `url`; returns the signing secret it uses. */
export function listenSecret(key: string): string {
  const out = execFileSync("stripe", ["listen", "--print-secret"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, STRIPE_API_KEY: key } });
  const m = /whsec_[A-Za-z0-9]+/.exec(out);
  if (!m) throw new Error("stripe listen --print-secret gave no secret");
  return m[0];
}
export function forward(key: string, url: string): { stop: () => void; ready: Promise<void> } {
  const p = spawn("stripe", ["listen", "--forward-to", url], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STRIPE_API_KEY: key } });
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("stripe listen not ready")), 30_000);
    const on = (b: Buffer) => { if (/Ready!/.test(b.toString())) { clearTimeout(t); resolve(); } };
    p.stdout!.on("data", on); p.stderr!.on("data", on);
  });
  return { stop: () => p.kill("SIGTERM"), ready };
}

/** Pays a Stripe-hosted Checkout page with a test card in a real browser. `card` defaults to 4242 4242 4242 4242. */
export async function payCheckout(url: string, o: { email: string; card?: string; expectUrl?: RegExp }): Promise<{ finalUrl: string; error?: string }> {
  const chromium = (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByText("Payment method", { exact: true }).first().waitFor({ timeout: 45_000 });
    const email = page.locator("#email");
    if (await email.count() && await email.isEditable()) await email.fill(o.email);
    const save = page.locator("#enableStripePass");
    if (await save.count() && await save.isChecked()) await save.uncheck();
    await page.locator("#cardNumber").waitFor({ timeout: 8000 }).catch(async () => { const b = await page.locator("#payment-method-label-card").boundingBox(); if (b) await page.mouse.click(b.x + b.width / 2 + 60, b.y + b.height / 2); });
    await page.locator("#cardNumber").waitFor({ timeout: 30_000 });
    await page.locator("#cardNumber").fill(o.card ?? "4242424242424242");
    await page.locator("#cardExpiry").fill("12 / 34");
    await page.locator("#cardCvc").fill("123");
    const name = page.locator("#billingName");
    if (await name.count()) await name.fill("Real Stripe Test");
    const zip = page.locator("#billingPostalCode");
    if (await zip.count()) await zip.fill("94107");
    await page.locator("button.SubmitButton, button[type=submit]").first().click();
    const end = o.expectUrl ?? /real-stripe\.test|localhost/;
    try { await page.waitForURL(end, { timeout: 60_000 }); } catch { /* declined or still on the page */ }
    const err = await page.locator(".FieldError, .ConfirmPayment-Error, [role=alert]").first().innerText({ timeout: 2000 }).catch(() => undefined);
    return { finalUrl: page.url(), error: err };
  } finally { await browser.close(); }
}

/** Removes what a run made in the Stripe sandbox (everything created after `since`, in seconds): clocks and customers (their
 *  subscriptions go with them), coupons, promotion codes switched off, products and prices archived. Test mode only. */
export async function cleanupStripe(S: ReturnType<typeof stripeApi>, since: number): Promise<string> {
  const counts: Record<string, number> = {};
  const each = async (path: string, params: Record<string, unknown>, fn: (o: any) => Promise<unknown>, kind: string) => {
    for (let i = 0; i < 20; i++) {
      const page = await S("GET", path, { limit: 100, created: { gte: since }, ...params }).catch(() => ({ data: [] }));
      if (!page.data?.length) return;
      for (const o of page.data) { await fn(o).catch(() => null); counts[kind] = (counts[kind] ?? 0) + 1; }
      if (!page.has_more) return;
    }
  };
  const clocks = (await S("GET", "/v1/test_helpers/test_clocks", { limit: 100 }).catch(() => ({ data: [] }))).data.filter((k: any) => k.created >= since);
  for (const k of clocks) { await S("DELETE", `/v1/test_helpers/test_clocks/${k.id}`).catch(() => null); counts.clocks = (counts.clocks ?? 0) + 1; }
  await each("/v1/promotion_codes", { active: true }, (o) => S("POST", `/v1/promotion_codes/${o.id}`, { active: false }), "promotion codes");
  await each("/v1/coupons", {}, (o) => S("DELETE", `/v1/coupons/${o.id}`), "coupons");
  await each("/v1/customers", {}, (o) => S("DELETE", `/v1/customers/${o.id}`), "customers");
  await each("/v1/prices", { active: true }, (o) => S("POST", `/v1/prices/${o.id}`, { active: false }), "prices");
  await each("/v1/products", { active: true }, (o) => S("POST", `/v1/products/${o.id}`, { active: false }), "products");
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing";
}
